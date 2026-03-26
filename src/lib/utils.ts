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

/** Validate YYYY-MM-DD date format */
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Pattern for valid tenant IDs — defense-in-depth against injection */
export const SAFE_TENANT_ID = /^[a-zA-Z0-9_\-.:]+$/;

/** Sanitize a page path: limit length, strip query string and fragment. */
export function sanitizePath(path: string): string {
  const clean = path.split("?")[0]!.split("#")[0]!;
  return clean.slice(0, 2048);
}
