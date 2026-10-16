// ─── Data Ingestion ──────────────────────────────────────────────────────────
// Extracts analytics dimensions from incoming requests and writes data points
// to Cloudflare Analytics Engine. This is the "hot path" — runs on every request.

import type { Env } from "@/env.ts";
import { isBot } from "@/lib/bot-filter.ts";
import { generateVisitorHash } from "@/lib/fingerprint.ts";
import { EVENT_TYPES, type EventType } from "@/lib/schema.ts";
import { cleanReferrer, parseDeviceType } from "@/lib/ua-parser.ts";
import { extractHostname } from "@/lib/utils.ts";

export interface IngestOptions {
  tenantId: string;
  pagePath: string;
  eventType?: EventType;
  /** Custom event name (for window.manhali.track("name") events) */
  eventName?: string;
  timeOnPage?: number;
  /** External referrer URL (from document.referrer via tracker) */
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  /** Override CF geo country (for server-to-server seeding / backend tracking) */
  countryOverride?: string;
  /** Override CF geo city (for server-to-server seeding / backend tracking) */
  cityOverride?: string;
}

/** Visitor geo relayed by a trusted proxy hop whose own request has no `cf`. */
export interface VisitorGeo {
  country?: string;
  city?: string;
}

/** Request-scoped context shared by every event in one collect call. */
export interface IngestRequestContext {
  /** Geo relayed by the trusted service-binding proxy, when `cf` is absent. */
  forwardedGeo?: VisitorGeo;
  /**
   * Verified server-to-server ingest. Bypasses the UA bot filter because
   * backends legitimately send library user agents (`undici`, `node`, `axios`,
   * `curl`, …) that the public filter would otherwise drop with a silent 204.
   */
  serverToServer?: boolean;
}

export const VISITOR_COUNTRY_HEADER = "x-manhali-visitor-country";
/** URI-encoded: city names are not limited to header-safe Latin-1. */
export const VISITOR_CITY_HEADER = "x-manhali-visitor-city";

const COUNTRY_CODE = /^[A-Z]{2}$/;
const MAX_CITY_LENGTH = 100;

/**
 * Read the visitor geo a trusted proxy forwarded. Only call this for requests
 * that arrived through the service-binding-only entrypoint: on the public
 * endpoint these headers are caller-controlled.
 */
export function readForwardedVisitorGeo(request: Request): VisitorGeo {
  const geo: VisitorGeo = {};
  const country = request.headers.get(VISITOR_COUNTRY_HEADER)?.trim().toUpperCase();
  if (country && COUNTRY_CODE.test(country)) geo.country = country;
  const rawCity = request.headers.get(VISITOR_CITY_HEADER);
  if (rawCity) {
    try {
      const city = decodeURIComponent(rawCity).replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (city) geo.city = city.slice(0, MAX_CITY_LENGTH);
    } catch {
      // Malformed percent-encoding: drop the city, keep the event.
    }
  }
  return geo;
}

/**
 * Track a small group of events received in one request while calculating the
 * privacy-safe visitor fingerprint and request metadata only once.
 *
 * Bot traffic is filtered using UA-based detection (no Enterprise plan needed),
 * except for verified server-to-server ingest. UTM params and referrer arrive
 * explicitly in the collect payload (the tracker sends document.referrer and
 * URL UTM params in the JSON body).
 */
export async function trackEvents(
  request: Request,
  env: Env,
  options: readonly IngestOptions[],
  context: IngestRequestContext = {},
): Promise<void> {
  if (options.length === 0) return;

  // ─── Bot Filtering (UA-based, free tier) ─────────────────────────────────
  const userAgent = request.headers.get("User-Agent") ?? "";
  if (!context.serverToServer && isBot(userAgent)) return;

  const tenantId = options[0]!.tenantId;
  if (options.some((event) => event.tenantId !== tenantId)) {
    throw new Error("Ingest batches must share one tenant identity");
  }

  // ─── Extract Request Metadata ────────────────────────────────────────────

  // The edge always sets CF-Connecting-IP on the public endpoint; the sentinel
  // only covers local runs where neither the header nor `cf` exists.
  const ip = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";

  const fingerprintSecret = env.FINGERPRINT_SECRET;
  if (typeof fingerprintSecret !== "string" || fingerprintSecret.trim().length === 0) {
    // Fail closed: without the salt every visitor hash degenerates to a
    // predictable constant, silently degrading the privacy guarantee.
    throw new Error("Required secret FINGERPRINT_SECRET is not configured");
  }

  // Privacy-safe visitor hash for unique visitor aggregation.
  // Uses a dedicated secret (separate from AUTH_TOKEN for defense in depth),
  // scoped to the tenant and bucketed by UTC day so identities cannot be
  // correlated across tenants and rotate daily (see fingerprint.ts).
  const dayBucket = new Date().toISOString().slice(0, 10); // UTC "YYYY-MM-DD"
  const visitorHash = await generateVisitorHash(
    tenantId,
    ip,
    userAgent,
    dayBucket,
    fingerprintSecret,
  );

  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const deviceType = parseDeviceType(userAgent);
  const originHost = extractHostname(request.headers.get("Origin")) ?? "";

  for (const event of options) {
    const eventType = event.eventType ?? EVENT_TYPES.PAGEVIEW;
    const referrer = event.referrer
      ? cleanReferrer(event.referrer, originHost).slice(0, 253)
      : "";

    env.ANALYTICS.writeDataPoint({
      indexes: [tenantId],
      blobs: [
        tenantId,
        event.pagePath,
        visitorHash,
        // The edge's own geo wins; a proxied request (service binding) has no
        // `cf`, so it falls back to what the trusted proxy forwarded.
        event.countryOverride || (cf?.country as string) || context.forwardedGeo?.country || "XX",
        event.cityOverride || (cf?.city as string) || context.forwardedGeo?.city || "",
        deviceType,
        referrer,
        event.utmSource ?? "",
        event.utmMedium ?? "",
        event.utmCampaign ?? "",
        eventType,
        event.eventName ?? "",
      ],
      doubles: [
        eventType === EVENT_TYPES.PAGEVIEW ? 1 : 0,
        event.timeOnPage ?? 0,
      ],
    });
  }
}
