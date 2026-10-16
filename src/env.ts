// ─── Environment Bindings ────────────────────────────────────────────────────
// Typed Cloudflare env bindings for the analytics worker.

export interface Env {
  // Analytics Engine dataset (defined in wrangler.toml)
  ANALYTICS: AnalyticsEngineDataset;

  // KV namespace for domain allowlist
  DOMAINS_KV: KVNamespace;

  /**
   * Workers Rate Limit binding (`[[ratelimits]]` in wrangler.toml).
   * POST /api/collect is limited to 300 events / 60s per CF-Connecting-IP and
   * Cloudflare location, i.e. 150 complete pageview+beacon lifecycles.
   * Authenticated server-to-server ingest skips this limiter.
   */
  COLLECT_RATE_LIMIT: RateLimit;

  /** Per-location browser quota keyed by site and origin before domain KV reads. */
  SITE_COLLECT_RATE_LIMIT: RateLimit;

  /**
   * Per-location query quota keyed by tenant and a hash of the bearer token.
   * Also carries the `unauth:{ip}` bucket that throttles failed auth attempts.
   */
  QUERY_RATE_LIMIT: RateLimit;

  /**
   * Higher query ceiling for the shared admin token so one dashboard token
   * serving every tenant is not capped by the scoped-token limit. Falls back to
   * QUERY_RATE_LIMIT when the binding is absent.
   */
  QUERY_RATE_LIMIT_ADMIN?: RateLimit;

  // Secrets (set via `wrangler secret put`)
  AUTH_TOKEN: string;
  /** Temporary overlap while existing callers switch to AUTH_TOKEN. Remove after cutover. */
  AUTH_TOKEN_PREVIOUS?: string;
  CF_API_TOKEN: string;
  /** Required: salt for the visitor hash. Ingest fails closed while it is unset. */
  FINGERPRINT_SECRET: string;

  // Optional separate token for server-to-server ingestion (falls back to AUTH_TOKEN)
  INGEST_TOKEN?: string;

  // Vars
  ACCOUNT_ID: string;
  ENVIRONMENT: string;
  /** Analytics Engine SQL table/dataset. Production: manhali_analytics. */
  ANALYTICS_DATASET?: string;

  // Allow collect from sites with no registered domains (set to "true" for setup grace period)
  ALLOW_UNREGISTERED_DOMAINS?: string;
}
