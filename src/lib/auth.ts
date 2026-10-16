// ─── Authentication & Token Management ───────────────────────────────────────
// Handles Bearer token verification, HMAC-based scoped tenant tokens,
// and server-to-server ingestion auth.

import type { Env } from "@/env.ts";

// ─── Timing-Safe Comparison ──────────────────────────────────────────────────

const BEARER_PREFIX = "Bearer ";

/**
 * Compare secrets without leaking length via an early return. Both sides are
 * SHA-256 hashed first so `timingSafeEqual` always runs on 32-byte digests.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bufA = new Uint8Array(digestA);
  const bufB = new Uint8Array(digestB);

  // crypto.subtle.timingSafeEqual is a Cloudflare Workers extension and is used
  // whenever available (the production runtime). Fall back to a manual
  // constant-time comparison on runtimes that lack it (e.g. the test env).
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(bufA, bufB);
  }

  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i]! ^ bufB[i]!;
  return diff === 0;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith(BEARER_PREFIX)) return null;

  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

// A missing or empty secret is reported once per isolate: the check runs on
// every authenticated request, and repeating the line would dominate the log
// stream of a misconfigured deployment.
const reportedSecretProblems = new Set<string>();

function reportSecretProblemOnce(message: string): void {
  if (reportedSecretProblems.has(message)) return;
  reportedSecretProblems.add(message);
  console.error(`[Auth] ${message}`);
}

function configuredSecret(value: string | undefined, name: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    reportSecretProblemOnce(`Required secret ${name} is not configured`);
    return null;
  }

  return value;
}

function optionalConfiguredSecret(
  value: string | undefined,
  name: string,
): string | null {
  if (value === undefined) return null;
  if (value.trim().length === 0) {
    reportSecretProblemOnce(`Optional secret ${name} is configured but empty`);
    return null;
  }

  return value;
}

// ─── Auth Result ─────────────────────────────────────────────────────────────

export interface AuthResult {
  authenticated: boolean;
  /** If set, the token is scoped to this tenant only (non-admin) */
  tenantScope?: string;
}

export async function verifyAuth(
  request: Request,
  env: Env,
): Promise<AuthResult> {
  const token = readBearerToken(request);
  const authSecret = configuredSecret(env.AUTH_TOKEN, "AUTH_TOKEN");
  if (!token || !authSecret) return { authenticated: false };
  const previousSecret = optionalConfiguredSecret(env.AUTH_TOKEN_PREVIOUS, "AUTH_TOKEN_PREVIOUS");
  const acceptedSecrets = previousSecret ? [authSecret, previousSecret] : [authSecret];

  // Admin token — unrestricted access to all tenants
  if ((await Promise.all(acceptedSecrets.map(secret => timingSafeEqual(token, secret)))).some(Boolean)) {
    return { authenticated: true };
  }

  // Scoped token — restricted to a single tenant
  const scoped = (await Promise.all(acceptedSecrets.map(secret => verifyScopedToken(token, secret)))).find(Boolean);
  if (scoped) {
    return { authenticated: true, tenantScope: scoped.tenantId };
  }

  return { authenticated: false };
}

/** Verify server-to-server ingestion auth (uses INGEST_TOKEN if set, else AUTH_TOKEN) */
export async function verifyIngestAuth(
  request: Request,
  env: Env,
): Promise<boolean> {
  const token = readBearerToken(request);
  const authSecret = configuredSecret(env.AUTH_TOKEN, "AUTH_TOKEN");
  if (!token || !authSecret) return false;

  const ingestSecret = optionalConfiguredSecret(env.INGEST_TOKEN, "INGEST_TOKEN");
  if (ingestSecret) return timingSafeEqual(token, ingestSecret);
  const previousSecret = optionalConfiguredSecret(env.AUTH_TOKEN_PREVIOUS, "AUTH_TOKEN_PREVIOUS");
  const acceptedSecrets = previousSecret ? [authSecret, previousSecret] : [authSecret];
  return (await Promise.all(acceptedSecrets.map(secret => timingSafeEqual(token, secret)))).some(Boolean);
}

// ─── Scoped Tenant Tokens (HMAC-based) ───────────────────────────────────────
// Format: scoped:{tenant_id}:{expiry_unix}:{hmac_hex}
// Generated via POST /api/admin/token, verified on authenticated requests.
// Purely cryptographic — no KV lookup needed for verification.

const hmacEncoder = new TextEncoder();

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hmacEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    hmacEncoder.encode(message),
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function verifyScopedToken(
  token: string,
  secret: string,
): Promise<{ tenantId: string } | null> {
  const parts = token.split(":");
  if (parts.length < 4 || parts[0] !== "scoped") return null;

  const providedHmac = parts[parts.length - 1]!;
  const expiryStr = parts[parts.length - 2]!;
  const tenantId = parts.slice(1, -2).join(":");

  if (!tenantId) return null;

  const expiry = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry) || Date.now() / 1000 > expiry) return null;

  const payload = `scoped:${tenantId}:${expiryStr}`;
  const expectedHmac = await hmacSign(secret, payload);

  if (!(await timingSafeEqual(expectedHmac, providedHmac))) return null;
  return { tenantId };
}

export async function createScopedToken(
  secret: string,
  tenantId: string,
  ttlSeconds: number,
): Promise<string> {
  const authSecret = configuredSecret(secret, "AUTH_TOKEN");
  if (!authSecret) {
    throw new Error("AUTH_TOKEN is not configured");
  }

  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `scoped:${tenantId}:${expiry}`;
  const hmac = await hmacSign(authSecret, payload);
  return `${payload}:${hmac}`;
}
