# Analytics Worker

Privacy-first, cookie-free analytics engine for Manhali tenants. It runs on Cloudflare Workers, stores events in Analytics Engine, validates browser origins through KV, and exposes query APIs for the platform dashboard.

See `ANALYTICS_ARCHITECTURE.md` for the internal data model and flow details.

## Architecture

```
Browser ── GET /tracker.js?sid=... ───────────────→ Analytics Worker
Browser ── POST /api/collect ── writeDataPoint ─→ Analytics Engine
Backend ── POST /api/collect (Bearer + tid) ────→ Analytics Worker

Dashboard ── GET /api/* (admin/scoped token) ───→ Worker ── SQL API ──→ Analytics Engine
Admin ── /api/admin/domains , /api/admin/token ─→ Worker ── KV / HMAC ─→ DOMAINS_KV
```

**Storage**

- **Analytics Engine**: event storage and live analytics queries, with 90-day retention
- **KV (`DOMAINS_KV`)**: per-tenant domain allowlist used by browser collection

## Development

```bash
# Install dependencies
bun install

# Start local dev server
bun run dev
# → Wrangler dev (configured: http://localhost:8790)
# Copy .dev.vars.example to .dev.vars first: the checked-in vars default to
# production behavior (KV allowlist enforced, limits fail closed).

# Run tests
bun run test

# Deploy to Cloudflare (production / sandbox)
bun run deploy:production
bun run deploy:sandbox

# View real-time logs
bun run tail
```

## Setup

### 1. Create Cloudflare resources

```bash
# KV namespace for per-tenant domain allowlists
wrangler kv namespace create DOMAINS_KV
```

### 2. Update `wrangler.toml`

Set the KV namespace ID and your Cloudflare account ID.

```toml
[[kv_namespaces]]
binding = "DOMAINS_KV"
id = "your-kv-namespace-id"

[vars]
ACCOUNT_ID = "your-account-id"
ENVIRONMENT = "production"
```

Optional runtime vars:

```toml
[vars]
ALLOW_UNREGISTERED_DOMAINS = "true" # optional setup grace period for browser collect
```

### 3. Set secrets

```bash
wrangler secret put AUTH_TOKEN           # admin API token + signing secret for scoped tokens
wrangler secret put CF_API_TOKEN         # Cloudflare API token for Analytics Engine SQL queries
wrangler secret put FINGERPRINT_SECRET   # dedicated visitor-hash secret
wrangler secret put INGEST_TOKEN         # optional dedicated token for server-to-server ingestion
```

### 4. Deploy

```bash
bun run deploy:production
bun run deploy:sandbox
```

### 5. Register tenant domains

Browser-origin collection expects domains to be registered per tenant in production.
The backend syncs domains when tenants/custom domains are created or changed. For
existing production tenants, run the backfill once from `apps/backend`:

```bash
ANALYTICS_WORKER_URL=https://analytics.worker.manhali.com \
ANALYTICS_AUTH_TOKEN=YOUR_AUTH_TOKEN \
bun run sync:analytics-domains
```

```bash
curl -X POST "https://analytics.example.com/api/admin/domains?tenant_id=TENANT_ID" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domain": "tenant-site.com"}'
```

### 6. Mint scoped query tokens (optional)

Use the admin token to mint a tenant-scoped token for dashboards or internal services that should only read one tenant's analytics.

```bash
curl -X POST "https://analytics.example.com/api/admin/token" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"TENANT_ID","ttl":86400}'
```

## Client Integration

Add the tracker script to any tenant page:

```html
<script
  src="https://analytics.example.com/tracker.js?sid=TENANT_SITE_ID"
  defer
></script>
```

The tracker automatically:

- Sends a `pageview` event on initial load
- Sends a `beacon` event with time-on-page on `visibilitychange` and `pagehide`
- Tracks SPA navigation via the History API (`pushState`, `replaceState`, `popstate`)
- Re-emits a pageview when the page is restored from the back-forward cache
- Extracts UTM parameters from the page URL
- Supports custom events via `window.manhali.track("event_name")`
- Supports manual pageview dispatch via `window.manhali.pageview()`

## Endpoints

### Public

| Method | Path                      | Description                                  |
| ------ | ------------------------- | -------------------------------------------- |
| `GET`  | `/health`                 | Health check                                 |
| `GET`  | `/tracker.js?sid=SITE_ID` | Parameterized tracker script                 |
| `POST` | `/api/collect`            | Browser or server-to-server event collection |

### Query API

Query routes require `Authorization: Bearer <token>` and `?tenant_id=`.

- Admin token: unrestricted access
- Scoped token: restricted to one tenant only

| Method | Path             | Query Params                        | Description                             |
| ------ | ---------------- | ----------------------------------- | --------------------------------------- |
| `GET`  | `/api/overview`  | `days` (1/7/30/90, default 30)      | Totals and average time-on-page         |
| `GET`  | `/api/pages`     | `days`, `limit` (10/20/50/100)      | Top pages by views                      |
| `GET`  | `/api/referrers` | `days`, `limit`                     | Top referrer domains plus UTM data      |
| `GET`  | `/api/geo`       | `days`                              | Country and city breakdown              |
| `GET`  | `/api/devices`   | `days`                              | Desktop / Mobile / Tablet breakdown     |
| `GET`  | `/api/realtime`  | —                                   | Visitors active in the last 30 minutes  |
| `GET`  | `/api/events`    | `days`, `limit`                     | Custom event totals and unique daily visitors |
| `GET`  | `/api/sections`  | `days`, `limit`                     | Cached dashboard section bundle         |

