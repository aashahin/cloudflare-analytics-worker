# Authentication-secret transition

`AUTH_TOKEN` remains required. Optional `AUTH_TOKEN_PREVIOUS` temporarily accepts
the previous admin token and its scoped tenant tokens. When `INGEST_TOKEN` is
configured it remains the sole ingestion credential; otherwise ingestion accepts
the active and previous authentication tokens during overlap. Scoped tokens
retain their tenant restriction. Remove the previous binding only after all
callers and the VPS recovery path use the active key.

Keep production secret values in ignored, mode-0600 dotenv or JSON files. An
Analytics SQL API credential is a provider-issued Account Analytics Read token
restricted to the production account, not a randomly generated shared secret.
`CF_API_TOKEN`, `AUTH_TOKEN`, and `FINGERPRINT_SECRET` serve separate purposes.
`FINGERPRINT_SECRET` is required and enforced: collect fails closed while it is
unset. Rotating it also restarts daily visitor continuity, because hashes for the
current UTC day change (unique-visitor counts can dip or double-count until the
next day boundary).

Upload the pinned compatible code and the private secret file as an inactive
version with the installed Wrangler's `versions upload --secrets-file` option.
Verify the version, retained dataset/KV bindings and unchanged active deployment.
Follow the reviewed release procedure to activate after rehearsal; uploading
alone does not establish staging or production correctness. The legacy daily
Cron is now explicitly disabled in `wrangler.toml` (`[triggers] crons = []`) —
Cloudflare only removes an attached trigger when the config sets that key, since
omitting it leaves the trigger in place — so confirm after the next deploy that
no crons remain attached to either environment.

After migrating callers, stage deletion of `AUTH_TOKEN_PREVIOUS` through
`wrangler versions secret delete`, then activate the reviewed version. Verify
that the new admin, scoped and ingestion credentials work and that the retired
credentials are rejected. Do not roll back to a version accepting a retired key.

Local proof: `bun test`, the repository TypeScript check and
`bun run build:cf:production` (packaging only).
