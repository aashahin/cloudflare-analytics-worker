#!/usr/bin/env bun
// ─── Analytics Seed Script ───────────────────────────────────────────────────
// Seeds realistic dummy analytics data for tenant "shahin" into the deployed
// Cloudflare Analytics Worker. Uses server-to-server auth (tid + Bearer token).
//
// Usage:
//   bun run scripts/seed.ts
//   ANALYTICS_WORKER_URL=https://... ANALYTICS_AUTH_TOKEN=... bun run scripts/seed.ts

const WORKER_URL =
  process.env.ANALYTICS_WORKER_URL ??
  "https://manhali-analytics.abshahin.workers.dev";

const AUTH_TOKEN =
  process.env.ANALYTICS_AUTH_TOKEN ??
  "9150c240753973aafe994450b7ef57266c89e674359bc8755c5739f343c22aaf";

const TENANT_ID = "pddzczoc8i3c22liiyjwnwzl";

// ─── Seed Data Pools ─────────────────────────────────────────────────────────

const PAGES = [
  "/",
  "/courses",
  "/courses/arabic-grammar-101",
  "/courses/quran-memorization",
  "/courses/islamic-history",
  "/courses/fiqh-basics",
  "/courses/arabic-calligraphy",
  "/blog",
  "/blog/learning-arabic-tips",
  "/blog/importance-of-quran",
  "/blog/ramadan-preparation",
  "/pricing",
  "/about",
  "/contact",
  "/dashboard",
  "/dashboard/my-courses",
  "/dashboard/progress",
  "/checkout",
];

const REFERRERS = [
  "",
  "",
  "", // direct (no referrer)
  "https://google.com/search?q=arabic+courses+online",
  "https://google.com/search?q=learn+quran+online",
  "https://google.com/search?q=islamic+studies+online",
  "https://twitter.com",
  "https://x.com",
  "https://instagram.com",
  "https://facebook.com",
  "https://linkedin.com",
  "https://t.me/manhali_channel",
  "https://youtube.com",
  "https://reddit.com/r/learn_arabic",
  "https://snapchat.com",
];

const UTM_CAMPAIGNS: Array<{
  us?: string;
  um?: string;
  uc?: string;
}> = [
    {},
    {},
    {}, // no UTM
    { us: "google", um: "cpc", uc: "spring_enrollment" },
    { us: "google", um: "organic" },
    { us: "facebook", um: "social", uc: "ramadan_campaign" },
    { us: "instagram", um: "social", uc: "ramadan_campaign" },
    { us: "email", um: "newsletter", uc: "weekly_digest" },
    { us: "twitter", um: "social" },
    { us: "youtube", um: "video", uc: "course_promo" },
  ];

const USER_AGENTS = {
  // Desktop browsers
  desktop: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  ],
  // Mobile browsers
  mobile: [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.90 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.90 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1",
  ],
  // Tablet browsers
  tablet: [
    "Mozilla/5.0 (iPad; CPU OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  ],
};

const CUSTOM_EVENTS = [
  "signup_click",
  "course_enroll",
  "lesson_complete",
  "quiz_start",
  "quiz_complete",
  "certificate_download",
  "video_play",
  "share_click",
  "trial_start",
  "upgrade_click",
];

