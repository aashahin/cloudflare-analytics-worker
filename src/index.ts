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
  getDashboardSections,
  getDeviceBreakdown,
  getGeoBreakdown,
  getOverview,
  getRealtime,
  getTopPages,
  getTopReferrers,
} from "@/lib/query.ts";
import { EVENT_TYPES } from "@/lib/schema.ts";
import { type CollectPayload, resolveTenant } from "@/lib/tenant.ts";
import { safeInt, SAFE_TENANT_ID, sanitizePath } from "@/lib/utils.ts";
import { handleAdminRoutes } from "@/routes/admin.ts";
import { getTrackerHeaders, getTrackerScript } from "@/tracker/script.ts";

const MAX_COLLECT_BODY_BYTES = 65_536;

// ─── Worker Export ───────────────────────────────────────────────────────────

export default {
  // ─── HTTP Handler ────────────────────────────────────────────────────────

  async fetch(
    request: Request,
    env: Env,
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
      return handleCollect(request, env);
    }

    // ── Authenticated API Routes ───────────────────────────────────────────

    try {
      const auth = await verifyAuth(request, env);
      if (!auth.authenticated) return unauthorized(request);

      // ── Admin Routes (require admin token, not scoped tokens) ──────────────

      if (pathname.startsWith("/api/admin/")) {
        if (auth.tenantScope) {
          return forbidden(request, "Admin access requires an admin token");
        }
        return handleAdminRoutes(request, env, url, method);
      }

      // ── Analytics Query Routes ─────────────────────────────────────────────

      const tenantId = url.searchParams.get("tenant_id");
      if (pathname.startsWith("/api/")) {
        if (!tenantId) {
          return badRequest(request, "Missing tenant_id query parameter");
        }
        // Validate format up front so a malformed ID yields a 400 rather than
        // a thrown 500 from validateTenantId deeper in the query layer.
        if (!SAFE_TENANT_ID.test(tenantId)) {
          return badRequest(request, "Invalid tenant_id format");
        }
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

        case "/api/sections":
          return privateJsonResponse(
            request,
            await getDashboardSections(env, tenantId!, days, limit),
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
): Promise<Response> {
  // Guard against oversized payloads (64 KB limit for analytics)
  let rawText: string;
  try {
    rawText = await readLimitedText(request, MAX_COLLECT_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return publicJsonResponse({ error: "Payload too large" }, 413);
    }
    return publicJsonResponse({ error: "Failed to read body" }, 400);
  }

  let body: CollectPayload;
  try {
    body = parseCollectPayload(rawText);
  } catch (error) {
    return publicJsonResponse(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      400,
    );
  }

  // resolveTenant reads KV (which can fail transiently) and trackEvent runs the
  // hash + write; wrap both so a throw returns a CORS-bearing 500 rather than
  // escaping fetch() as a bare 500 with no Access-Control-Allow-Origin header.
  try {
    // ─── Tenant Resolution ─────────────────────────────────────────────────
    const { tenantId, error, isServerToServer } = await resolveTenant(
      request,
      env,
      body,
    );
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

    // Bound UTM fields. Unlike eventName/pagePath/city they are otherwise
    // written verbatim to blobs 8/9/10; an oversized value (the body cap is
    // 64 KB, far above AE's 16 KB per-data-point blob budget) would silently
    // drop the entire data point, and unbounded values bloat GROUP BY
    // cardinality in getTopReferrers.
    const utmSource = (body.us ?? "").slice(0, 200);
    const utmMedium = (body.um ?? "").slice(0, 200);
    const utmCampaign = (body.uc ?? "").slice(0, 200);

    // trackEvent is async due to the SHA-256 visitor hash computation.
    // writeDataPoint() inside is fire-and-forget (no await needed for AE write).
    // Accept country/city overrides only on authenticated server-to-server
    // requests (those use body.tid + Bearer auth — verifyIngestAuth in
    // resolveTenant). Validate country is a plausible 2-letter ISO code.
    const countryOverride =
      isServerToServer && body.co && /^[A-Z]{2}$/.test(body.co)
        ? body.co
        : undefined;
    const cityOverride =
      isServerToServer && body.ci ? body.ci.slice(0, 100) : undefined;

    await trackEvent(request, env, {
      tenantId,
      pagePath: sanitizePath(body.p),
      eventType,
      eventName,
      timeOnPage,
      referrer: body.r ?? "",
      utmSource,
      utmMedium,
      utmCampaign,
      countryOverride,
      cityOverride,
    });

    // 204 No Content — minimal response for tracker
    return new Response(null, { status: 204, headers: publicCorsHeaders() });
  } catch (error) {
    console.error("[Collect] Error:", error);
    return publicJsonResponse({ error: "Internal server error" }, 500);
  }
}

class PayloadTooLargeError extends Error {}

async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new PayloadTooLargeError("Payload too large");
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError("Payload too large");
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function parseCollectPayload(rawText: string): CollectPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error("Invalid JSON");
  }

  if (!isRecord(raw)) {
    throw new Error("Invalid JSON body");
  }

  if (!isEventType(raw.t)) {
    throw new Error("Invalid or missing t (type)");
  }

  if (typeof raw.p !== "string" || raw.p.length === 0) {
    throw new Error("Missing required field: p (path)");
  }

  const duration =
    typeof raw.d === "number" && Number.isFinite(raw.d) ? raw.d : undefined;

  return {
    t: raw.t,
    p: raw.p,
    r: stringOrUndefined(raw.r),
    d: duration,
    tid: stringOrUndefined(raw.tid),
    sid: stringOrUndefined(raw.sid),
    en: stringOrUndefined(raw.en),
    us: stringOrUndefined(raw.us),
    um: stringOrUndefined(raw.um),
    uc: stringOrUndefined(raw.uc),
    co: stringOrUndefined(raw.co),
    ci: stringOrUndefined(raw.ci),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isEventType(value: unknown): value is CollectPayload["t"] {
  return (
    value === EVENT_TYPES.PAGEVIEW ||
    value === EVENT_TYPES.BEACON ||
    value === EVENT_TYPES.EVENT
  );
}
