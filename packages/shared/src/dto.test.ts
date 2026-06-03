import { describe, it, expect } from "vitest";
import { jobIdFor } from "./constants.js";
import { CreateRecordingSessionBody, RegisterRecordingFileBody, RedeemLinkBody } from "./dto.js";

describe("jobIdFor", () => {
  it("builds a stable id", () => {
    expect(jobIdFor("abc", "announce_t30")).toBe("game:abc:announce_t30");
  });
});

describe("CreateRecordingSessionBody", () => {
  it("accepts a valid payload", () => {
    const parsed = CreateRecordingSessionBody.parse({
      started_by_discord_user_id: "998877665544332211",
      voice_channel_id: "111",
      voice_channel_name: "Main",
      guild_id: "222",
    });
    expect(parsed.voice_channel_name).toBe("Main");
  });

  it("rejects a missing guild_id", () => {
    expect(() =>
      CreateRecordingSessionBody.parse({
        started_by_discord_user_id: "1",
        voice_channel_id: "111",
        voice_channel_name: "Main",
      }),
    ).toThrow();
  });
});

describe("RegisterRecordingFileBody", () => {
  it("requires non-negative duration and size", () => {
    expect(() =>
      RegisterRecordingFileBody.parse({
        discord_user_id: "1",
        discord_username: "alice",
        file_path: "alice_2211.opus",
        duration_sec: -1,
        size_bytes: 10,
      }),
    ).toThrow();
  });
});

describe("RedeemLinkBody", () => {
  it("accepts a code redemption", () => {
    const parsed = RedeemLinkBody.parse({
      code: "LINK-7F2X",
      discord_user_id: "1",
      discord_username: "alice",
    });
    expect(parsed.code).toBe("LINK-7F2X");
  });
});
