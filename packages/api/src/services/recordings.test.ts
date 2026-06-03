import { describe, it, expect } from "vitest";
import { sessionDirName, buildMetadata } from "./recordings.js";

describe("sessionDirName", () => {
  it("formats timestamp + sanitized channel + sessionId", () => {
    const dir = sessionDirName(new Date("2026-06-03T19:00:00Z"), "Main Stage!!", "abc-123");
    expect(dir).toBe("2026-06-03T19-00-00_Main_Stage_abc-123");
  });
});

describe("buildMetadata", () => {
  it("assembles the _metadata.json shape from session + files", () => {
    const meta = buildMetadata(
      {
        id: "s1",
        startedAt: new Date("2026-06-03T19:00:00Z"),
        endedAt: new Date("2026-06-03T19:48:12Z"),
        voiceChannelId: "v1",
        voiceChannelName: "Main",
      },
      [
        {
          discordUserId: "998877665544332211",
          discordUsername: "alice",
          telegramUserId: 123456n,
          displayName: "Alice K.",
          filePath: "alice_2211.opus",
          durationSec: 412,
        },
      ],
    );
    expect(meta.session_id).toBe("s1");
    expect(meta.voice_channel).toEqual({ id: "v1", name: "Main" });
    expect(meta.files[0]).toMatchObject({
      discord_user_id: "998877665544332211",
      telegram_user_id: 123456,
      file: "alice_2211.opus",
      duration_sec: 412,
    });
  });
});
