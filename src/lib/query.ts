// ─── Analytics Engine Query Helper ───────────────────────────────────────────
// Queries the Cloudflare Analytics Engine SQL API from within the Worker.
// All queries are scoped to a single tenant via blob1 = tenant_id.
//
// Every SQL API POST is a read query. Analytics Engine is not currently billed,
// but Cloudflare publishes future read-query pricing, so overview / realtime /
// sections go through a colo Cache API (60s) plus an isolate Map L1 to keep the
// request count bounded. Pattern matches backend audit analytics SQL caching.

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

// ─── Cache (isolate L1 + Workers Cache API) ──────────────────────────────────

const QUERY_CACHE_TTL_SECONDS = 60;
const QUERY_CACHE_TTL_MS = QUERY_CACHE_TTL_SECONDS * 1000;
const QUERY_CACHE_L1_MAX = 50;
const QUERY_INFLIGHT_MAX = 100;
const CACHE_NAMESPACE = "analytics-query-v1";
const CACHE_ORIGIN = "https://analytics-query.manhali.internal/v1/";

const queryL1 = new Map<string, { expiresAt: number; value: unknown }>();
const queryInflight = new Map<string, Promise<unknown>>();
let cacheHandle: Promise<Cache> | undefined;

function queryCacheHandle(): Promise<Cache> | undefined {
  try {
    if (typeof caches === "undefined" || typeof caches.open !== "function") {
      return undefined;
    }
    cacheHandle ??= caches.open(CACHE_NAMESPACE);
    return cacheHandle;
  } catch {
    return undefined;
  }
}