Positive numeric values between supported buckets round up to the next bucket;
invalid values use the documented default. This deliberately bounds query-cache
cardinality. Query routes are also limited per Cloudflare location: scoped
tokens get 60 requests/minute each (counted per token and per tenant-and-token
pair), while the shared admin token has its own higher 240 requests/minute
namespace so one dashboard token serving every tenant is not throttled
globally. Failed authentication attempts share a 60 requests/minute per-IP
bucket in the same namespace. They fail closed outside local development when
the binding is unavailable. Each upstream Analytics Engine SQL call is capped at
10 seconds, so `/api/sections` degrades section-by-section instead of stalling.

### Admin API

Admin routes require the admin `AUTH_TOKEN`. Scoped tenant tokens are rejected.

| Method   | Path                 | Query Params | Description                              |
| -------- | -------------------- | ------------ | ---------------------------------------- |
| `GET`    | `/api/admin/domains` | `tenant_id`  | List allowed domains for a tenant        |
| `POST`   | `/api/admin/domains` | `tenant_id`  | Add domain `{"domain":"example.com"}`    |
| `DELETE` | `/api/admin/domains` | `tenant_id`  | Remove domain `{"domain":"example.com"}` |
| `POST`   | `/api/admin/token`   | —            | Create a tenant-scoped HMAC token        |

## Collect Payload

```jsonc
{
  "t": "pageview", // "pageview" | "beacon" | "event"
  "p": "/courses/intro", // page path (required)
  "r": "https://google.com", // document.referrer
  "d": 42, // duration in seconds (beacon)
  "sid": "tenant_123", // browser tracker site ID
  "tid": "tenant_123", // server-to-server tenant ID (requires Bearer auth)
  "en": "signup_click", // custom event name
  "us": "google", // utm_source
  "um": "cpc", // utm_medium
  "uc": "spring_sale", // utm_campaign
  "co": "EG", // optional country override, server-to-server only
  "ci": "Cairo", // optional city override, server-to-server only
}
```

Tenant resolution priority on collect:

1. `tid` + valid Bearer token for server-to-server ingestion
2. `sid` + allowed browser origin for tracker requests
3. Development fallback to the request origin hostname when `ENVIRONMENT=development`

`wrangler.toml` defaults to `ENVIRONMENT=production` so deployments enforce the KV domain allowlist unless you explicitly override it for local development.

> **Trust model for browser collection.** Like every client-side beacon endpoint (GA, Plausible, Fathom), `/api/collect` is unauthenticated and the `Origin`/`Referer` allowlist is only a best-effort filter — a non-browser client can spoof those headers, and the `sid` is public (it ships in `/tracker.js`). Treat browser-submitted analytics as best-effort, not tamper-proof; use the server-to-server `tid` + Bearer path for trusted data. Per Cloudflare location, the Worker enforces 300 events/minute per IP (150 complete pageview+beacon lifecycles) and 1,200 events/minute per site and origin before domain KV resolution. Rate-limit bindings are per-location and eventually consistent, so treat these as an approximate abuse bound rather than exact accounting. Authenticated server-to-server ingest skips both public limits and the UA bot filter (backend clients legitimately send library user agents such as `undici` or `curl`; browser-shaped traffic is still filtered). Never leave `ALLOW_UNREGISTERED_DOMAINS="true"` enabled outside a short onboarding window (it disables origin checks entirely). The flag only applies to tenants with **no** allowlist entry: once a tenant exists in KV an empty domain list is an explicit deny-all, not a grace period.

> **Sandbox environment.** The sandbox runs on Workers Paid with `ALLOW_UNREGISTERED_DOMAINS="true"` and keeps `workers.dev` enabled as a backup host, so anyone can write forged events into the sandbox dataset for any valid `sid`. That is intentional for testing; it is bounded only by the same rate limits and by the sandbox account's Analytics Engine allowance, which the sandbox shares with local and CI seeding. Keep sandbox data untrusted and never point production dashboards at it.

## Cloudflare Bindings

| Binding                  | Type             | Purpose                                      |
| ------------------------ | ---------------- | -------------------------------------------- |
| `ANALYTICS`              | Analytics Engine | Event storage via `writeDataPoint()`         |
| `DOMAINS_KV`             | KV               | Per-tenant domain allowlist                  |
| `COLLECT_RATE_LIMIT`     | Rate Limit       | Public collect quota per client IP           |
| `SITE_COLLECT_RATE_LIMIT` | Rate Limit      | Site and origin quota before KV lookup       |
| `QUERY_RATE_LIMIT`       | Rate Limit       | Authenticated reads per tenant/token subject |
| `QUERY_RATE_LIMIT_ADMIN` | Rate Limit       | Higher read quota for the shared admin token |

## Environment

| Variable                     | Source | Purpose                                                      |
| ---------------------------- | ------ | ------------------------------------------------------------ |
| `AUTH_TOKEN`                 | Secret | Admin API token and scoped-token signing secret              |
| `CF_API_TOKEN`               | Secret | Cloudflare API token for Analytics Engine SQL queries        |
| `FINGERPRINT_SECRET`         | Secret | Required salt for visitor hashing (ingest fails closed while unset) |
| `INGEST_TOKEN`               | Secret | Optional separate token for server-to-server ingestion       |
| `ACCOUNT_ID`                 | Var    | Cloudflare account ID                                        |
| `ENVIRONMENT`                | Var    | `development`, `staging`, or `production`                     |
| `ALLOW_UNREGISTERED_DOMAINS` | Var    | Optional `"true"` grace period for unregistered site domains |
