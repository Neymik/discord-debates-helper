/**
 * Conservative filename sanitization (spec §13: allowlist `[A-Za-z0-9_-]`).
 * Replaces every disallowed character with `_`, collapses runs, trims edge
 * underscores, and falls back to "user" when nothing survives.
 */
export function sanitizeUsername(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.length > 0 ? cleaned : "user";
}

/** Last 4 chars of a Discord snowflake id (disambiguates same-named files). */
export function last4(discordUserId: string): string {
  return discordUserId.slice(-4);
}
