// ─── Tenant Resolution ───────────────────────────────────────────────────────
// Resolves tenant ID from collect payloads using domain allowlist + auth.

import type { Env } from "@/env.ts";
import { verifyIngestAuth } from "@/lib/auth.ts";
import { extractHostname, SAFE_TENANT_ID } from "@/lib/utils.ts";

// ─── Collect Payload ─────────────────────────────────────────────────────────

export interface CollectPayload {
  /** Event type: pageview | beacon | event */
  t: string;
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

interface CacheEntry {
  domains: string[] | null; // null = no domains registered (grace period)
  expiresAt: number;
}

const domainCache = new Map<string, CacheEntry>();

/** Get the KV namespace for domain allowlist */
export function getDomainKV(env: Env): KVNamespace {
  return env.DOMAINS_KV;
}

async function getCachedDomains(
  env: Env,
  siteId: string,
): Promise<string[] | null> {
  const now = Date.now();
  const cached = domainCache.get(siteId);
  if (cached && cached.expiresAt > now) {
    return cached.domains;
  }

  const raw = await getDomainKV(env).get(`domains:${siteId}`);
  const domains: string[] | null = raw ? JSON.parse(raw) : null;
  domainCache.set(siteId, { domains, expiresAt: now + DOMAIN_CACHE_TTL_MS });
  return domains;
}

/** Invalidate cached domains for a tenant (call after admin add/remove). */
export function invalidateDomainCache(siteId: string): void {
  domainCache.delete(siteId);
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
): Promise<{ tenantId: string | null; error?: string }> {
  // Server-to-server with Bearer auth — trust body.tid (uses INGEST_TOKEN if set)
  if (body.tid && verifyIngestAuth(request, env)) {
    if (!SAFE_TENANT_ID.test(body.tid)) {
      return { tenantId: null, error: "Invalid tenant ID format" };
    }
    return { tenantId: body.tid };
  }

  // Client tracker with site ID
  const siteId = body.sid;
  const originHost =
    extractHostname(request.headers.get("Origin")) ??
    extractHostname(request.headers.get("Referer"));

  if (siteId) {
    // Validate format before any KV lookup to avoid wasted reads on garbage input
    if (!SAFE_TENANT_ID.test(siteId)) {
      return { tenantId: null, error: "Invalid site ID format" };
    }
    // In production, validate origin against allowed domains for this tenant
    if (env.ENVIRONMENT !== "development") {
      const domains = await getCachedDomains(env, siteId);
      if (domains) {
        if (!originHost || !domains.includes(originHost)) {
          return { tenantId: null, error: "Origin not allowed for this site" };
        }
      } else if (env.ALLOW_UNREGISTERED_DOMAINS !== "true") {
        console.warn(
          `[Tenant] No domains registered for site ${siteId}, rejecting. Set ALLOW_UNREGISTERED_DOMAINS=true to allow.`,
        );
        return {
          tenantId: null,
          error: "No domains registered for this site",
        };
      } else {
        console.warn(
          `[Tenant] Grace period: allowing unregistered site ${siteId}`,
        );
      }
    }
    return { tenantId: siteId };
  }

  // Development fallback: extract tenant from Origin hostname
  if (env.ENVIRONMENT === "development" && originHost) {
    return { tenantId: originHost };
  }

  return { tenantId: null, error: "Missing sid (site ID) in payload" };
}
