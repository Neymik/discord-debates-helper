export interface AnnounceParticipant {
  display_name: string;
  discord_user_id: string | null;
  telegram_username: string | null;
}

export interface AnnouncePayload {
  motion: string | null;
  participants: AnnounceParticipant[];
}

/** Renders the announce_t30 message (spec §4). Linked → mention; unlinked → "(not linked)". */
export function buildAnnounceMessage(payload: AnnouncePayload): string {
  const motion = payload.motion && payload.motion.trim().length > 0 ? payload.motion : "(motion TBA)";
  const names = payload.participants.map((p) =>
    p.discord_user_id
      ? `<@${p.discord_user_id}>`
      : `${p.telegram_username ?? p.display_name} (not linked)`,
  );
  const list = names.length > 0 ? names.join(" ") : "(no participants)";
  return `Debate in 30 min: ${motion}. Participants: ${list}`;
}
