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
 * Track a page view or event by writing a data point to Analytics Engine.
 * Extracts geo, device, and visitor data from the request automatically.
 *
 * Bot traffic is filtered using UA-based detection (no Enterprise plan needed).
 * UTM params and referrer should be passed explicitly from the collect payload
 * (the tracker sends document.referrer and URL UTM params in the JSON body).
 */
export async function trackEvent(
  request: Request,
  env: Env,
  options: IngestOptions,
): Promise<void> {
  return trackEvents(request, env, [options]);
}

/**
 * Track a small group of events received in one request while calculating the
 * privacy-safe visitor fingerprint and request metadata only once.
 */
export async function trackEvents(
  request: Request,
  env: Env,
  options: readonly IngestOptions[],
  forwardedGeo: VisitorGeo = {},
): Promise<void> {
  if (options.length === 0) return;

  // ─── Bot Filtering (UA-based, free tier) ─────────────────────────────────
  const userAgent = request.headers.get("User-Agent") ?? "";
  if (isBot(userAgent)) return;

  const tenantId = options[0]!.tenantId;
  if (options.some((event) => event.tenantId !== tenantId)) {
    throw new Error("Ingest batches must share one tenant identity");
  }

  // ─── Extract Request Metadata ────────────────────────────────────────────

  const ip = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";

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
    env.FINGERPRINT_SECRET,
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
        event.countryOverride || (cf?.country as string) || forwardedGeo.country || "XX",
        event.cityOverride || (cf?.city as string) || forwardedGeo.city || "",
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
