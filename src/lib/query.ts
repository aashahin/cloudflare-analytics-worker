// ─── Analytics Engine Query Helper ───────────────────────────────────────────
// Queries the Cloudflare Analytics Engine SQL API from within the Worker.
// All queries are scoped to a single tenant via blob1 = tenant_id.

import type { Env } from "@/env.ts";
import type {
  AnalyticsEngineResponse,
  DeviceStat,
  EventStat,
  GeoStat,
  OverviewStats,
  PageStat,
  RealtimeStat,
  ReferrerStat,
} from "@/lib/schema.ts";
import { SAFE_TENANT_ID } from "@/lib/utils.ts";

const DEFAULT_ANALYTICS_DATASET = "manhali_analytics";
const SAFE_ANALYTICS_DATASET = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve the AE SQL table name. Production default is manhali_analytics. */
export function resolveAnalyticsDataset(env: Env): string {
  const raw = env.ANALYTICS_DATASET?.trim();
  if (!raw) return DEFAULT_ANALYTICS_DATASET;
  if (!SAFE_ANALYTICS_DATASET.test(raw)) {
    throw new Error(`Invalid ANALYTICS_DATASET: "${raw}"`);
  }
  return raw;
}

// ─── Input Validation ────────────────────────────────────────────────────────

/** Clamp a numeric value to safe bounds. Returns defaultVal if input is invalid. */
function clampInt(
  value: number,
  defaultVal: number,
  min: number,
  max: number,
): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < min || n > max) return defaultVal;
  return n;
}

/** Validate that a tenantId is safe for use in AE SQL queries.
 *  Throws if the ID contains unexpected characters. */
function validateTenantId(tenantId: string): void {
  if (!tenantId || !SAFE_TENANT_ID.test(tenantId)) {
    throw new Error(`Invalid tenant ID format: "${tenantId}"`);
  }
}

// ─── SQL API Client ──────────────────────────────────────────────────────────

