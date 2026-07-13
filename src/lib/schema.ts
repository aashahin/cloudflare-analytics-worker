// ─── Analytics Data Schema ───────────────────────────────────────────────────
// Maps Analytics Engine blob/double slots to semantic field names.
// Reference: https://developers.cloudflare.com/analytics/analytics-engine/

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

// ─── Query Result Types ──────────────────────────────────────────────────────

export interface OverviewStats {
  totalViews: number;
  uniqueVisitors: number;
  /** Average time-on-page in seconds, derived from beacon (double2) events. */
  avgTimeOnPage: number;
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
  utmCampaign: string;
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
