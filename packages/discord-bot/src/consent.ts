/**
 * Mandatory recording-active consent notice posted on /record start (spec §11).
 * `{channel}` and `{sessionId}` are filled by the record handler.
 */
export function consentNotice(voiceChannelName: string, sessionId: string): string {
  return (
    `🔴 Recording started in **#${voiceChannelName}**. ` +
    `By staying in voice, all participants consent to being recorded for personal ` +
    `feedback purposes (30-day retention). Session ID: \`${sessionId}\`. ` +
    `Run \`/record stop\` when done.`
  );
}
