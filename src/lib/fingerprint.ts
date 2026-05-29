// ─── Visitor Fingerprint (Privacy-First) ─────────────────────────────────────
// Generates an anonymous server-side visitor hash using Web Crypto API.
// SHA-256(IP + UA + secret) → no cookies or client-side identifiers.

const encoder = new TextEncoder();

/**
 * Generate a privacy-safe visitor hash for unique visitor aggregation.
 * Uses Web Crypto API (available in all Cloudflare Workers).
 */
export async function generateVisitorHash(
    ip: string,
    userAgent: string,
    secret: string,
): Promise<string> {
    const raw = `${ip}|${userAgent}|${secret}`;
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
