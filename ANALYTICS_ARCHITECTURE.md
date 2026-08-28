# Analytics Architecture & Data Flow

This document describes the runtime architecture, ingestion flow, auth model, and storage layout of the Manhali Analytics Worker.

## Overview

The worker has four responsibilities:

1. **Serve the tracker** from `GET /tracker.js?sid=...`
2. **Ingest events** from browsers and server-to-server callers at `POST /api/collect`
3. **Query Analytics Engine** for dashboard endpoints under `/api/*`
4. **Manage tenant access** with domain allowlists and tenant-scoped tokens under `/api/admin/*`

The storage model is intentionally small:

- **Cloudflare Analytics Engine**: sole analytics event store and query source
- **Cloudflare KV**: per-tenant domain allowlist for browser-origin validation

There is no D1 or other persistent application database in this worker.

---

## End-to-End Data Flow

### Browser tracking

1. A tenant page loads `<script src="/tracker.js?sid=TENANT_ID" defer></script>`.
2. The worker returns a parameterized tracker script with the collect endpoint and the embedded site ID.
3. The tracker sends `POST /api/collect` for:

- initial pageviews
- SPA route changes
- custom events via `window.manhali.track(name)`
- time-on-page beacons on `visibilitychange` and `pagehide`

4. The worker validates payload size and JSON, resolves the tenant, filters bots, builds request metadata, then writes to Analytics Engine.

### Server-to-server tracking

1. A trusted backend sends `POST /api/collect` with `tid` and `Authorization: Bearer ...`.
2. The worker verifies the token using `INGEST_TOKEN` when present, otherwise `AUTH_TOKEN`.
3. The worker trusts `tid` after format validation and may accept geo overrides through `co` and `ci`.
4. The event is normalized and written to Analytics Engine like a browser event.

### Dashboard querying

1. The platform calls `GET /api/*?tenant_id=...` with a Bearer token.
2. The worker verifies either:

- the admin `AUTH_TOKEN`, or
- a tenant-scoped HMAC token minted by `/api/admin/token`

3. The worker executes Cloudflare Analytics Engine SQL queries.
4. Query responses are returned as JSON with private CORS headers.

### Admin operations

1. Admin callers use the admin `AUTH_TOKEN`.
2. `/api/admin/domains` reads or updates the KV allowlist.
3. `/api/admin/token` mints a tenant-scoped HMAC token without storing anything in KV.

---

## Runtime Surface

### Public routes

- `GET /health`
- `GET /tracker.js?sid=SITE_ID`
- `POST /api/collect`

### Authenticated query routes

- `GET /api/overview`
- `GET /api/pages`
- `GET /api/referrers`
- `GET /api/geo`
- `GET /api/devices`
- `GET /api/realtime`
- `GET /api/events`
- `GET /api/sections`

All query routes require `tenant_id`, except that `/api/realtime` only needs `tenant_id` and no extra filters.

### Admin routes

- `GET /api/admin/domains?tenant_id=...`
- `POST /api/admin/domains?tenant_id=...`
- `DELETE /api/admin/domains?tenant_id=...`
- `POST /api/admin/token`

Scoped tenant tokens are allowed on query routes and rejected on admin routes.

---

## Analytics Engine Schema

### Blob slots

| Slot     | Field          | Description                                                           |
| -------- | -------------- | --------------------------------------------------------------------- |
| `blob1`  | `tenant_id`    | Tenant identifier and AE index                                        |
| `blob2`  | `page_path`    | Sanitized URL path                                                    |
| `blob3`  | `visitor_hash` | Tenant-scoped, daily-rotating privacy-safe visitor hash               |
| `blob4`  | `country`      | Cloudflare country, optionally overridden for server-to-server ingest |
| `blob5`  | `city`         | Cloudflare city, optionally overridden for server-to-server ingest    |
| `blob6`  | `device_type`  | `Desktop`, `Mobile`, or `Tablet`                                      |
| `blob7`  | `referrer`     | Cleaned external referrer hostname                                    |
| `blob8`  | `utm_source`   | UTM source                                                            |
| `blob9`  | `utm_medium`   | UTM medium                                                            |
| `blob10` | `utm_campaign` | UTM campaign                                                          |
| `blob11` | `event_type`   | `pageview`, `beacon`, or `event`                                      |
| `blob12` | `event_name`   | Custom event name                                                     |

### Double slots

