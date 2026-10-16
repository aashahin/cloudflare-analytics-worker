// ─── Admin API Routes ────────────────────────────────────────────────────────
// Handles all /api/admin/* routes. Requires admin token (not scoped tokens).
// Includes domain management and token generation.

import type { Env } from "@/env.ts";
import { createScopedToken } from "@/lib/auth.ts";
import {
  badRequest,
  methodNotAllowed,
  privateCorsHeaders,
  privateJsonResponse,
} from "@/lib/cors.ts";
import {
  getDomainKV,
  invalidateDomainCache,
  normalizeHostname,
  parseDomainList,
} from "@/lib/tenant.ts";
import { SAFE_TENANT_ID, safeInt } from "@/lib/utils.ts";

/** Pattern for valid hostnames */
const VALID_HOSTNAME =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

// ─── Admin Routes Handler ────────────────────────────────────────────────────

export async function handleAdminRoutes(
  request: Request,
  env: Env,
  url: URL,
  method: string,
): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/api/admin/domains") {
    return handleAdminDomains(request, env, url);
  }

  // Generate a tenant-scoped HMAC token (no KV lookup needed for verification)
  if (pathname === "/api/admin/token") {
    if (method !== "POST") {
      return methodNotAllowed(privateCorsHeaders(request), "POST");
    }

    let body: { tenant_id: string; ttl?: number };
    try {
      body = (await request.json()) as { tenant_id: string; ttl?: number };
    } catch {
      return badRequest(request, "Invalid JSON body");
    }
    if (!body.tenant_id) return badRequest(request, "Missing tenant_id");
    if (!SAFE_TENANT_ID.test(body.tenant_id)) {
      return badRequest(request, "Invalid tenant_id format");
    }
    const ttl = safeInt(String(body.ttl ?? 86400), 86400, 60, 2_592_000);
    const token = await createScopedToken(env.AUTH_TOKEN, body.tenant_id, ttl);
    return privateJsonResponse(request, {
      token,
      tenant_id: body.tenant_id,
      expires_in: ttl,
    });
  }

  return privateJsonResponse(request, { error: "Not Found" }, 404);
}

// ─── Admin: Domain Management ────────────────────────────────────────────────
// Manage allowed domains per tenant. Used by the backend to register tenant
// domains for origin validation on the collect endpoint.
//
// KV structure: `domains:{tenantId}` → JSON array of allowed hostnames
//   e.g. `domains:tenant_123` → `["example.com", "www.example.com"]`
// An empty array is an explicit deny-all registration, not an unregistered site.

async function handleAdminDomains(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId || !SAFE_TENANT_ID.test(tenantId)) {
    return badRequest(request, "Missing or invalid tenant_id");
  }

  switch (request.method) {
    case "GET": {
      const raw = await getDomainKV(env).get(domainKey(tenantId));
      const domains = parseDomainList(raw) ?? [];
      return privateJsonResponse(request, { tenantId, domains });
    }

    case "POST": {
      const parsed = await readDomainBody(request);
      if ("error" in parsed) return badRequest(request, parsed.error);

      const domain = parsed.domain;
      const domains = await mutateDomainList(env, tenantId, (current) =>
        current.includes(domain) ? current : [...current, domain],
      );
      invalidateDomainCache(tenantId);
      return privateJsonResponse(request, { tenantId, domains });
    }

    case "DELETE": {
      const parsed = await readDomainBody(request);
      if ("error" in parsed) return badRequest(request, parsed.error);

      const domain = parsed.domain;
      const domains = await mutateDomainList(env, tenantId, (current) =>
        current.filter((entry) => entry !== domain),
      );
      invalidateDomainCache(tenantId);
      return privateJsonResponse(request, { tenantId, domains });
    }

    default:
      return methodNotAllowed(
        privateCorsHeaders(request),
        "GET, POST, DELETE",
      );
  }
}

function domainKey(tenantId: string): string {
  return `domains:${tenantId}`;
}

/**
 * Read-modify-write the tenant's allowlist. Callers describe only the merge;
 * the read, the write and the per-tenant serialization live here so both
 * mutations keep identical concurrency behavior.
 */
async function mutateDomainList(
  env: Env,
  tenantId: string,
  merge: (domains: readonly string[]) => readonly string[],
): Promise<readonly string[]> {
  return withDomainWriteLock(tenantId, async () => {
    const key = domainKey(tenantId);
    const kv = getDomainKV(env);
    const current = parseDomainList(await kv.get(key)) ?? [];
    const next = merge(current);
    await kv.put(key, JSON.stringify(next));
    return next;
  });
}

/** Parse and validate `{ domain }`. Returns the hostname or an error message. */
async function readDomainBody(
  request: Request,
): Promise<{ domain: string } | { error: string }> {
  let body: { domain: string };
  try {
    body = (await request.json()) as { domain: string };
  } catch {
    return { error: "Invalid JSON body" };
  }

  const domain = normalizeHostname(body.domain ?? "");
  if (!domain || !VALID_HOSTNAME.test(domain)) {
    return { error: "Missing or invalid domain hostname" };
  }
  return { domain };
}

// KV has no compare-and-swap, and Cloudflare documents that a write is only
// *usually* immediately visible even in the writing location, so concurrent
// writers can lose updates. Chaining writes per tenant serializes them within
// this isolate, which removes the common same-location race (two admins, a
// retry storm, backend sync + manual edit). A cross-location race remains; the
// architectural note in ANALYTICS_ARCHITECTURE.md documents the escalation
// path (Durable Object) if stronger guarantees are ever needed.
const domainWriteChains = new Map<string, Promise<unknown>>();

async function withDomainWriteLock<T>(
  tenantId: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = domainWriteChains.get(tenantId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  domainWriteChains.set(tenantId, current);
  try {
    return await current;
  } finally {
    if (domainWriteChains.get(tenantId) === current) {
      domainWriteChains.delete(tenantId);
    }
  }
}