async function hashCacheKey(material: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function rememberL1<T>(key: string, value: T): void {
  if (queryL1.size >= QUERY_CACHE_L1_MAX) {
    const first = queryL1.keys().next().value;
    if (first) queryL1.delete(first);
  }
  queryL1.set(key, { expiresAt: Date.now() + QUERY_CACHE_TTL_MS, value });
}

async function cacheApiGet<T>(key: string): Promise<T | undefined> {
  try {
    const handle = queryCacheHandle();
    if (!handle) return undefined;
    const cache = await handle;
    const hit = await cache.match(new Request(CACHE_ORIGIN + key));
    if (hit === undefined) return undefined;
    return (await hit.json()) as T;
  } catch {
    return undefined;
  }
}

async function cacheApiPut(key: string, value: unknown): Promise<void> {
  try {
    const handle = queryCacheHandle();
    if (!handle) return;
    const cache = await handle;
    await cache.put(
      new Request(CACHE_ORIGIN + key),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${QUERY_CACHE_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // A cache that cannot store is a cache miss next time.
  }
}

/**
 * L1 isolate Map, then colo Cache API, then `load`. Failures in Cache API
 * degrade to "slower and billed", never to 500.
 */
async function withCachedResult<T>(
  material: string,
  load: () => Promise<T>,
  shouldStore: (value: T) => boolean = () => true,
): Promise<T> {
  const key = await hashCacheKey(material);
  const hit = queryL1.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  if (hit) queryL1.delete(key);

  const existing = queryInflight.get(key);
  if (existing) return existing as Promise<T>;

  const resolve = async (): Promise<T> => {
    const cached = await cacheApiGet<T>(key);
    if (cached !== undefined) {
      rememberL1(key, cached);
      return cached;
    }

    const value = await load();
    if (shouldStore(value)) {
      rememberL1(key, value);
      await cacheApiPut(key, value);
    }
    return value;
  };

  // Bound coordination state so attacker-controlled tenant/window keys cannot
  // grow the isolate indefinitely. At saturation, correctness is preserved;
  // only the coalescing optimization is skipped for the new key.
  if (queryInflight.size >= QUERY_INFLIGHT_MAX) return resolve();

  const pending = resolve();
  queryInflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queryInflight.get(key) === pending) queryInflight.delete(key);
  }
}

/** Drop isolate L1 (Cache API entries expire via max-age). */
export function clearAnalyticsQueryCache(): void {
  queryL1.clear();
  queryInflight.clear();
  cacheHandle = undefined;
}

export function clearDashboardSectionsCache(): void {
  clearAnalyticsQueryCache();
}

// ─── SQL API Client ──────────────────────────────────────────────────────────

async function fetchAnalyticsEngine(
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

async function queryAnalyticsEngine(
  env: Env,
  sql: string,
): Promise<AnalyticsEngineResponse> {
  return withCachedResult(`sql:${sql}`, () => fetchAnalyticsEngine(env, sql));
}

// ─── Pre-built Queries ───────────────────────────────────────────────────────

/**
 * Slim dashboard overview: total views, unique visitors, avg time-on-page.
 * One AE SQL. Top pages live on /api/pages and /api/sections.
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

  return withCachedResult(
    `overview:${dataset}:${tenantId}:${days}`,
    async () => {
      // ClickHouse-style AE SQL: one scan for pageview totals + beacon duration.
      // Duration uses the documented sampling weight on both numerator and
      // denominator; AVG(double2) would bias rows with different intervals.
      const sql = `
    SELECT
      SUM(if(blob11 = 'pageview', _sample_interval, 0)) AS total_views,
      COUNT(DISTINCT if(blob11 = 'pageview', blob3, NULL)) AS unique_visitors,
      SUM(if(blob11 = 'beacon', double2 * _sample_interval, 0)) /
        SUM(if(blob11 = 'beacon', _sample_interval, 0)) AS avg_time_on_page
    FROM ${dataset}
    WHERE blob1 = '${escapeSql(tenantId)}'
      AND (blob11 = 'pageview' OR blob11 = 'beacon')
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
  `;

      const overviewResult = await queryAnalyticsEngine(env, sql);
      const overview = overviewResult.data[0];
      const avgTime = Number(overview?.avg_time_on_page ?? 0);

      return {
        totalViews: Number(overview?.total_views ?? 0),
        uniqueVisitors: Number(overview?.unique_visitors ?? 0),
        avgTimeOnPage: Number.isFinite(avgTime) ? Math.round(avgTime) : 0,
        topPages: [],
      };
    },
  );
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

  return withCachedResult(`realtime:${dataset}:${tenantId}`, async () => {
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
  });
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

export type DashboardSectionErrors = {
  pages: boolean;
  referrers: boolean;
  geo: boolean;
  devices: boolean;
  events: boolean;
};

export type DashboardSections = {
  pages: PageStat[];
  referrers: ReferrerStat[];
  geo: GeoStat[];
  devices: DeviceStat[];
  events: EventStat[];
  errors: DashboardSectionErrors;
};

/**
 * One dashboard round-trip instead of five public HTTP calls from the
 * platform Worker. Cached 60s (isolate L1 + Cache API) so tab reloads and
 * fetcher retries do not re-bill Analytics Engine SQL.
 */
export async function getDashboardSections(
  env: Env,
  tenantId: string,
  days: number = 30,
  limit: number = 20,
): Promise<DashboardSections> {
  days = clampInt(days, 30, 1, 90);
  limit = clampInt(limit, 20, 1, 100);
  const dataset = resolveAnalyticsDataset(env);

  return withCachedResult(
    `sections:${dataset}:${tenantId}:${days}:${limit}`,
    async () => {
      const [pages, referrers, geo, devices, events] = await Promise.allSettled(
        [
          getTopPages(env, tenantId, days, limit),
          getTopReferrers(env, tenantId, days, limit),
          getGeoBreakdown(env, tenantId, days),
          getDeviceBreakdown(env, tenantId, days),
          getCustomEvents(env, tenantId, days, limit),
        ],
      );
      return {
        pages: pages.status === "fulfilled" ? pages.value : [],
        referrers: referrers.status === "fulfilled" ? referrers.value : [],
        geo: geo.status === "fulfilled" ? geo.value : [],
        devices: devices.status === "fulfilled" ? devices.value : [],
        events: events.status === "fulfilled" ? events.value : [],
        errors: {
          pages: pages.status === "rejected",
          referrers: referrers.status === "rejected",
          geo: geo.status === "rejected",
          devices: devices.status === "rejected",
          events: events.status === "rejected",
        },
      };
    },
    (value) => !Object.values(value.errors).some(Boolean),
  );
}

// ─── SQL Escape ──────────────────────────────────────────────────────────────

/** Escape a string for use in AE SQL. Strips control characters and escapes quotes + backslashes. */
export function escapeSql(value: string): string {
  return value
    .replace(/[\0\x08\x09\x1a\n\r]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''");
}