// Arabic-speaking countries with realistic traffic weighting
const ARABIC_COUNTRIES: Array<{
  code: string;
  name: string;
  cities: string[];
  weight: number;
}> = [
    {
      code: "SA",
      name: "Saudi Arabia",
      cities: ["Riyadh", "Jeddah", "Mecca", "Medina", "Khobar", "Dammam"],
      weight: 30,
    },
    {
      code: "EG",
      name: "Egypt",
      cities: [
        "Cairo",
        "Alexandria",
        "Giza",
        "Shubra El Kheima",
        "Luxor",
        "Aswan",
      ],
      weight: 22,
    },
    {
      code: "AE",
      name: "UAE",
      cities: ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah"],
      weight: 14,
    },
    {
      code: "KW",
      name: "Kuwait",
      cities: ["Kuwait City", "Hawalli", "Salmiya", "Farwaniya"],
      weight: 7,
    },
    {
      code: "JO",
      name: "Jordan",
      cities: ["Amman", "Zarqa", "Irbid", "Aqaba"],
      weight: 6,
    },
    {
      code: "QA",
      name: "Qatar",
      cities: ["Doha", "Al Rayyan", "Al Wakrah"],
      weight: 5,
    },
    {
      code: "BH",
      name: "Bahrain",
      cities: ["Manama", "Muharraq", "Riffa"],
      weight: 4,
    },
    {
      code: "OM",
      name: "Oman",
      cities: ["Muscat", "Salalah", "Sohar", "Nizwa"],
      weight: 4,
    },
    {
      code: "IQ",
      name: "Iraq",
      cities: ["Baghdad", "Basra", "Mosul", "Erbil", "Najaf"],
      weight: 4,
    },
    {
      code: "MA",
      name: "Morocco",
      cities: ["Casablanca", "Rabat", "Fes", "Marrakech", "Agadir"],
      weight: 4,
    },
  ];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickWeighted<T>(items: Array<{ value: T; weight: number }>): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1]!.value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Event Builder ───────────────────────────────────────────────────────────

interface CollectPayload {
  t: "pageview" | "beacon" | "event";
  p: string;
  r?: string;
  d?: number;
  tid: string;
  en?: string;
  us?: string;
  um?: string;
  uc?: string;
  /** ISO 3166-1 alpha-2 country override (accepted on s2s requests) */
  co?: string;
  /** City override */
  ci?: string;
  /** Custom simulated timestamp for backdating (optional, backend might ignore in AE) */
  ts?: string;
}

function buildPageview(date?: Date): { payload: CollectPayload; ua: string } {
  const deviceType = pickWeighted([
    { value: "desktop" as const, weight: 55 },
    { value: "mobile" as const, weight: 38 },
    { value: "tablet" as const, weight: 7 },
  ]);
  const ua = pick(USER_AGENTS[deviceType]);
  const referrer = pick(REFERRERS);
  const page = pickWeighted([
    { value: "/", weight: 20 },
    { value: "/courses", weight: 18 },
    { value: pick(PAGES.filter((p) => p.startsWith("/courses/"))), weight: 25 },
    { value: pick(PAGES.filter((p) => p.startsWith("/blog"))), weight: 10 },
    { value: "/pricing", weight: 8 },
    { value: "/dashboard", weight: 7 },
    {
      value: pick(PAGES.filter((p) => p.startsWith("/dashboard/"))),
      weight: 6,
    },
    { value: pick(["/about", "/contact"]), weight: 4 },
    { value: "/checkout", weight: 2 },
  ]);
  const utms = pick(UTM_CAMPAIGNS);

  const country = pickWeighted(
    ARABIC_COUNTRIES.map((c) => ({ value: c, weight: c.weight })),
  );
  const city = pick(country.cities);

  return {
    payload: {
      t: "pageview",
      p: page,
      ...(referrer ? { r: referrer } : {}),
      tid: TENANT_ID,
      co: country.code,
      ci: city,
      ...(date ? { ts: date.toISOString() } : {}),
      ...utms,
    },
    ua,
  };
}

function buildBeacon(date?: Date): { payload: CollectPayload; ua: string } {
  const { payload, ua } = buildPageview(date);
  return {
    payload: {
      ...payload,
      t: "beacon",
      d: Math.floor(Math.random() * 300) + 10, // 10–310 seconds
    },
    ua,
  };
}

function buildEvent(date?: Date): { payload: CollectPayload; ua: string } {
  const { payload, ua } = buildPageview(date);
  return {
    payload: {
      ...payload,
      t: "event",
      en: pick(CUSTOM_EVENTS),
    },
    ua,
  };
}

