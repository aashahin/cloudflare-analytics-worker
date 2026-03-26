// ─── Analytics Worker Unit Tests ─────────────────────────────────────────────
// Tests for pure utility functions: bot filtering, fingerprinting, SQL escaping,
// rate limiting logic, input validation, device parsing, and referrer cleaning.

import { describe, expect, it } from "bun:test";
import { isBot } from "../src/lib/bot-filter.ts";
import { generateVisitorHash } from "../src/lib/fingerprint.ts";
import { escapeSql } from "../src/lib/query.ts";
import { cleanReferrer, parseDeviceType } from "../src/lib/ua-parser.ts";
import { extractHostname } from "../src/lib/utils.ts";

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
  it("generates a 64-char hex string (SHA-256)", async () => {
    const hash = await generateVisitorHash("1.2.3.4", "Mozilla/5.0", "secret");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent output for same inputs", async () => {
    const a = await generateVisitorHash("1.2.3.4", "Mozilla/5.0", "secret");
    const b = await generateVisitorHash("1.2.3.4", "Mozilla/5.0", "secret");
    expect(a).toBe(b);
  });

  it("produces different hashes for different IPs", async () => {
    const a = await generateVisitorHash("1.2.3.4", "Mozilla/5.0", "secret");
    const b = await generateVisitorHash("5.6.7.8", "Mozilla/5.0", "secret");
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different secrets", async () => {
    const a = await generateVisitorHash("1.2.3.4", "Mozilla/5.0", "secret1");
    const b = await generateVisitorHash("1.2.3.4", "Mozilla/5.0", "secret2");
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
