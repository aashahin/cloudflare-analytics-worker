// ─── Admin API Routes ────────────────────────────────────────────────────────
// Handles all /api/admin/* routes. Requires admin token (not scoped tokens).
// Includes domain management and token generation.

import type { Env } from "@/env.ts";
import { createScopedToken } from "@/lib/auth.ts";
import { badRequest, privateJsonResponse } from "@/lib/cors.ts";
import { getDomainKV, invalidateDomainCache } from "@/lib/tenant.ts";
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
  if (pathname === "/api/admin/token" && method === "POST") {
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

async function handleAdminDomains(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const tenantId = url.searchParams.get("tenant_id");
  if (!tenantId || !SAFE_TENANT_ID.test(tenantId)) {
    return badRequest(request, "Missing or invalid tenant_id");
  }

  const kv = getDomainKV(env);
  const key = `domains:${tenantId}`;

  switch (request.method) {
    case "GET": {
      const raw = await kv.get(key);
      const domains: string[] = raw ? JSON.parse(raw) : [];
      return privateJsonResponse(request, { tenantId, domains });
    }

    case "POST": {
      let body: { domain: string };
      try {
        body = (await request.json()) as { domain: string };
      } catch {
        return badRequest(request, "Invalid JSON body");
      }
      if (
        !body.domain ||
        !VALID_HOSTNAME.test(body.domain) ||
        body.domain.length > 253
      ) {
        return badRequest(request, "Missing or invalid domain hostname");
      }
      const raw = await kv.get(key);
      const domains: string[] = raw ? JSON.parse(raw) : [];
      if (!domains.includes(body.domain)) {
        domains.push(body.domain);
      }
      await kv.put(key, JSON.stringify(domains));
      invalidateDomainCache(tenantId);
      return privateJsonResponse(request, { tenantId, domains });
    }

    case "DELETE": {
      let body: { domain: string };
      try {
        body = (await request.json()) as { domain: string };
      } catch {
        return badRequest(request, "Invalid JSON body");
      }
      if (!body.domain) return badRequest(request, "Missing domain");
      const raw = await kv.get(key);
      let domains: string[] = raw ? JSON.parse(raw) : [];
      domains = domains.filter((d) => d !== body.domain);
      await kv.put(key, JSON.stringify(domains));
      invalidateDomainCache(tenantId);
      return privateJsonResponse(request, { tenantId, domains });
    }

    default:
      return privateJsonResponse(request, { error: "Method not allowed" }, 405);
  }
}
