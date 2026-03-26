// ─── Analytics Data Schema ───────────────────────────────────────────────────
// Maps Analytics Engine blob/double slots to semantic field names.
// Reference: https://developers.cloudflare.com/analytics/analytics-engine/

// ─── Blob Slot Mapping ──────────────────────────────────────────────────────

export const BLOB = {
  TENANT_ID: "blob1",
  PAGE_PATH: "blob2",
  VISITOR_HASH: "blob3",
  COUNTRY: "blob4",
  CITY: "blob5",
  DEVICE_TYPE: "blob6",
  REFERRER: "blob7",
  UTM_SOURCE: "blob8",
  UTM_MEDIUM: "blob9",
  UTM_CAMPAIGN: "blob10",
  EVENT_TYPE: "blob11",
  EVENT_NAME: "blob12",
} as const;

// ─── Double Slot Mapping ─────────────────────────────────────────────────────

export const DOUBLE = {
  /** Always 1 — page view counter. Use SUM(_sample_interval) for totals. */
  PAGE_VIEW: "double1",
  /** Seconds spent on page (populated via beacon). */
  TIME_ON_PAGE: "double2",
} as const;

// ─── Event Types ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = {
  PAGEVIEW: "pageview",
  BEACON: "beacon",
  EVENT: "event",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// ─── Device Types ────────────────────────────────────────────────────────────

export const DEVICE_TYPES = {
  DESKTOP: "Desktop",
  MOBILE: "Mobile",
  TABLET: "Tablet",
} as const;

export type DeviceType = (typeof DEVICE_TYPES)[keyof typeof DEVICE_TYPES];

// ─── Data Point Shape ────────────────────────────────────────────────────────

export interface AnalyticsDataPoint {
  tenantId: string;
  pagePath: string;
  visitorHash: string;
  country: string;
  city: string;
  deviceType: DeviceType;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  eventType: EventType;
  eventName: string;
  timeOnPage: number;
}

// ─── Query Result Types ──────────────────────────────────────────────────────

export interface OverviewStats {
  totalViews: number;
  uniqueVisitors: number;
  topPages: PageStat[];
}

export interface PageStat {
  pagePath: string;
  views: number;
  uniqueVisitors: number;
}

export interface ReferrerStat {
  referrer: string;
  utmSource: string;
  utmMedium: string;
  views: number;
}

export interface GeoStat {
  country: string;
  city: string;
  views: number;
  uniqueVisitors: number;
}

export interface DeviceStat {
  deviceType: string;
  views: number;
  uniqueVisitors: number;
}

export interface EventStat {
  eventName: string;
  totalEvents: number;
  uniqueVisitors: number;
}

export interface RealtimeStat {
  currentVisitors: number;
  topPages: Array<{ pagePath: string; visitors: number }>;
}

// ─── Analytics Engine SQL API Response ───────────────────────────────────────

export interface AnalyticsEngineResponse {
  data: Record<string, string | number>[];
  rows: number;
  rows_before_limit_at_least: number;
  meta: Array<{ name: string; type: string }>;
}
