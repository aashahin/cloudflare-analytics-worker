// ─── Visitor Fingerprint (Privacy-First) ─────────────────────────────────────
// Generates a daily-rotating anonymous visitor hash using Web Crypto API.
// SHA-256(IP + UA + YYYY-MM-DD + secret) → no cookies, GDPR-friendly.
// The hash changes every day, so visitors cannot be tracked across days.

const encoder = new TextEncoder();

/**
 * Generate a privacy-safe visitor hash that rotates daily.
 * Uses Web Crypto API (available in all Cloudflare Workers).
 */
export async function generateVisitorHash(
    ip: string,
    userAgent: string,
    secret: string,
): Promise<string> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const raw = `${ip}|${userAgent}|${today}|${secret}`;
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
