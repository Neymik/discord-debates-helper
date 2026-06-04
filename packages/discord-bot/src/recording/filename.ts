import { sanitizeUsername, last4 } from "../lib/sanitize.js";

/**
 * Per-speaker filename: `<sanitized_username>_<last4_of_id>.ogg`.
 * NOTE: `.ogg` (Ogg/Opus container), not raw `.opus` — see Task 5 spec-correction note.
 */
export function recordingFileName(discordUsername: string, discordUserId: string): string {
  return `${sanitizeUsername(discordUsername)}_${last4(discordUserId)}.ogg`;
}
