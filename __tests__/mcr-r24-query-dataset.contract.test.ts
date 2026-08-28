/**
 * MCR-R24 / MCR-003 — query SQL must use the configured Analytics Engine
 * dataset. Sandbox ingest writes to `manhali_analytics_sandbox`
 * (`wrangler.toml` `[env.sandbox]`); hardcoded `FROM manhali_analytics`
 * queries a table that is not where sandbox data lives (and may not exist
 * on account a793ff57a25dfe6874a8738f9addd295), which 500s GET /api/pages
 * and /api/realtime after AUTH_TOKEN is valid.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/env.ts";
import {
  clearAnalyticsQueryCache,
  clearDashboardSectionsCache,
  getDashboardSections,
  getOverview,
  getRealtime,
  getTopPages,
} from "../src/lib/query.ts";

const PRODUCTION_DATASET = "manhali_analytics";
const SANDBOX_DATASET = "manhali_analytics_sandbox";
const PRODUCTION_ACCOUNT_ID = "53fb41ede04e54b276ce3fd9bfd270b6";
const SANDBOX_ACCOUNT_ID = "a793ff57a25dfe6874a8738f9addd295";
const PRODUCTION_ROUTE = "analytics.worker.manhali.com";

const wranglerPath = join(import.meta.dir, "../wrangler.toml");
const querySourcePath = join(import.meta.dir, "../src/lib/query.ts");

const originalFetch = globalThis.fetch;
const originalCaches = (globalThis as { caches?: CacheStorage }).caches;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) {
    delete (globalThis as { caches?: CacheStorage }).caches;
  } else {
    (globalThis as { caches?: CacheStorage }).caches = originalCaches;
  }
  clearAnalyticsQueryCache();
});

function emptyEngineResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [],
      rows: 0,
      rows_before_limit_at_least: 0,
      meta: [],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function captureSql(env: Env): { sql: string[]; restore: () => void } {
  const sql: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sql.push(String(init?.body ?? ""));
    return emptyEngineResponse();
  }) as typeof fetch;
  return {
    sql,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function createQueryEnv(dataset?: string): Env {
  return {
    ANALYTICS: { writeDataPoint() {} },
    DOMAINS_KV: { get: async () => null } as KVNamespace,
    COLLECT_RATE_LIMIT: {
      async limit() {
        return { success: true };
      },
    },
    SITE_COLLECT_RATE_LIMIT: {
      async limit() {
        return { success: true };
      },
    },
    QUERY_RATE_LIMIT: {
      async limit() {
        return { success: true };
      },
    },
    AUTH_TOKEN: "admin-secret",
    CF_API_TOKEN: "cf-secret",
    FINGERPRINT_SECRET: "fingerprint-secret",
    ACCOUNT_ID: SANDBOX_ACCOUNT_ID,
    ENVIRONMENT: "staging",
    ALLOW_UNREGISTERED_DOMAINS: "true",
    ...(dataset !== undefined ? { ANALYTICS_DATASET: dataset } : {}),
  };
}

function installMemoryCaches(): void {
  const buckets = new Map<string, Map<string, string>>();
  (globalThis as { caches: CacheStorage }).caches = {
    open: async (name: string) => {
      let store = buckets.get(name);
      if (!store) {
        store = new Map();
        buckets.set(name, store);
      }
      const entries = store;
      return {
        match: async (request: RequestInfo | URL) => {
          const url = request instanceof Request ? request.url : String(request);
          const body = entries.get(url);
          if (body === undefined) return undefined;
          return new Response(body, {
            headers: { "content-type": "application/json" },
          });
        },
        put: async (request: RequestInfo | URL, response: Response) => {
          const url = request instanceof Request ? request.url : String(request);
          entries.set(url, await response.clone().text());
        },
        delete: async () => false,
        keys: async () => [],
        add: async () => undefined,
        addAll: async () => undefined,
        matchAll: async () => [],
      } as Cache;
    },
    default: undefined as unknown as Cache,
    delete: async () => false,
    has: async () => false,
    keys: async () => [],
    match: async () => undefined,
  } as CacheStorage;
}

function fromClause(dataset: string): RegExp {
  return new RegExp(`FROM\\s+${dataset}(?:\\s|$)`, "m");
}

describe("MCR-R24 / MCR-003 analytics query dataset", () => {
  it("sandbox ANALYTICS_DATASET is used in /api/pages and /api/realtime SQL", async () => {
    const env = createQueryEnv(SANDBOX_DATASET);
    const captured = captureSql(env);

    await getTopPages(env, "tenant_1", 7, 10);
    await getRealtime(env, "tenant_1");

    captured.restore();
    expect(captured.sql.length).toBeGreaterThan(0);
    for (const sql of captured.sql) {
      expect(sql).toMatch(fromClause(SANDBOX_DATASET));
      expect(sql).not.toMatch(fromClause(PRODUCTION_DATASET));
    }
  });

  it("production default stays manhali_analytics when ANALYTICS_DATASET is unset", async () => {
    const env = createQueryEnv();
    const captured = captureSql(env);

    await getTopPages(env, "tenant_1", 7, 10);

    captured.restore();
    expect(captured.sql.length).toBeGreaterThan(0);
    for (const sql of captured.sql) {
      expect(sql).toMatch(fromClause(PRODUCTION_DATASET));
      expect(sql).not.toMatch(fromClause(SANDBOX_DATASET));
    }
  });

  it("wrangler sandbox vars point SQL at the sandbox ingest dataset; production is unchanged", () => {
    const toml = readFileSync(wranglerPath, "utf8");
    const sandboxIdx = toml.indexOf("[env.sandbox]");
    expect(sandboxIdx).toBeGreaterThan(0);
    const production = toml.slice(0, sandboxIdx);
    const sandbox = toml.slice(sandboxIdx);

    expect(production).toMatch(
      /^account_id = "53fb41ede04e54b276ce3fd9bfd270b6"$/m,
    );
    expect(production).toMatch(
      /^ACCOUNT_ID = "53fb41ede04e54b276ce3fd9bfd270b6"$/m,
    );
    expect(production).toContain(`pattern = "${PRODUCTION_ROUTE}"`);
    expect(production).toMatch(
      /\[\[analytics_engine_datasets\]\][\s\S]*?dataset = "manhali_analytics"/,
    );
    expect(production).toMatch(/ANALYTICS_DATASET\s*=\s*"manhali_analytics"/);
    expect(production).not.toMatch(/^account_id = "a793ff57a25dfe6874a8738f9addd295"$/m);
    expect(production).not.toMatch(/^ACCOUNT_ID = "a793ff57a25dfe6874a8738f9addd295"$/m);
    expect(production).not.toMatch(/ANALYTICS_DATASET\s*=\s*"manhali_analytics_sandbox"/);
    expect(production).not.toMatch(
      /\[\[analytics_engine_datasets\]\][\s\S]*?dataset = "manhali_analytics_sandbox"/,
    );

    expect(sandbox).toContain(`account_id = "${SANDBOX_ACCOUNT_ID}"`);
    expect(sandbox).toMatch(
      /\[\[env\.sandbox\.analytics_engine_datasets\]\][\s\S]*?dataset = "manhali_analytics_sandbox"/,
    );
    expect(sandbox).toMatch(
      /ANALYTICS_DATASET\s*=\s*"manhali_analytics_sandbox"/,
    );

    expect(production).toMatch(/head_sampling_rate\s*=\s*0\.05/);
    expect(production).toMatch(/\[observability\.logs\][\s\S]*?head_sampling_rate\s*=\s*0\.05/);
    expect(production).toMatch(/invocation_logs\s*=\s*false/);
    expect(production).toMatch(/name\s*=\s*"COLLECT_RATE_LIMIT"/);
    expect(production).toMatch(/namespace_id\s*=\s*"1101"/);
    expect(production).toMatch(/simple\s*=\s*\{\s*limit\s*=\s*120,\s*period\s*=\s*60\s*\}/);
    expect(production).toMatch(/name\s*=\s*"SITE_COLLECT_RATE_LIMIT"/);
    expect(production).toMatch(/namespace_id\s*=\s*"1102"/);
    expect(production).toMatch(/name\s*=\s*"QUERY_RATE_LIMIT"/);
    expect(production).toMatch(/namespace_id\s*=\s*"1103"/);
    expect(sandbox).toMatch(/head_sampling_rate\s*=\s*0\.1/);
    expect(sandbox).toMatch(/\[env\.sandbox\.observability\.logs\][\s\S]*?head_sampling_rate\s*=\s*0\.1/);
    expect(sandbox).toMatch(/invocation_logs\s*=\s*false/);
    expect(sandbox).toMatch(/name\s*=\s*"COLLECT_RATE_LIMIT"/);
    expect(sandbox).toMatch(/namespace_id\s*=\s*"2101"/);
    expect(sandbox).toMatch(/name\s*=\s*"SITE_COLLECT_RATE_LIMIT"/);
    expect(sandbox).toMatch(/namespace_id\s*=\s*"2102"/);
    expect(sandbox).toMatch(/name\s*=\s*"QUERY_RATE_LIMIT"/);
    expect(sandbox).toMatch(/namespace_id\s*=\s*"2103"/);
    expect(production).toMatch(/\[limits\][\s\S]*?cpu_ms\s*=\s*500/);
    expect(sandbox).toMatch(/\[env\.sandbox\.limits\]/);
    expect(sandbox).not.toMatch(/cpu_ms\s*=/);
  });

  it("query.ts does not hardcode FROM manhali_analytics in SQL strings", () => {
    const source = readFileSync(querySourcePath, "utf8");
    expect(source).not.toMatch(/FROM\s+manhali_analytics\s*$/m);
    expect(source).toMatch(/ANALYTICS_DATASET/);
  });

  it("dashboard sections fan-out is one cacheable round trip per tenant window", async () => {
    clearDashboardSectionsCache();
    const env = createQueryEnv(SANDBOX_DATASET);
    const captured = captureSql(env);

    const first = await getDashboardSections(env, "tenant_sections", 7, 10);
    expect(captured.sql).toHaveLength(5);
    expect(first.errors).toEqual({
      pages: false,
      referrers: false,
      geo: false,
      devices: false,
      events: false,
    });
    for (const sql of captured.sql) {
      expect(sql).toMatch(fromClause(SANDBOX_DATASET));
    }

    const second = await getDashboardSections(env, "tenant_sections", 7, 10);
    expect(captured.sql).toHaveLength(5);
    expect(second.errors).toEqual(first.errors);

    captured.restore();
    clearDashboardSectionsCache();
  });

  it("getOverview is one SQL with unique visitors and avg time, not top pages", async () => {
    const env = createQueryEnv(SANDBOX_DATASET);
    const captured = captureSql(env);

    const overview = await getOverview(env, "tenant_overview", 30);

    captured.restore();
    expect(captured.sql).toHaveLength(1);
    expect(captured.sql[0]).toMatch(/unique_visitors/);
    expect(captured.sql[0]).toMatch(/avg_time_on_page/);
    expect(captured.sql[0]).toMatch(
      /SUM\(if\(blob11 = 'beacon', double2 \* _sample_interval, 0\)\)\s*\/\s*SUM\(if\(blob11 = 'beacon', _sample_interval, 0\)\)/,
    );
    expect(captured.sql[0]).not.toMatch(/AVG\(if\(blob11 = 'beacon'/);
    expect(captured.sql[0]).not.toMatch(/GROUP BY page_path/);
    expect(overview.topPages).toEqual([]);
  });

  it("coalesces concurrent cold queries for the same tenant window", async () => {
    const env = createQueryEnv(SANDBOX_DATASET);
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sql: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sql.push(String(init?.body ?? ""));
      markStarted();
      await gate;
      return emptyEngineResponse();
    }) as typeof fetch;

    const first = getOverview(env, "tenant_coalesced", 7);
    const second = getOverview(env, "tenant_coalesced", 7);
    await started;
    try {
      expect(sql).toHaveLength(1);
    } finally {
      release();
    }
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(sql).toHaveLength(1);
  });

  it("Cache API serves a second overview after isolate L1 is cleared", async () => {
    installMemoryCaches();
    const env = createQueryEnv(SANDBOX_DATASET);
    const captured = captureSql(env);

    const first = await getOverview(env, "tenant_cache", 7);
    expect(captured.sql).toHaveLength(1);
    expect(first.uniqueVisitors).toBe(0);

    clearAnalyticsQueryCache();
    const second = await getOverview(env, "tenant_cache", 7);
    expect(captured.sql).toHaveLength(1);
    expect(second).toEqual(first);

    captured.restore();
  });

  it("Cache API serves a second realtime and sections after isolate L1 is cleared", async () => {
    installMemoryCaches();
    const env = createQueryEnv(SANDBOX_DATASET);
    const captured = captureSql(env);

    await getRealtime(env, "tenant_rt");
    await getDashboardSections(env, "tenant_sec", 7, 10);
    const billed = captured.sql.length;
    expect(billed).toBe(2 + 5);

    clearAnalyticsQueryCache();
    await getRealtime(env, "tenant_rt");
    await getDashboardSections(env, "tenant_sec", 7, 10);
    expect(captured.sql).toHaveLength(billed);

    captured.restore();
  });
});