| Slot      | Field          | Description                            |
| --------- | -------------- | -------------------------------------- |
| `double1` | `page_view`    | `1` for pageview events, `0` otherwise |
| `double2` | `time_on_page` | Beacon duration in seconds             |

### Why queries use `SUM(_sample_interval)`

Analytics Engine may sample high-volume datasets. `SUM(_sample_interval)` reconstructs weighted totals for views and event counts. Raw `COUNT(*)` would undercount sampled traffic.

---

## Tenant Resolution

The collect endpoint resolves tenants in this order:

1. **Trusted server-to-server**

- Requires `body.tid`
- Requires valid Bearer auth via `INGEST_TOKEN` or `AUTH_TOKEN`

2. **Browser tracker request**

- Uses `body.sid`
- Validates site ID format before any KV lookup
- In production, checks the request `Origin` or `Referer` hostname against `domains:{siteId}` in KV

3. **Development fallback**

- When `ENVIRONMENT=development`, the origin hostname becomes the tenant ID

### Domain allowlist behavior

KV values are stored as JSON arrays:

```text
domains:tenant_123 -> ["example.com", "www.example.com"]
```

The worker keeps successful lookups in a 256-entry LRU for five minutes per
isolate. Missing/malformed entries use a separate 64-entry, 30-second negative
LRU, so random valid unknown site IDs cannot evict known tenants. KV edge-cache
TTL is 60 seconds. The site/origin limiter is checked before this lookup.

If a production site has no registered domains:

- default behavior: reject browser collect requests
- optional grace period: allow requests only when `ALLOW_UNREGISTERED_DOMAINS="true"`

Admin mutations call `invalidateDomainCache`, but that only clears the cache on
the single isolate that served the admin request. Other warm isolates across the
edge keep their cached allowlist until their own five-minute TTL expires, so
domain adds and removals are **eventually consistent within ~5 minutes**, not
globally immediate. This matters most on removal: a de-authorized origin can keep
being accepted on other warm isolates for up to the TTL window. Lower
`DOMAIN_CACHE_TTL_MS` if a shorter propagation window is required.

---

## Authentication Model

### Admin token

- Stored in `AUTH_TOKEN`
- Grants access to all query routes and all admin routes
- Also acts as the signing secret for tenant-scoped HMAC tokens

### Tenant-scoped query token

- Minted by `POST /api/admin/token`
- Format: `scoped:{tenant_id}:{expiry_unix}:{hmac}`
- Verified cryptographically in the worker
- Can only query its own tenant
- Cannot call `/api/admin/*`

### Server-to-server ingest token

- Uses `INGEST_TOKEN` when configured
- Falls back to `AUTH_TOKEN` otherwise
- Only affects trusted `POST /api/collect` ingestion using `tid`

### Auth hardening

- Constant-time comparison for token checks
- Tenant IDs validated before SQL use or KV access
- Scoped tokens enforce expiry before query execution

---

## Ingestion Pipeline

For every accepted collect request the worker performs:

1. Body read with a streaming 64 KB size cap
2. JSON parse and required field validation for `t` and `p`
3. Tenant resolution
4. Event normalization:

- `beacon` duration clamped to `0..3600`
- event names sanitized and capped at 100 chars
- page paths sanitized

5. Bot filtering using the request User-Agent
6. Visitor hash generation using tenant ID + IP + UA + current UTC day + `FINGERPRINT_SECRET` (tenant-scoped so the same visitor cannot be correlated across tenants; rotates daily)
7. Geo, device, referrer, and UTM extraction
8. `env.ANALYTICS.writeDataPoint()` fire-and-forget write

The worker returns `204 No Content` for successful collect requests.

---

## Query Pipeline

`src/lib/query.ts` contains the pre-built Analytics Engine SQL queries for:

- slim overview totals (views, unique visitors, avg time-on-page) in one SQL
- page rankings
- referrers and UTM sources
- geographic breakdown
- device breakdown
- realtime visitors
- custom events
- batched dashboard sections

Overview, realtime, and sections results are cached 60s (bounded isolate Map L1 + Workers Cache API) so dashboard polls do not re-bill Analytics Engine SQL. `/api/sections` still needs five exact grouped queries: Analytics Engine does not support `UNION`/`JOIN`, and combining the dimensions into one bounded result would silently truncate or approximate per-section counts. The longer shared cache, canonical parameter buckets, in-flight coalescing, and query quota bound that unavoidable fan-out.

Visitor counts returned as `uniqueVisitors` are unique daily visitors. The underlying visitor hash intentionally rotates every UTC day, so these values should not be interpreted as a cross-day person count.

