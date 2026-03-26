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
  const {
    tenantId,
    pagePath,
    eventType = EVENT_TYPES.PAGEVIEW,
    eventName = "",
    timeOnPage = 0,
    referrer: rawReferrer,
    utmSource: optUtmSource,
    utmMedium: optUtmMedium,
    utmCampaign: optUtmCampaign,
    countryOverride,
    cityOverride,
  } = options;

  // ─── Bot Filtering (UA-based, free tier) ─────────────────────────────────
  const userAgent = request.headers.get("User-Agent") ?? "";
  if (isBot(userAgent)) return;

  // ─── Extract Request Metadata ────────────────────────────────────────────

  const ip = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";

  // Privacy-safe daily-rotating visitor hash
  // Uses a dedicated secret (separate from AUTH_TOKEN for defense in depth)
  const visitorHash = await generateVisitorHash(
    ip,
    userAgent,
    env.FINGERPRINT_SECRET,
  );

  // Geo data (provided free by Cloudflare on every request).
  // Server-to-server requests may supply overrides (e.g. seed scripts).
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const country = countryOverride || (cf?.country as string) || "XX";
  const city = cityOverride || (cf?.city as string) || "";

  // Device type from UA
  const deviceType = parseDeviceType(userAgent);

  // Referrer: prefer the explicitly passed value (document.referrer from tracker),
  // which is the actual external referrer. The request's Referer header points to
  // the page making the beacon call, which is the tenant's own page — not useful.
  const originHost = extractHostname(request.headers.get("Origin")) ?? "";
  const referrer = rawReferrer ? cleanReferrer(rawReferrer, originHost) : "";

  // UTM: prefer values from collect body (tracker extracts from the page URL).
  // The worker's own URL (/api/collect) never has UTM params.
  const utmSource = optUtmSource ?? "";
  const utmMedium = optUtmMedium ?? "";
  const utmCampaign = optUtmCampaign ?? "";

  // ─── Write Data Point ────────────────────────────────────────────────────
  // writeDataPoint() is fire-and-forget — no await needed.
  // The Workers runtime handles persistence in the background.

  env.ANALYTICS.writeDataPoint({
    indexes: [tenantId],
    blobs: [
      tenantId, // blob1
      pagePath, // blob2
      visitorHash, // blob3
      country, // blob4
      city, // blob5
      deviceType, // blob6
      referrer, // blob7
      utmSource, // blob8
      utmMedium, // blob9
      utmCampaign, // blob10
      eventType, // blob11
      eventName, // blob12 — custom event name
    ],
    doubles: [
      eventType === EVENT_TYPES.PAGEVIEW ? 1 : 0, // double1 — only count for pageviews
      timeOnPage, // double2 — seconds on page (from beacon)
    ],
  });
}
