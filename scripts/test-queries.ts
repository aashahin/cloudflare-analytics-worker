#!/usr/bin/env bun
// ─── Analytics API Queries Test Script ───────────────────────────────────────
// Tests the Cloudflare Analytics Worker GET routes for tenant "shahin".
//
// Usage:
//   bun run scripts/test-queries.ts

const WORKER_URL =
    process.env.ANALYTICS_WORKER_URL ??
    "https://analytics.worker.manhali.com";

const AUTH_TOKEN = requireEnv("ANALYTICS_AUTH_TOKEN");

// Keep in sync with scripts/seed.ts (same default) so seeding and querying
// target the same tenant. Override both with ANALYTICS_TENANT_ID.
const TENANT_ID = process.env.ANALYTICS_TENANT_ID ?? "pddzczoc8i3c22liiyjwnwzl";

const ROUTES = [
    "/api/overview",
    "/api/pages",
    "/api/referrers",
    "/api/geo",
    "/api/devices",
    "/api/events",
];

// /api/realtime doesn't take 'days'
const REALTIME_ROUTE = "/api/realtime";

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

async function fetchRoute(route: string, params: Record<string, string>) {
    const url = new URL(`${WORKER_URL}${route}`);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
    }

    const res = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
        },
    });

    if (!res.ok) {
        const text = await res.text();
        console.error(`  ✗ ${route} failed (${res.status}): ${text}`);
        return null;
    }

    return res.json();
}

async function main() {
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║  Analytics API Test — Tenant: shahin             ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`Worker: ${WORKER_URL}`);
    console.log(`Tenant: ${TENANT_ID}`);
    console.log();

    // 1. Test Realtime Route
    console.log("─── Realtime ───────────────────────────────────────");
    const realtime = await fetchRoute(REALTIME_ROUTE, { tenant_id: TENANT_ID });
    console.log(JSON.stringify(realtime, null, 2));
    console.log();

    // 2. Test standard routes over different timeframes
    const timeframes = [7, 30, 90];

    for (const days of timeframes) {
        console.log(`\n══════════════════════════════════════════════════`);
        console.log(`                Testing Last ${days} Days`);
        console.log(`══════════════════════════════════════════════════\n`);

        for (const route of ROUTES) {
            console.log(`─── ${route}?days=${days} ─────────────────────────────`);
            const data = await fetchRoute(route, {
                tenant_id: TENANT_ID,
                days: days.toString(),
                limit: "10", // Smallest supported limit bucket, keeps output short
            });

            console.dir(data, { depth: null, colors: true });
            console.log();
        }
    }

    console.log("✓ All API tests complete!");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
