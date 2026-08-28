// ─── Manhali Analytics Worker — Entrypoint ───────────────────────────────────
// Edge-native analytics engine: privacy-first Google Analytics alternative.
//
// Data flow:
//   1. Ingestion: writeDataPoint() → Analytics Engine (90-day retention)
//   2. Live queries: SQL API → Analytics Engine
//   3. No D1 — Analytics Engine is the sole data store.

import type { Env } from "@/env.ts";
import { verifyAuth, verifyIngestAuth } from "@/lib/auth.ts";
import {
  badRequest,
  forbidden,
  handleCors,
  privateJsonResponse,
  publicCorsHeaders,
  publicJsonResponse,
  unauthorized,
} from "@/lib/cors.ts";
import { trackEvents, type IngestOptions } from "@/lib/ingest.ts";
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
import {
  extractHostname,
  SAFE_TENANT_ID,
  sanitizePath,
} from "@/lib/utils.ts";
import { handleAdminRoutes } from "@/routes/admin.ts";
import { getTrackerHeaders, getTrackerScript } from "@/tracker/script.ts";

const MAX_COLLECT_BODY_BYTES = 65_536;
const MAX_COLLECT_EVENTS = 2;
const QUERY_PATHS = new Set([
  "/api/overview",
  "/api/pages",
  "/api/referrers",
  "/api/geo",
  "/api/devices",
  "/api/realtime",
  "/api/events",
  "/api/sections",
]);
export const QUERY_DAY_BUCKETS = [1, 7, 30, 90] as const;
export const QUERY_LIMIT_BUCKETS = [10, 20, 50, 100] as const;

export function canonicalQueryBucket(
  raw: string | null,
  buckets: readonly number[],
  fallback: number,
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const integer = Math.trunc(parsed);
  return buckets.find((bucket) => integer <= bucket) ?? buckets.at(-1) ?? fallback;
}

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

      if (QUERY_PATHS.has(pathname)) {
        const limited = await applyQueryRateLimit(request, env, tenantId!);
        if (limited) return limited;
      }

      const days = canonicalQueryBucket(
        url.searchParams.get("days"),
        QUERY_DAY_BUCKETS,
        30,
      );
      const limit = canonicalQueryBucket(
        url.searchParams.get("limit"),
        QUERY_LIMIT_BUCKETS,
        20,
      );

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
  // Authenticated server-to-server ingest skips the public collect limiter.
  const ingestAuthenticated = await verifyIngestAuth(request, env);
  let consumedIpQuotaUnits = 0;
  if (!ingestAuthenticated) {
    // Charge malformed/oversized unauthenticated requests before reading their
    // body. A valid two-event batch consumes its second unit after parsing.
    const limited = await applyCollectRateLimit(request, env, 1);
    if (limited) return limited;
    consumedIpQuotaUnits = 1;
  }

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

  let events: CollectPayload[];
  try {
    events = parseCollectPayloads(rawText);
  } catch (error) {
    return publicJsonResponse(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      400,
    );
  }

  const firstEvent = events[0]!;
  const serverToServer = Boolean(
    ingestAuthenticated &&
      firstEvent.tid &&
      SAFE_TENANT_ID.test(firstEvent.tid),
  );
  // A valid token by itself is not a server-to-server event. Malformed or
  // browser-shaped payloads still consume the public quotas so they cannot use
  // an Authorization header to bypass the KV/ingest cost controls.
  if (!serverToServer && events.length > consumedIpQuotaUnits) {
    const limited = await applyCollectRateLimit(
      request,
      env,
      events.length - consumedIpQuotaUnits,
    );
    if (limited) return limited;
  }
  if (!serverToServer) {
    const limited = await applySiteCollectRateLimit(
      request,
      env,
      firstEvent.sid,
      events.length,
    );
    if (limited) return limited;
  }

  // resolveTenant reads KV (which can fail transiently) and trackEvent runs the
  // hash + write; wrap both so a throw returns a CORS-bearing 500 rather than
  // escaping fetch() as a bare 500 with no Access-Control-Allow-Origin header.
  try {
    // ─── Tenant Resolution ─────────────────────────────────────────────────
    const { tenantId, error, isServerToServer } = await resolveTenant(
      request,
      env,
      firstEvent,
      { ingestAuthenticated },
    );
    if (!tenantId) {
      return publicJsonResponse(
        { error: error ?? "Cannot determine tenant" },
        400,
      );
    }

    await trackEvents(
      request,
      env,
      events.map((event) =>
        buildCollectEvent({ event, tenantId, isServerToServer }),
      ),
    );

    // 204 No Content — minimal response for tracker
    return new Response(null, { status: 204, headers: publicCorsHeaders() });
  } catch (error) {
    console.error("[Collect] Error:", error);
    return publicJsonResponse({ error: "Internal server error" }, 500);
  }
}

function buildCollectEvent({
  event,
  tenantId,
  isServerToServer,
}: {
  event: CollectPayload,
  tenantId: string,
  isServerToServer: boolean,
}): IngestOptions {
  const eventType =
    event.t === "beacon"
      ? EVENT_TYPES.BEACON
      : event.t === "event"
        ? EVENT_TYPES.EVENT
        : EVENT_TYPES.PAGEVIEW;
  const countryOverride =
    isServerToServer && event.co && /^[A-Z]{2}$/.test(event.co)
      ? event.co
      : undefined;

  return {
    tenantId,
    pagePath: sanitizePath(event.p),
    eventType,
    eventName: (event.en ?? "").replace(/[^a-zA-Z0-9_\-. ]/g, "").slice(0, 100),
    timeOnPage: Math.max(0, Math.min(event.d ?? 0, 3600)),
    referrer: event.r ?? "",
    utmSource: (event.us ?? "").slice(0, 200),
    utmMedium: (event.um ?? "").slice(0, 200),
    utmCampaign: (event.uc ?? "").slice(0, 200),
    countryOverride,
    cityOverride:
      isServerToServer && event.ci ? event.ci.slice(0, 100) : undefined,
  };
}

