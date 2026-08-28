// ─── Tenant Resolution ───────────────────────────────────────────────────────
// Resolves tenant ID from collect payloads using domain allowlist + auth.

import type { Env } from "@/env.ts";
import { verifyIngestAuth } from "@/lib/auth.ts";
import { type EventType } from "@/lib/schema.ts";
import { extractHostname, SAFE_TENANT_ID } from "@/lib/utils.ts";

// ─── Collect Payload ─────────────────────────────────────────────────────────

export interface CollectPayload {
  /** Event type: pageview | beacon | event */
  t: EventType;
  /** Page path */
  p: string;
  /** Referrer URL (document.referrer from tracker) */
  r?: string;
  /** Duration in seconds (beacon only) */
  d?: number;
  /** Tenant ID (server-to-server with Bearer auth) */
  tid?: string;
  /** Site ID (from tracker script, used for tenant resolution) */
  sid?: string;
  /** Event name (for custom events) */
  en?: string;
  /** UTM source */
  us?: string;
  /** UTM medium */
  um?: string;
  /** UTM campaign */
  uc?: string;
  /** Country override — ISO 3166-1 alpha-2 (server-to-server only) */
  co?: string;
  /** City override (server-to-server only) */
  ci?: string;
}

// ─── Domain Allowlist Cache ──────────────────────────────────────────────────
// In-memory cache for KV domain lookups to avoid a KV read on every collect.
// Resets naturally when the Worker isolate is recycled (every few minutes).

const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DOMAIN_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DOMAIN_KV_CACHE_TTL_SECONDS = 60;
const DOMAIN_POSITIVE_CACHE_MAX_ENTRIES = 256;
const DOMAIN_NEGATIVE_CACHE_MAX_ENTRIES = 64;

interface PositiveCacheEntry {
  domains: string[];
  expiresAt: number;
}

interface NegativeCacheEntry {
  expiresAt: number;
}

const positiveDomainCache = new Map<string, PositiveCacheEntry>();
const negativeDomainCache = new Map<string, NegativeCacheEntry>();

/** Get the KV namespace for domain allowlist */
export function getDomainKV(env: Env): KVNamespace {
  return env.DOMAINS_KV;
}

async function getCachedDomains(
  env: Env,
  siteId: string,
): Promise<string[] | null> {
  const now = Date.now();
  const positive = positiveDomainCache.get(siteId);
  if (positive && positive.expiresAt > now) {
    // Refresh insertion order so overflow evicts the least recently used site.
    positiveDomainCache.delete(siteId);
    positiveDomainCache.set(siteId, positive);
    return positive.domains;
  }
  if (positive) positiveDomainCache.delete(siteId);

  const negative = negativeDomainCache.get(siteId);
  if (negative && negative.expiresAt > now) {
    negativeDomainCache.delete(siteId);
    negativeDomainCache.set(siteId, negative);
    return null;
  }
  if (negative) negativeDomainCache.delete(siteId);

  const raw = await getDomainKV(env).get(`domains:${siteId}`, {
    type: "text",
    cacheTtl: DOMAIN_KV_CACHE_TTL_SECONDS,
  });
  const domains = parseDomainList(raw);
  if (domains) {
    negativeDomainCache.delete(siteId);
    pruneOldest(
      positiveDomainCache,
      DOMAIN_POSITIVE_CACHE_MAX_ENTRIES,
    );
    positiveDomainCache.set(siteId, {
      domains,
      expiresAt: now + DOMAIN_CACHE_TTL_MS,
    });
    return domains;
  }

  positiveDomainCache.delete(siteId);
  pruneOldest(negativeDomainCache, DOMAIN_NEGATIVE_CACHE_MAX_ENTRIES);
  negativeDomainCache.set(siteId, {
    expiresAt: now + DOMAIN_NEGATIVE_CACHE_TTL_MS,
  });
  return null;
}

function pruneOldest<T>(cache: Map<string, T>, maxEntries: number): void {
  while (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (!oldest) return;
    cache.delete(oldest);
  }
}

export function parseDomainList(raw: string | null): string[] | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((domain) => typeof domain === "string")
    ) {
      const normalized = parsed.map((domain) => normalizeHostname(domain));
      if (normalized.every((domain) => domain !== null)) {
        return [...new Set(normalized)];
      }
    }
  } catch {
    // Treat malformed KV values as unregistered domains.
  }

  return null;
}

export function normalizeHostname(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253) return null;
  return normalized;
}

/** Invalidate cached domains for a tenant (call after admin add/remove). */
export function invalidateDomainCache(siteId: string): void {
  positiveDomainCache.delete(siteId);
  negativeDomainCache.delete(siteId);
}

export function clearDomainCacheForTests(): void {
  positiveDomainCache.clear();
  negativeDomainCache.clear();
}

export function getDomainCacheSizeForTests(): number {
  return positiveDomainCache.size + negativeDomainCache.size;
}

export function getDomainCacheSizesForTests(): {
  positive: number;
  negative: number;
} {
  return {
    positive: positiveDomainCache.size,
    negative: negativeDomainCache.size,
  };
}

// ─── Tenant Resolution ──────────────────────────────────────────────────────

/**
 * Resolve the tenant ID from the collect payload.
 *
 * Priority:
 *   1. Server-to-server with valid Bearer token → trust body.tid
 *   2. Client tracker with site ID → validate origin against domain allowlist
 *   3. Development fallback → extract from Origin hostname
 */
export async function resolveTenant(
  request: Request,
  env: Env,
  body: CollectPayload,
  options: { ingestAuthenticated?: boolean } = {},
): Promise<{
  tenantId: string | null;
  error?: string;
  isServerToServer: boolean;
}> {
  // Server-to-server with Bearer auth — trust body.tid (uses INGEST_TOKEN if set)
  if (
    body.tid &&
    (options.ingestAuthenticated ?? (await verifyIngestAuth(request, env)))
  ) {
    if (!SAFE_TENANT_ID.test(body.tid)) {
      return {
        tenantId: null,
        error: "Invalid tenant ID format",
        isServerToServer: false,
      };
    }
    return { tenantId: body.tid, isServerToServer: true };
  }

  // Client tracker with site ID
  const siteId = body.sid;
  const originHost =
    extractHostname(request.headers.get("Origin")) ??
    extractHostname(request.headers.get("Referer"));
  const normalizedOriginHost = originHost ? normalizeHostname(originHost) : null;

  if (siteId) {
    // Validate format before any KV lookup to avoid wasted reads on garbage input
    if (!SAFE_TENANT_ID.test(siteId)) {
      return {
        tenantId: null,
        error: "Invalid site ID format",
        isServerToServer: false,
      };
    }
    // In production, validate origin against allowed domains for this tenant
    if (env.ENVIRONMENT !== "development") {
      const domains = await getCachedDomains(env, siteId);
      if (domains) {
        if (!normalizedOriginHost || !domains.includes(normalizedOriginHost)) {
          return {
            tenantId: null,
            error: "Origin not allowed for this site",
            isServerToServer: false,
          };
        }
      } else if (env.ALLOW_UNREGISTERED_DOMAINS !== "true") {
        return {
          tenantId: null,
          error: "No domains registered for this site",
          isServerToServer: false,
        };
      }
    }
    return { tenantId: siteId, isServerToServer: false };
  }

  // Development fallback: extract tenant from Origin hostname
  if (env.ENVIRONMENT === "development" && originHost) {
    return { tenantId: originHost, isServerToServer: false };
  }

  return {
    tenantId: null,
    error: "Missing sid (site ID) in payload",
    isServerToServer: false,
  };
}
