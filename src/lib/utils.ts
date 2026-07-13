// ─── Shared Utilities ────────────────────────────────────────────────────────

/**
 * Extract hostname from a URL string.
 * Returns null if the input is null or not a valid URL.
 */
export function extractHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ─── Shared Validation ───────────────────────────────────────────────────────

/** Parse an integer with bounds checking. Returns `defaultValue` on invalid input. */
export function safeInt(
  value: string | null,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const parsed = parseInt(value ?? String(defaultValue), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    return defaultValue;
  return parsed;
}

/** Pattern for valid tenant IDs — defense-in-depth against injection.
 *  The length cap keeps the resolved ID within Analytics Engine's 96-byte
 *  index limit (the ID is written as the AE index); a longer index silently
 *  drops every data point for that tenant. IDs are ASCII, so chars == bytes. */
export const SAFE_TENANT_ID = /^[a-zA-Z0-9_\-.:]{1,64}$/;

/** Sanitize a page path: limit length, strip query string and fragment. */
export function sanitizePath(path: string): string {
  const clean = path.split("?")[0]!.split("#")[0]!;
  return clean.slice(0, 2048);
}
