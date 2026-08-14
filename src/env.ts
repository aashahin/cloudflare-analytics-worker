// ─── Environment Bindings ────────────────────────────────────────────────────
// Typed Cloudflare env bindings for the analytics worker.

export interface Env {
  // Analytics Engine dataset (defined in wrangler.toml)
  ANALYTICS: AnalyticsEngineDataset;

  // KV namespace for domain allowlist
  DOMAINS_KV: KVNamespace;

  // Secrets (set via `wrangler secret put`)
  AUTH_TOKEN: string;
  CF_API_TOKEN: string;
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
