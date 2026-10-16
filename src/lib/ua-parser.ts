// ─── Lightweight User-Agent Parser ───────────────────────────────────────────
// Zero-dependency device type detection. Returns Desktop/Mobile/Tablet.
// Runs at the edge — no bloated UA parser libraries needed.

import { DEVICE_TYPES, type DeviceType } from "@/lib/schema.ts";

const TABLET_REGEX = /iPad|Android(?!.*Mobile)|Tablet|PlayBook|Silk/i;
const MOBILE_REGEX =
    /Mobile|Android.*Mobile|iPhone|iPod|Opera Mini|IEMobile|WPDesktop|BlackBerry|webOS/i;

/**
 * Parse a User-Agent string into a device type category.
 * Order matters: check tablet first (some tablet UAs contain "Mobile").
 *
 * Known limitation: iPadOS 13+ Safari reports a desktop "Macintosh" UA, so those
 * sessions are classified as Desktop — the UA string alone cannot distinguish
 * them from a Mac.
 */
export function parseDeviceType(ua: string): DeviceType {
    if (TABLET_REGEX.test(ua)) return DEVICE_TYPES.TABLET;
    if (MOBILE_REGEX.test(ua)) return DEVICE_TYPES.MOBILE;
    return DEVICE_TYPES.DESKTOP;
}

/**
 * Extract a clean referrer domain from a full referrer URL.
 * Returns empty string if no referrer or if it's a same-site referrer.
 */
export function cleanReferrer(
    referrer: string | null,
    currentHost: string,
): string {
    if (!referrer) return "";

    try {
        const url = new URL(referrer);
        // Ignore same-site referrers
        if (url.hostname === currentHost) return "";
        return url.hostname;
    } catch {
        return "";
    }
}
