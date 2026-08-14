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
import { getRealtime, getTopPages } from "../src/lib/query.ts";

const PRODUCTION_DATASET = "manhali_analytics";
const SANDBOX_DATASET = "manhali_analytics_sandbox";
const PRODUCTION_ACCOUNT_ID = "53fb41ede04e54b276ce3fd9bfd270b6";
const SANDBOX_ACCOUNT_ID = "a793ff57a25dfe6874a8738f9addd295";
const PRODUCTION_ROUTE = "analytics.worker.manhali.com";

const wranglerPath = join(import.meta.dir, "../wrangler.toml");
const querySourcePath = join(import.meta.dir, "../src/lib/query.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    AUTH_TOKEN: "admin-secret",
    CF_API_TOKEN: "cf-secret",
    FINGERPRINT_SECRET: "fingerprint-secret",
    ACCOUNT_ID: SANDBOX_ACCOUNT_ID,
    ENVIRONMENT: "staging",
    ALLOW_UNREGISTERED_DOMAINS: "true",
    ...(dataset !== undefined ? { ANALYTICS_DATASET: dataset } : {}),
  };
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
  });

  it("query.ts does not hardcode FROM manhali_analytics in SQL strings", () => {
    const source = readFileSync(querySourcePath, "utf8");
    expect(source).not.toMatch(/FROM\s+manhali_analytics\s*$/m);
    expect(source).toMatch(/ANALYTICS_DATASET/);
  });
});