The query layer validates `tenantId` before embedding it into SQL and escapes single quotes because Analytics Engine SQL is not parameterized.

---

## Security And Privacy

### Bot filtering

- Free-tier User-Agent regex matching for common crawlers, headless browsers, HTTP clients, SEO bots, and AI bots
- Empty or very short User-Agent strings are rejected

### CORS

- Public routes return `Access-Control-Allow-Origin: *`
- Authenticated routes echo the request origin with `Vary: Origin`
- Preflight responses include a 24-hour `Access-Control-Max-Age`

### Input validation

- `days` canonicalized to `1`, `7`, `30`, or `90`
- `limit` canonicalized to `10`, `20`, `50`, or `100`
- hostnames validated before domain writes
- country overrides limited to two uppercase letters

### Privacy guarantees

- No cookies
- No localStorage
- No client-side fingerprinting
- Visitor identity rotates daily, preventing cross-day tracking

`POST /api/collect` is rate-limited in-worker, per Cloudflare location, at 120
events/minute per `CF-Connecting-IP` and 1,200 events/minute per site plus per
origin. The first threshold allows 60 complete pageview+beacon lifecycles per
minute; the second caps 600 lifecycles and runs before domain KV. Authenticated
server-to-server ingest skips both public limits. Authenticated query routes
have separate 60 requests/minute/location counters for a SHA-256-derived token
subject and for its tenant/token pair, so changing tenant IDs cannot evade the
token-wide cap. All three bindings fail closed outside local development;
exceeded limits return `429` with the appropriate CORS policy.

---

## Tracker Behavior

The generated tracker script is intentionally small and framework-agnostic.

### Automatic events

| Event      | Trigger                           | Notes                                                       |
| ---------- | --------------------------------- | ----------------------------------------------------------- |
| `pageview` | initial load                      | Includes `document.referrer` and UTM params                 |
| `beacon`   | `visibilitychange` and `pagehide` | Sends time-on-page in seconds                               |
| `pageview` | SPA navigation                    | Hooks `pushState`, `replaceState`, and `popstate` (History API) |
| `event`    | `window.manhali.track(name)`      | Sends custom event names                                    |

### Exposed browser API

- `window.manhali.track(name)`
- `window.manhali.pageview()`

### Transport

- Primary: `navigator.sendBeacon()`
- Fallback: `XMLHttpRequest`

### Response caching

The tracker response is cached with:

```text
Cache-Control: public, max-age=3600, stale-while-revalidate=86400
```

---

## File Map

```text
src/
├── index.ts              Main worker router and collect handler
├── env.ts                Typed Cloudflare env bindings
├── lib/
│   ├── auth.ts           Admin auth, scoped tokens, ingest auth
│   ├── bot-filter.ts     Free-tier bot detection
│   ├── cors.ts           Public/private CORS helpers
│   ├── fingerprint.ts    Daily visitor hash generation
│   ├── ingest.ts         Analytics Engine write path
│   ├── query.ts          Analytics Engine SQL query functions
│   ├── schema.ts         Blob/double slot mapping and response types
│   ├── tenant.ts         Tenant resolution and domain cache
│   ├── ua-parser.ts      Device and referrer parsing
│   └── utils.ts          Shared validation and sanitization helpers
├── routes/
│   └── admin.ts          Domain management and scoped-token minting
└── tracker/
   └── script.ts         Parameterized tracker script generator
```

---

## Known Limitations

### 90-day retention

Analytics Engine retains data for 90 days, so historical queries beyond that window are not available even if callers request longer periods.

### Sampling impact on unique daily visitors

Weighted totals are corrected via `_sample_interval`, but `COUNT(DISTINCT blob3)` still reflects Analytics Engine's sampled dataset under very high traffic volumes. `blob3` rotates daily by design, so multi-day queries report unique daily visitors rather than cross-day identity.

### Non-parameterized SQL API

Analytics Engine SQL cannot use bind parameters. Tenant IDs are validated and SQL-escaped before query execution.

---

## Quick Commands

```bash
# Local dev
bun run dev

# Test
bun run test

# Deploy
bun run deploy

# Tail logs
bun run tail

# Secrets
wrangler secret put AUTH_TOKEN
wrangler secret put CF_API_TOKEN
wrangler secret put FINGERPRINT_SECRET
wrangler secret put INGEST_TOKEN

# KV namespace
wrangler kv namespace create DOMAINS_KV
```
