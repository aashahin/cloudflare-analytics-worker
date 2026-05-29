// ─── Analytics Worker Unit Tests ─────────────────────────────────────────────
// Tests for pure utility functions: bot filtering, fingerprinting, SQL escaping,
// rate limiting logic, input validation, device parsing, and referrer cleaning.

import { describe, expect, it } from "bun:test";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import {
  createScopedToken,
  verifyAuth,
  verifyIngestAuth,
} from "../src/lib/auth.ts";
import { isBot } from "../src/lib/bot-filter.ts";
import { generateVisitorHash } from "../src/lib/fingerprint.ts";
import { escapeSql } from "../src/lib/query.ts";
import { parseDomainList } from "../src/lib/tenant.ts";
import { cleanReferrer, parseDeviceType } from "../src/lib/ua-parser.ts";
import { extractHostname } from "../src/lib/utils.ts";
import { getTrackerScript } from "../src/tracker/script.ts";

// ─── Bot Filter ──────────────────────────────────────────────────────────────

describe("isBot", () => {
  it("detects common search engine bots", () => {
    expect(isBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("Mozilla/5.0 (compatible; Bingbot/2.0)")).toBe(true);
    expect(isBot("Mozilla/5.0 (compatible; YandexBot/3.0)")).toBe(true);
    expect(isBot("DuckDuckBot/1.0")).toBe(true);
  });

  it("detects social media crawlers", () => {
    expect(isBot("facebookexternalhit/1.1")).toBe(true);
    expect(isBot("Twitterbot/1.0")).toBe(true);
    expect(isBot("LinkedInBot/1.0")).toBe(true);
    expect(isBot("WhatsApp/2.21")).toBe(true);
    expect(isBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isBot("Discordbot/2.0")).toBe(true);
  });

  it("detects headless browsers and automation tools", () => {
    expect(isBot("HeadlessChrome/90.0")).toBe(true);
    expect(isBot("Mozilla/5.0 PhantomJS/2.1")).toBe(true);
    expect(isBot("Mozilla/5.0 Selenium/4.0")).toBe(true);
    expect(isBot("Puppeteer/10.0")).toBe(true);
    expect(isBot("Playwright/1.20")).toBe(true);
  });

  it("detects HTTP libraries", () => {
    expect(isBot("curl/7.68.0")).toBe(true);
    expect(isBot("python-requests/2.25.1")).toBe(true);
    expect(isBot("axios/0.21.1")).toBe(true);
    expect(isBot("node-fetch/1.0")).toBe(true);
    expect(isBot("Go-http-client/2.0")).toBe(true);
    expect(isBot("wget/1.21")).toBe(true);
  });

  it("detects SEO crawlers", () => {
    expect(isBot("AhrefsBot/7.0")).toBe(true);
    expect(isBot("SemrushBot/7~bl")).toBe(true);
    expect(isBot("Screaming Frog SEO Spider")).toBe(true);
  });

  it("detects AI bots", () => {
    expect(isBot("GPTBot/1.0")).toBe(true);
    expect(isBot("ClaudeBot/1.0")).toBe(true);
    expect(isBot("Amazonbot/0.1")).toBe(true);
    expect(isBot("PerplexityBot/1.0")).toBe(true);
    expect(isBot("CCBot/2.0")).toBe(true);
  });

  it("rejects empty or very short UAs", () => {
    expect(isBot("")).toBe(true);
    expect(isBot("short")).toBe(true);
    expect(isBot("ab")).toBe(true);
  });

  it("allows real browser UAs", () => {
    expect(
      isBot(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isBot(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ),
    ).toBe(false);
    expect(
      isBot(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isBot(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
  });
});

// ─── Fingerprint ─────────────────────────────────────────────────────────────

describe("generateVisitorHash", () => {
  const DAY = "2026-01-01";

  it("generates a 64-char hex string (SHA-256)", async () => {
    const hash = await generateVisitorHash(
      "tenant",
      "1.2.3.4",
      "Mozilla/5.0",
      DAY,
      "secret",
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent output for same inputs", async () => {
    const a = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", DAY, "secret");
    const b = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", DAY, "secret");
    expect(a).toBe(b);
  });

  it("produces different hashes for different IPs", async () => {
    const a = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", DAY, "secret");
    const b = await generateVisitorHash("tenant", "5.6.7.8", "Mozilla/5.0", DAY, "secret");
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different secrets", async () => {
    const a = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", DAY, "secret1");
    const b = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", DAY, "secret2");
    expect(a).not.toBe(b);
  });

  it("is tenant-scoped: same visitor differs across tenants", async () => {
    const a = await generateVisitorHash("tenantA", "1.2.3.4", "Mozilla/5.0", DAY, "secret");
    const b = await generateVisitorHash("tenantB", "1.2.3.4", "Mozilla/5.0", DAY, "secret");
    expect(a).not.toBe(b);
  });

  it("rotates daily: same visitor differs across UTC days", async () => {
    const a = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", "2026-01-01", "secret");
    const b = await generateVisitorHash("tenant", "1.2.3.4", "Mozilla/5.0", "2026-01-02", "secret");
    expect(a).not.toBe(b);
  });
});

// ─── SQL Escaping ────────────────────────────────────────────────────────────

describe("escapeSql", () => {
  it("escapes single quotes by doubling", () => {
    expect(escapeSql("O'Reilly")).toBe("O''Reilly");
  });

  it("escapes backslashes", () => {
    expect(escapeSql("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("strips null bytes and control characters", () => {
    expect(escapeSql("hello\0world")).toBe("helloworld");
    expect(escapeSql("line\nnew")).toBe("linenew");
    expect(escapeSql("tab\there")).toBe("tabhere");
  });

  it("handles SQL injection attempts", () => {
    const result = escapeSql("' OR 1=1 --");
    expect(result).toBe("'' OR 1=1 --");
    // When placed in SQL: WHERE blob1 = ''' OR 1=1 --' — safe because quote is doubled
  });

  it("handles empty string", () => {
    expect(escapeSql("")).toBe("");
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeSql("tenant_123")).toBe("tenant_123");
    expect(escapeSql("my-site-id")).toBe("my-site-id");
  });

  it("handles combined attack patterns", () => {
    const result = escapeSql("'; DROP TABLE manhali_analytics; --");
    expect(result).toBe("''; DROP TABLE manhali_analytics; --");
  });
});

// ─── Device Type Parser ──────────────────────────────────────────────────────

describe("parseDeviceType", () => {
  it("detects desktop browsers", () => {
    expect(
      parseDeviceType(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("Desktop");
    expect(
      parseDeviceType(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      ),
    ).toBe("Desktop");
  });

  it("detects mobile devices", () => {
    expect(
      parseDeviceType(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Mobile");
    expect(
      parseDeviceType(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      ),
    ).toBe("Mobile");
  });

  it("detects tablets", () => {
    expect(
      parseDeviceType(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
      ),
    ).toBe("Tablet");
    // Android tablet (no "Mobile" in UA)
    expect(
      parseDeviceType(
        "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      ),
    ).toBe("Tablet");
  });
});

// ─── Referrer Cleaning ───────────────────────────────────────────────────────

describe("cleanReferrer", () => {
  it("returns hostname from valid referrer", () => {
    expect(
      cleanReferrer("https://google.com/search?q=test", "example.com"),
    ).toBe("google.com");
  });

  it("filters out same-site referrers", () => {
    expect(cleanReferrer("https://example.com/page", "example.com")).toBe("");
  });

  it("returns empty for null referrer", () => {
    expect(cleanReferrer(null, "example.com")).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(cleanReferrer("", "example.com")).toBe("");
  });

  it("returns empty for invalid URL", () => {
    expect(cleanReferrer("not-a-url", "example.com")).toBe("");
  });
});

// ─── URL Hostname Extraction ─────────────────────────────────────────────────

describe("extractHostname", () => {
  it("extracts hostname from URL", () => {
    expect(extractHostname("https://example.com/path")).toBe("example.com");
  });

  it("returns null for null input", () => {
    expect(extractHostname(null)).toBeNull();
  });

  it("returns null for invalid URL", () => {
    expect(extractHostname("not a url")).toBeNull();
  });

  it("extracts hostname with port", () => {
    expect(extractHostname("http://localhost:3000")).toBe("localhost");
  });
});

// ─── Domain List Parsing ─────────────────────────────────────────────────────

describe("parseDomainList", () => {
  it("parses valid domain arrays", () => {
    expect(parseDomainList(JSON.stringify(["example.com"]))).toEqual([
      "example.com",
    ]);
  });

  it("normalizes domains before caching or comparing", () => {
    expect(
      parseDomainList(JSON.stringify(["Example.COM", "www.Example.com."])),
    ).toEqual(["example.com", "www.example.com"]);
  });

  it("treats missing or malformed KV values as unregistered", () => {
    expect(parseDomainList(null)).toBeNull();
    expect(parseDomainList("not json")).toBeNull();
    expect(parseDomainList(JSON.stringify({ domain: "example.com" }))).toBeNull();
    expect(parseDomainList(JSON.stringify(["example.com", 123]))).toBeNull();
  });
});

// ─── Auth Guards ──────────────────────────────────────────────────────────────

describe("auth guards", () => {
  it("rejects blank bearer tokens before comparing secrets", async () => {
    const env = createMockEnv([]);
    const request = new Request("https://analytics.example.com/api/overview", {
      headers: { Authorization: "Bearer " },
    });

    await expect(verifyAuth(request, env)).resolves.toEqual({
      authenticated: false,
    });
    expect(verifyIngestAuth(request, env)).toBe(false);
  });

  it("fails closed when AUTH_TOKEN is empty", async () => {
    const env = { ...createMockEnv([]), AUTH_TOKEN: "" };
    const request = new Request("https://analytics.example.com/api/overview", {
      headers: { Authorization: "Bearer admin-secret" },
    });

    await expect(verifyAuth(request, env)).resolves.toEqual({
      authenticated: false,
    });
    expect(verifyIngestAuth(request, env)).toBe(false);
  });
});

// ─── Scoped Tokens (HMAC) ─────────────────────────────────────────────────────

describe("scoped tokens", () => {
  function bearer(token: string): Request {
    return new Request("https://analytics.example.com/api/overview", {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("mints a token that verifyAuth resolves to the correct tenant scope", async () => {
    const env = createMockEnv([]);
    const token = await createScopedToken(env.AUTH_TOKEN, "tenant_42", 3600);
    await expect(verifyAuth(bearer(token), env)).resolves.toEqual({
      authenticated: true,
      tenantScope: "tenant_42",
    });
  });

  it("rejects an expired token", async () => {
    const env = createMockEnv([]);
    const token = await createScopedToken(env.AUTH_TOKEN, "tenant_42", -100);
    await expect(verifyAuth(bearer(token), env)).resolves.toEqual({
      authenticated: false,
    });
  });

  it("rejects a token with a tampered HMAC", async () => {
    const env = createMockEnv([]);
    const token = await createScopedToken(env.AUTH_TOKEN, "tenant_42", 3600);
    const flipped = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    await expect(verifyAuth(bearer(flipped), env)).resolves.toEqual({
      authenticated: false,
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const env = createMockEnv([]);
    const token = await createScopedToken("some-other-secret", "tenant_42", 3600);
    await expect(verifyAuth(bearer(token), env)).resolves.toEqual({
      authenticated: false,
    });
  });

  it("round-trips a tenant ID containing colons", async () => {
    const env = createMockEnv([]);
    const token = await createScopedToken(env.AUTH_TOKEN, "org:team:1", 3600);
    await expect(verifyAuth(bearer(token), env)).resolves.toEqual({
      authenticated: true,
      tenantScope: "org:team:1",
    });
  });
});

// ─── Collect Endpoint ────────────────────────────────────────────────────────

describe("collect endpoint", () => {
  it("rejects malformed payloads without throwing", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints);

    const response = await worker.fetch(
      new Request("https://analytics.example.com/api/collect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          "User-Agent": browserUa,
        },
        body: JSON.stringify({ t: "pageview", p: 123, sid: "tenant_1" }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(dataPoints).toHaveLength(0);
  });

  it("rejects oversized collect bodies", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints);

    const response = await worker.fetch(
      new Request("https://analytics.example.com/api/collect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
          "User-Agent": browserUa,
        },
        body: "x".repeat(65_537),
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(dataPoints).toHaveLength(0);
  });

  it("accepts geo overrides only after verified ingest auth", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints);

    const response = await worker.fetch(
      new Request("https://analytics.example.com/api/collect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong",
          Origin: "https://example.com",
          "User-Agent": browserUa,
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({
          t: "pageview",
          p: "/",
          sid: "tenant_1",
          tid: "tenant_1",
          co: "EG",
          ci: "Cairo",
        }),
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0]?.indexes?.[0]).toBe("tenant_1");
    expect(dataPoints[0]?.blobs?.[3]).toBe("XX");
    expect(dataPoints[0]?.blobs?.[4]).toBe("");
  });

  it("rejects production browser collection when the tenant has no registered domains", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints, { domains: null });

    const response = await worker.fetch(
      new Request("https://analytics.example.com/api/collect", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          Origin: "https://example.com",
          "User-Agent": browserUa,
        },
        body: JSON.stringify({
          t: "pageview",
          p: "/",
          sid: "tenant_without_domains",
        }),
      }),
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "No domains registered for this site",
    });
    expect(dataPoints).toHaveLength(0);
  });

  it("accepts text/plain browser beacons for registered tenant domains", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints);

    const response = await worker.fetch(
      new Request("https://analytics.example.com/api/collect", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          Origin: "https://example.com",
          "User-Agent": browserUa,
        },
        body: JSON.stringify({ t: "pageview", p: "/", sid: "tenant_1" }),
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0]?.indexes?.[0]).toBe("tenant_1");
  });
});

describe("tracker script", () => {
  it("falls back when sendBeacon cannot queue a collect request", () => {
    const script = getTrackerScript("https://analytics.example.com/api/collect", "tenant_1");

    expect(script).toContain("navigator.sendBeacon&&navigator.sendBeacon(e,b)");
    expect(script).toContain("keepalive:true");
    expect(script).toContain("\"Content-Type\":\"text/plain;charset=UTF-8\"");
  });
});

// ─── Domain Allowlist Enforcement (collect) ──────────────────────────────────

describe("domain allowlist on collect", () => {
  // Each test uses a unique sid so the module-level per-isolate domain cache
  // (keyed by sid) never leaks a previous test's allowlist into this one.
  function collect(
    env: Env,
    origin: string,
    sid: string,
  ): Promise<Response> {
    return worker.fetch(
      new Request("https://analytics.example.com/api/collect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "User-Agent": browserUa,
        },
        body: JSON.stringify({ t: "pageview", p: "/", sid }),
      }),
      env,
    );
  }

  it("rejects an origin not in the tenant's allowlist", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints, { domains: ["example.com"] });
    const res = await collect(env, "https://evil.com", "reject_tenant");
    expect(res.status).toBe(400);
    expect(dataPoints).toHaveLength(0);
  });

  it("rejects a site with no registered domains by default", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints, { domains: null });
    const res = await collect(env, "https://example.com", "noreg_tenant");
    expect(res.status).toBe(400);
    expect(dataPoints).toHaveLength(0);
  });

  it("allows an unregistered site only when ALLOW_UNREGISTERED_DOMAINS=true", async () => {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const env = createMockEnv(dataPoints, {
      domains: null,
      allowUnregistered: "true",
    });
    const res = await collect(env, "https://example.com", "grace_tenant");
    expect(res.status).toBe(204);
    expect(dataPoints).toHaveLength(1);
  });
});

const browserUa =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface MockEnvOptions {
  /** Allowlist returned by the mock KV. `null` = no KV entry (unregistered). */
  domains?: string[] | null;
  allowUnregistered?: string;
}

function createMockEnv(
  dataPoints: AnalyticsEngineDataPoint[],
  opts: MockEnvOptions = {},
): Env {
  const domainsValue = opts.domains === undefined ? ["example.com"] : opts.domains;
  const domainsKv = {
    get: async () =>
      domainsValue === null ? null : JSON.stringify(domainsValue),
  } as KVNamespace;

  return {
    ANALYTICS: {
      writeDataPoint(event?: AnalyticsEngineDataPoint): void {
        dataPoints.push(event ?? {});
      },
    },
    DOMAINS_KV: domainsKv,
    AUTH_TOKEN: "admin-secret",
    CF_API_TOKEN: "cf-secret",
    FINGERPRINT_SECRET: "fingerprint-secret",
    INGEST_TOKEN: "ingest-secret",
    ACCOUNT_ID: "account",
    ENVIRONMENT: "production",
    ALLOW_UNREGISTERED_DOMAINS: opts.allowUnregistered ?? "false",
  };
}