async function applyCollectRateLimit(
  request: Request,
  env: Env,
  units: number,
): Promise<Response | null> {
  const limiter = env.COLLECT_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== "function") {
    if (env.ENVIRONMENT === "development") {
      console.warn(
        JSON.stringify({
          event: "collect_rate_limit_unavailable",
          environment: env.ENVIRONMENT,
        }),
      );
      return null;
    }
    console.error(
      JSON.stringify({
        event: "collect_rate_limit_unavailable",
        environment: env.ENVIRONMENT,
      }),
    );
    return publicJsonResponse(
      { error: "Analytics temporarily unavailable" },
      503,
    );
  }

  try {
    const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
    for (let index = 0; index < units; index += 1) {
      const { success } = await limiter.limit({ key: ip });
      if (!success) {
        return publicJsonResponse({ error: "Too many requests" }, 429);
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "collect_rate_limit_failed",
        environment: env.ENVIRONMENT,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
    if (env.ENVIRONMENT !== "development") {
      return publicJsonResponse(
        { error: "Analytics temporarily unavailable" },
        503,
      );
    }
  }
  return null;
}

async function applySiteCollectRateLimit(
  request: Request,
  env: Env,
  siteId: string | undefined,
  units: number,
): Promise<Response | null> {
  const normalizedSiteId =
    siteId && SAFE_TENANT_ID.test(siteId) ? siteId : "invalid";
  const origin =
    extractHostname(request.headers.get("Origin")) ??
    extractHostname(request.headers.get("Referer")) ??
    "unknown";
  return applyPublicRateLimit(
    env.SITE_COLLECT_RATE_LIMIT,
    [`site:${normalizedSiteId}`, `origin:${origin.toLowerCase()}`],
    env,
    "site_collect_rate_limit",
    units,
  );
}

async function applyQueryRateLimit(
  request: Request,
  env: Env,
  tenantId: string,
): Promise<Response | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  const tokenSubject = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : authorization.trim();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(tokenSubject),
  );
  const tokenHash = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const limiter = env.QUERY_RATE_LIMIT;
  if (!limiter || typeof limiter.limit !== "function") {
    return rateLimitUnavailable(request, env, "query_rate_limit");
  }

  try {
    const results = await Promise.all([
      limiter.limit({ key: `token:${tokenHash}` }),
      limiter.limit({ key: `tenant:${tenantId}:token:${tokenHash}` }),
    ]);
    if (results.some(({ success }) => !success)) {
      return privateJsonResponse(request, { error: "Too many requests" }, 429);
    }
  } catch (error) {
    logRateLimitFailure(env, "query_rate_limit", error);
    if (env.ENVIRONMENT !== "development") {
      return privateJsonResponse(
        request,
        { error: "Analytics temporarily unavailable" },
        503,
      );
    }
  }
  return null;
}

async function applyPublicRateLimit(
  limiter: RateLimit | undefined,
  keys: readonly string[],
  env: Env,
  event: string,
  units = 1,
): Promise<Response | null> {
  if (!limiter || typeof limiter.limit !== "function") {
    return rateLimitUnavailable(undefined, env, event);
  }

  try {
    for (let index = 0; index < units; index += 1) {
      const results = await Promise.all(
        keys.map((key) => limiter.limit({ key })),
      );
      if (results.some(({ success }) => !success)) {
        return publicJsonResponse({ error: "Too many requests" }, 429);
      }
    }
  } catch (error) {
    logRateLimitFailure(env, event, error);
    if (env.ENVIRONMENT !== "development") {
      return publicJsonResponse(
        { error: "Analytics temporarily unavailable" },
        503,
      );
    }
  }
  return null;
}

function rateLimitUnavailable(
  request: Request | undefined,
  env: Env,
  event: string,
): Response | null {
  const payload = { event: `${event}_unavailable`, environment: env.ENVIRONMENT };
  if (env.ENVIRONMENT === "development") {
    console.warn(JSON.stringify(payload));
    return null;
  }
  console.error(JSON.stringify(payload));
  return request
    ? privateJsonResponse(
        request,
        { error: "Analytics temporarily unavailable" },
        503,
      )
    : publicJsonResponse({ error: "Analytics temporarily unavailable" }, 503);
}

function logRateLimitFailure(env: Env, event: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: `${event}_failed`,
      environment: env.ENVIRONMENT,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    }),
  );
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

function parseCollectPayloads(rawText: string): CollectPayload[] {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error("Invalid JSON");
  }

  if (!isRecord(raw)) {
    throw new Error("Invalid JSON body");
  }

  const rawEvents = Array.isArray(raw.events) ? raw.events : [raw];
  if (rawEvents.length === 0 || rawEvents.length > MAX_COLLECT_EVENTS) {
    throw new Error("Collect batch must contain one or two events");
  }

  const events = rawEvents.map(parseCollectPayload);
  const firstEvent = events[0]!;
  if (
    events.some(
      (event) => event.sid !== firstEvent.sid || event.tid !== firstEvent.tid,
    )
  ) {
    throw new Error("Collect batch events must share tenant identity");
  }
  return events;
}

function parseCollectPayload(raw: unknown): CollectPayload {
  if (!isRecord(raw)) {
    throw new Error("Invalid collect event");
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
