// ─── Authentication & Token Management ───────────────────────────────────────
// Handles Bearer token verification, HMAC-based scoped tenant tokens,
// and server-to-server ingestion auth.

import type { Env } from "@/env.ts";

// ─── Timing-Safe Comparison ──────────────────────────────────────────────────

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
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
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return { authenticated: false };
  const token = header.slice(7);

  // Admin token — unrestricted access to all tenants
  if (timingSafeEqual(token, env.AUTH_TOKEN)) {
    return { authenticated: true };
  }

  // Scoped token — restricted to a single tenant
  const scoped = await verifyScopedToken(token, env.AUTH_TOKEN);
  if (scoped) {
    return { authenticated: true, tenantScope: scoped.tenantId };
  }

  return { authenticated: false };
}

/** Verify server-to-server ingestion auth (uses INGEST_TOKEN if set, else AUTH_TOKEN) */
export function verifyIngestAuth(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  if (env.INGEST_TOKEN) return timingSafeEqual(token, env.INGEST_TOKEN);
  return timingSafeEqual(token, env.AUTH_TOKEN);
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
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `scoped:${tenantId}:${expiry}`;
  const hmac = await hmacSign(secret, payload);
  return `${payload}:${hmac}`;
}