// ─── Sender ───────────────────────────────────────────────────────────────────

async function sendEvent(
  payload: CollectPayload,
  ua: string,
  retries = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/api/collect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "User-Agent": ua,
          Origin: `https://shahin.manhali.com`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`  ✗ ${res.status}: ${text}`);
      } else {
        return true;
      }
    } catch (err) {
      if (attempt === retries) {
        console.error(`  ✗ Network error after ${retries} attempts:`, err);
      } else {
        // Wait briefly before retrying (exponential backoff)
        await sleep(100 * attempt);
      }
    }
  }
  return false;
}

// ─── Batch Sender ────────────────────────────────────────────────────────────

async function sendBatch(
  events: Array<{ payload: CollectPayload; ua: string }>,
  batchSize = 100,
) {
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);

    console.log(
      `\nBatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(events.length / batchSize)} — sending ${batch.length} events…`,
    );

    const promises = batch.map(({ payload, ua }) => sendEvent(payload, ua));
    const results = await Promise.all(promises);

    for (const ok of results) {
      if (ok) sent++;
      else failed++;
    }

    console.log(`  → ${sent} sent, ${failed} failed so far`);

    // Tiny 50ms pause between batches to prevent socket exhaustion
    await sleep(50);
  }

  return { sent, failed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Analytics Seed — Tenant: shahin                 ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log();

  // ── Health check ──────────────────────────────────────────────────────────
  console.log("Checking worker health…");
  try {
    const health = await fetch(`${WORKER_URL}/health`);
    const body = await health.json();
    console.log(`  ✓ Worker OK:`, body);
  } catch {
    console.error("  ✗ Worker is unreachable. Aborting.");
    process.exit(1);
  }

  // ── Build event list ──────────────────────────────────────────────────────
  const events: Array<{ payload: CollectPayload; ua: string }> = [];

  const now = new Date();
  const DAYS_TO_SEED = 90;

  // Simulate traffic trends over the last 90 days
  for (let d = DAYS_TO_SEED; d >= 0; d--) {
    const curDate = new Date(now);
    curDate.setDate(now.getDate() - d);

    // Simulate varying traffic with a slight upward trend and weekly cycles
    const baseTraffic = 50;
    const weeklyCycle = Math.sin((d / 7) * Math.PI) * 10;
    const upwardTrend = (DAYS_TO_SEED - d) * 0.2;
    const dailyPageviews = Math.floor(
      Math.max(5, baseTraffic + weeklyCycle + upwardTrend + (Math.random() * 10 - 5))
    );
    const dailyBeacons = Math.floor(dailyPageviews * (Math.random() * 0.3 + 0.2));
    const dailyEvents = Math.floor(dailyPageviews * (Math.random() * 0.2 + 0.1));

    for (let i = 0; i < dailyPageviews; i++) {
      events.push(buildPageview(curDate));
    }
    for (let i = 0; i < dailyBeacons; i++) {
      events.push(buildBeacon(curDate));
    }
    for (let i = 0; i < dailyEvents; i++) {
      events.push(buildEvent(curDate));
    }
  }

  // Shuffle
  events.sort(() => Math.random() - 0.5);

  console.log(
    `Generating ${events.length} events over 90 simulated days`,
  );
  console.log(`Sending events without rate limiting...`);
  console.log();

  const { sent, failed } = await sendBatch(events);

  console.log();
  console.log("══════════════════════════════════════════════════");
  console.log(`✓ Done!  ${sent} sent  |  ${failed} failed`);
  console.log();
  console.log();
  console.log("The data should appear in the dashboard analytics page within");
  console.log("a few seconds. Note: all events have today's real timestamp in AE,");
  console.log("unless the backend maps the `ts` payload to a custom query logic.");
  console.log('Use the "7 days" or "30 days" filter to see them.');
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
