// ─── Authentication & Token Management ───────────────────────────────────────
// Handles Bearer token verification, HMAC-based scoped tenant tokens,
// and server-to-server ingestion auth.

import type { Env } from "@/env.ts";

// ─── Timing-Safe Comparison ──────────────────────────────────────────────────

const BEARER_PREFIX = "Bearer ";

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  // crypto.subtle.timingSafeEqual is a Cloudflare Workers extension and is used
  // whenever available (the production runtime). Fall back to a manual
  // constant-time comparison on runtimes that lack it (e.g. the test env), so
  // this security-critical primitive stays portable and unit-testable. Lengths
  // are already equal here, so the loop below is genuinely constant-time.
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

function configuredSecret(value: string | undefined, name: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    console.error(`[Auth] Required secret ${name} is not configured`);
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
    console.error(`[Auth] Optional secret ${name} is configured but empty`);
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

  // Admin token — unrestricted access to all tenants
  if (timingSafeEqual(token, authSecret)) {
    return { authenticated: true };
  }

  // Scoped token — restricted to a single tenant
  const scoped = await verifyScopedToken(token, authSecret);
  if (scoped) {
    return { authenticated: true, tenantScope: scoped.tenantId };
  }

  return { authenticated: false };
}

/** Verify server-to-server ingestion auth (uses INGEST_TOKEN if set, else AUTH_TOKEN) */
export function verifyIngestAuth(request: Request, env: Env): boolean {
  const token = readBearerToken(request);
  const authSecret = configuredSecret(env.AUTH_TOKEN, "AUTH_TOKEN");
  if (!token || !authSecret) return false;

  const ingestSecret =
    optionalConfiguredSecret(env.INGEST_TOKEN, "INGEST_TOKEN") ?? authSecret;
  return timingSafeEqual(token, ingestSecret);
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

  if (!timingSafeEqual(expectedHmac, providedHmac)) return null;
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
