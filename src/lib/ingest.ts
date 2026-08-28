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
        event.countryOverride || (cf?.country as string) || "XX",
        event.cityOverride || (cf?.city as string) || "",
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
