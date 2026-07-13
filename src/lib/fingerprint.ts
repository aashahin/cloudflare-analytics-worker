// ─── Visitor Fingerprint (Privacy-First) ─────────────────────────────────────
// Generates an anonymous server-side visitor hash using Web Crypto API.
// SHA-256(tenantId + IP + UA + dayBucket + secret) → no cookies or client-side
// identifiers.
//
// The hash is scoped to the tenant and rotates every UTC day:
//   - tenantId  → the same visitor yields a *different* hash per tenant, so
//     blob3 values cannot be joined across tenants to track one person across
//     unrelated sites (all tenants share one Analytics Engine dataset).
//   - dayBucket → visitor identity rotates daily, matching the documented
//     "unique daily visitors" semantics and preventing cross-day tracking.

const encoder = new TextEncoder();

/**
 * Generate a privacy-safe, tenant-scoped, daily-rotating visitor hash for
 * unique visitor aggregation. Uses Web Crypto API (available in all Workers).
 *
 * @param dayBucket - Coarse UTC date string (e.g. "2026-07-13") so the hash
 *                    rotates daily. Passed in by the caller to keep this
 *                    function pure and deterministic for testing.
 */
export async function generateVisitorHash(
    tenantId: string,
    ip: string,
    userAgent: string,
    dayBucket: string,
    secret: string,
): Promise<string> {
    const raw = `${tenantId}|${ip}|${userAgent}|${dayBucket}|${secret}`;
    const data = encoder.encode(raw);

    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);

    // Convert to hex string
    let hex = "";
    for (const byte of hashArray) {
        hex += byte.toString(16).padStart(2, "0");
    }

    return hex;
}
