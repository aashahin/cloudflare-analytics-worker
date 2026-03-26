// ─── Manhali Analytics Worker — Entrypoint ───────────────────────────────────
// Edge-native analytics engine: privacy-first Google Analytics alternative.
//
// Data flow:
//   1. Ingestion: writeDataPoint() → Analytics Engine (90-day retention)
//   2. Live queries: SQL API → Analytics Engine
//   3. No D1 — Analytics Engine is the sole data store.

import type { Env } from "@/env.ts";
import { verifyAuth } from "@/lib/auth.ts";
import {
  badRequest,
  forbidden,
  handleCors,
  privateJsonResponse,
  publicCorsHeaders,
  publicJsonResponse,
  unauthorized,
} from "@/lib/cors.ts";
import { trackEvent } from "@/lib/ingest.ts";
import {
  getCustomEvents,
  getDeviceBreakdown,
  getGeoBreakdown,
  getOverview,
  getRealtime,
  getTopPages,
  getTopReferrers,
} from "@/lib/query.ts";
import { EVENT_TYPES } from "@/lib/schema.ts";
import { type CollectPayload, resolveTenant } from "@/lib/tenant.ts";
import { safeInt, sanitizePath } from "@/lib/utils.ts";
import { handleAdminRoutes } from "@/routes/admin.ts";
import { getTrackerHeaders, getTrackerScript } from "@/tracker/script.ts";

// ─── Worker Export ───────────────────────────────────────────────────────────

export default {
  // ─── HTTP Handler ────────────────────────────────────────────────────────

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") return handleCors(request);

    // ── Public Routes ──────────────────────────────────────────────────────

    // Health check
    if (pathname === "/health") {
      return publicJsonResponse({ status: "ok", service: "manhali-analytics" });
    }

    // Tracker script — parameterized with collect endpoint and optional site ID
    if (pathname === "/tracker.js" && method === "GET") {
      const siteId = url.searchParams.get("sid") ?? "";
      const script = getTrackerScript(`${url.origin}/api/collect`, siteId);
      return new Response(script, { headers: getTrackerHeaders() });
    }

    // Event collection (no auth — called by tracker script from browsers)
    if (pathname === "/api/collect" && method === "POST") {
      return handleCollect(request, env, ctx);
    }

    // ── Authenticated API Routes ───────────────────────────────────────────

    const auth = await verifyAuth(request, env);
    if (!auth.authenticated) return unauthorized(request);

    try {
      // ── Admin Routes (require admin token, not scoped tokens) ──────────────

      if (pathname.startsWith("/api/admin/")) {
        if (auth.tenantScope) {
          return forbidden(request, "Admin access requires an admin token");
        }
        return handleAdminRoutes(request, env, url, method);
      }

      // ── Analytics Query Routes ─────────────────────────────────────────────

      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId && pathname.startsWith("/api/")) {
        return badRequest(request, "Missing tenant_id query parameter");
      }

      // Enforce tenant scope — scoped tokens can only query their own tenant
      if (auth.tenantScope && tenantId !== auth.tenantScope) {
        return forbidden(request, "Token not authorized for this tenant");
      }

      const days = safeInt(url.searchParams.get("days"), 30, 1, 90);
      const limit = safeInt(url.searchParams.get("limit"), 20, 1, 100);

      switch (pathname) {
        case "/api/overview":
          return privateJsonResponse(
            request,
            await getOverview(env, tenantId!, days),
          );

        case "/api/pages":
          return privateJsonResponse(
            request,
            await getTopPages(env, tenantId!, days, limit),
          );

        case "/api/referrers":
          return privateJsonResponse(
            request,
            await getTopReferrers(env, tenantId!, days, limit),
          );

        case "/api/geo":
          return privateJsonResponse(
            request,
            await getGeoBreakdown(env, tenantId!, days),
          );

        case "/api/devices":
          return privateJsonResponse(
            request,
            await getDeviceBreakdown(env, tenantId!, days),
          );

        case "/api/realtime":
          return privateJsonResponse(
            request,
            await getRealtime(env, tenantId!),
          );

        case "/api/events":
          return privateJsonResponse(
            request,
            await getCustomEvents(env, tenantId!, days, limit),
          );

        default:
          return privateJsonResponse(request, { error: "Not Found" }, 404);
      }
    } catch (error) {
      console.error(`[API] Error on ${pathname}:`, error);
      return privateJsonResponse(
        request,
        {
          error: "Internal server error",
          ...(env.ENVIRONMENT === "development" && {
            message: error instanceof Error ? error.message : "Unknown error",
          }),
        },
        500,
      );
    }
  },
};

// ─── Collect Handler ─────────────────────────────────────────────────────────

async function handleCollect(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Guard against oversized payloads (64 KB limit for analytics)
  // Read as text first — content-length may be absent (chunked encoding, sendBeacon)
  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return publicJsonResponse({ error: "Failed to read body" }, 400);
  }
  if (rawText.length > 65_536) {
    return publicJsonResponse({ error: "Payload too large" }, 413);
  }

  let body: CollectPayload;
  try {
    body = JSON.parse(rawText) as CollectPayload;
  } catch {
    return publicJsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.t || !body.p) {
    return publicJsonResponse(
      { error: "Missing required fields: t (type), p (path)" },
      400,
    );
  }

  // ─── Tenant Resolution ───────────────────────────────────────────────────
  const { tenantId, error } = await resolveTenant(request, env, body);
  if (!tenantId) {
    return publicJsonResponse(
      { error: error ?? "Cannot determine tenant" },
      400,
    );
  }

  // Map event type
  const eventType =
    body.t === "beacon"
      ? EVENT_TYPES.BEACON
      : body.t === "event"
        ? EVENT_TYPES.EVENT
        : EVENT_TYPES.PAGEVIEW;

  // Sanitize inputs before ingestion
  const timeOnPage = Math.max(0, Math.min(body.d ?? 0, 3600)); // Clamp 0-3600s
  const eventName = (body.en ?? "")
    .replace(/[^a-zA-Z0-9_\-. ]/g, "")
    .slice(0, 100);

  // trackEvent is async due to the SHA-256 visitor hash computation.
  // writeDataPoint() inside is fire-and-forget (no await needed for AE write).
  // Accept country/city overrides only on authenticated server-to-server requests
  // (those use body.tid + Bearer auth — verifyIngestAuth in resolveTenant).
  // Validate country is a plausible 2-letter ISO code.
  const isS2S = !!(
    body.tid && request.headers.get("Authorization")?.startsWith("Bearer ")
  );
  const countryOverride =
    isS2S && body.co && /^[A-Z]{2}$/.test(body.co) ? body.co : undefined;
  const cityOverride = isS2S && body.ci ? body.ci.slice(0, 100) : undefined;

  await trackEvent(request, env, {
    tenantId,
    pagePath: sanitizePath(body.p),
    eventType,
    eventName,
    timeOnPage,
    referrer: body.r ?? "",
    utmSource: body.us ?? "",
    utmMedium: body.um ?? "",
    utmCampaign: body.uc ?? "",
    countryOverride,
    cityOverride,
  });

  // 204 No Content — minimal response for tracker
  return new Response(null, { status: 204, headers: publicCorsHeaders() });
}