async function queryAnalyticsEngine(
  env: Env,
  sql: string,
): Promise<AnalyticsEngineResponse> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
    body: sql,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Analytics Engine query failed (${response.status}): ${text}`,
    );
  }

  return response.json() as Promise<AnalyticsEngineResponse>;
}

// ─── Pre-built Queries ───────────────────────────────────────────────────────

/**
 * Dashboard overview: total views, unique visitors, avg time-on-page, top pages.
 * Uses SUM(_sample_interval) to account for sampling.
 *
 * Note on sampling: view/event totals are reconstructed with
 * SUM(_sample_interval), but COUNT(DISTINCT blob3) (uniqueVisitors) cannot be
 * sample-weighted, so under heavy sampling it is a lower-bound estimate and
 * should not be compared 1:1 against the scaled totals.
 */
export async function getOverview(
  env: Env,
  tenantId: string,
  days: number = 30,
): Promise<OverviewStats> {
  validateTenantId(tenantId);
  days = clampInt(days, 30, 1, 90);
  const dataset = resolveAnalyticsDataset(env);

  const sql = `
    SELECT
      SUM(_sample_interval) AS total_views,
      COUNT(DISTINCT blob3) AS unique_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

  const topPagesSql = `
    SELECT
      blob2 AS page_path,
      SUM(_sample_interval) AS views,
      COUNT(DISTINCT blob3) AS unique_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY page_path
    ORDER BY views DESC
    LIMIT 10
  `;

  // Average time-on-page comes from beacon events (double2 = seconds on page),
  // which the tracker emits on tab-hide / pagehide. Without this the beacon
  // writes would have no read path at all.
  const timeSql = `
    SELECT AVG(double2) AS avg_time_on_page
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'beacon'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

  const [overviewResult, pagesResult, timeResult] = await Promise.all([
    queryAnalyticsEngine(env, sql),
    queryAnalyticsEngine(env, topPagesSql),
    queryAnalyticsEngine(env, timeSql),
  ]);

  const overview = overviewResult.data[0];
  const avgTime = Number(timeResult.data[0]?.avg_time_on_page ?? 0);

  return {
    totalViews: Number(overview?.total_views ?? 0),
    uniqueVisitors: Number(overview?.unique_visitors ?? 0),
    avgTimeOnPage: Number.isFinite(avgTime) ? Math.round(avgTime) : 0,
    topPages: pagesResult.data.map((row) => ({
      pagePath: String(row.page_path),
      views: Number(row.views),
      uniqueVisitors: Number(row.unique_visitors),
    })),
  };
}

/**
 * Top pages ranked by views.
 */
export async function getTopPages(
  env: Env,
  tenantId: string,
  days: number = 30,
  limit: number = 20,
): Promise<PageStat[]> {
  validateTenantId(tenantId);
  days = clampInt(days, 30, 1, 90);
  limit = clampInt(limit, 20, 1, 100);
  const dataset = resolveAnalyticsDataset(env);

  const sql = `
    SELECT
      blob2 AS page_path,
      SUM(_sample_interval) AS views,
      COUNT(DISTINCT blob3) AS unique_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY page_path
    ORDER BY views DESC
    LIMIT ${limit}
  `;

  const result = await queryAnalyticsEngine(env, sql);

  return result.data.map((row) => ({
    pagePath: String(row.page_path),
    views: Number(row.views),
    uniqueVisitors: Number(row.unique_visitors),
  }));
}

/**
 * Top traffic referrers.
 */
export async function getTopReferrers(
  env: Env,
  tenantId: string,
  days: number = 30,
  limit: number = 20,
): Promise<ReferrerStat[]> {
  validateTenantId(tenantId);
  days = clampInt(days, 30, 1, 90);
  limit = clampInt(limit, 20, 1, 100);
  const dataset = resolveAnalyticsDataset(env);

  const sql = `
    SELECT
      blob7 AS referrer,
      blob8 AS utm_source,
      blob9 AS utm_medium,
      blob10 AS utm_campaign,
      SUM(_sample_interval) AS views
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
      AND (blob7 != '' OR blob8 != '' OR blob9 != '' OR blob10 != '')
    GROUP BY referrer, utm_source, utm_medium, utm_campaign
    ORDER BY views DESC
    LIMIT ${limit}
  `;

  const result = await queryAnalyticsEngine(env, sql);

  return result.data.map((row) => ({
    referrer: String(row.referrer),
    utmSource: String(row.utm_source),
    utmMedium: String(row.utm_medium),
    utmCampaign: String(row.utm_campaign),
    views: Number(row.views),
  }));
}

/**
 * Geographic breakdown of visitors.
 */
export async function getGeoBreakdown(
  env: Env,
  tenantId: string,
  days: number = 30,
): Promise<GeoStat[]> {
  validateTenantId(tenantId);
  days = clampInt(days, 30, 1, 90);
  const dataset = resolveAnalyticsDataset(env);

  const sql = `
    SELECT
      blob4 AS country,
      blob5 AS city,
      SUM(_sample_interval) AS views,
      COUNT(DISTINCT blob3) AS unique_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY country, city
    ORDER BY views DESC
    LIMIT 50
  `;

  const result = await queryAnalyticsEngine(env, sql);

  return result.data.map((row) => ({
    country: String(row.country),
    city: String(row.city),
    views: Number(row.views),
    uniqueVisitors: Number(row.unique_visitors),
  }));
}

/**
 * Device type breakdown (Desktop / Mobile / Tablet).
 */
export async function getDeviceBreakdown(
  env: Env,
  tenantId: string,
  days: number = 30,
): Promise<DeviceStat[]> {
  validateTenantId(tenantId);
  days = clampInt(days, 30, 1, 90);
  const dataset = resolveAnalyticsDataset(env);

  const sql = `
    SELECT
      blob6 AS device_type,
      SUM(_sample_interval) AS views,
      COUNT(DISTINCT blob3) AS unique_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY device_type
    ORDER BY views DESC
  `;

  const result = await queryAnalyticsEngine(env, sql);

  return result.data.map((row) => ({
    deviceType: String(row.device_type),
    views: Number(row.views),
    uniqueVisitors: Number(row.unique_visitors),
  }));
}

/**
 * Real-time stats — visitors in the last 30 minutes.
 */
export async function getRealtime(
  env: Env,
  tenantId: string,
): Promise<RealtimeStat> {
  validateTenantId(tenantId);
  const dataset = resolveAnalyticsDataset(env);
  const totalSql = `
    SELECT COUNT(DISTINCT blob3) AS current_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '30' MINUTE
  `;

  const pagesSql = `
    SELECT
      blob2 AS page_path,
      COUNT(DISTINCT blob3) AS visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'pageview'
      AND timestamp >= NOW() - INTERVAL '30' MINUTE
    GROUP BY page_path
    ORDER BY visitors DESC
    LIMIT 10
  `;

  const [totalResult, pagesResult] = await Promise.all([
    queryAnalyticsEngine(env, totalSql),
    queryAnalyticsEngine(env, pagesSql),
  ]);

  return {
    currentVisitors: Number(totalResult.data[0]?.current_visitors ?? 0),
    topPages: pagesResult.data.map((row) => ({
      pagePath: String(row.page_path),
      visitors: Number(row.visitors),
    })),
  };
}
/**
 * Custom events breakdown.
 */
export async function getCustomEvents(
  env: Env,
  tenantId: string,
  days: number = 30,
  limit: number = 20,
): Promise<EventStat[]> {
  validateTenantId(tenantId);
  days = clampInt(days, 30, 1, 90);
  limit = clampInt(limit, 20, 1, 100);
  const dataset = resolveAnalyticsDataset(env);

  const sql = `
    SELECT
      blob12 AS event_name,
      SUM(_sample_interval) AS total_events,
      COUNT(DISTINCT blob3) AS unique_visitors
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND blob11 = 'event'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY event_name
    ORDER BY total_events DESC
    LIMIT ${limit}
  `;

  const result = await queryAnalyticsEngine(env, sql);

  return result.data.map((row) => ({
    eventName: String(row.event_name),
    totalEvents: Number(row.total_events),
    uniqueVisitors: Number(row.unique_visitors),
  }));
}

// ─── SQL Escape ──────────────────────────────────────────────────────────────

/** Escape a string for use in AE SQL. Strips control characters and escapes quotes + backslashes. */
export function escapeSql(value: string): string {
  return value
    .replace(/[\0\x08\x09\x1a\n\r]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''");
}
