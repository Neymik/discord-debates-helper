import { describe, it, expect } from "vitest";
import { buildAnnounceMessage, type AnnouncePayload } from "./message.js";

describe("buildAnnounceMessage", () => {
  it("mentions linked participants and labels unlinked ones", () => {
    const payload: AnnouncePayload = {
      motion: "THW abolish zoos",
      participants: [
        { display_name: "Alice", discord_user_id: "111", telegram_username: "alice_tg" },
        { display_name: "Bob", discord_user_id: null, telegram_username: "bob_tg" },
        { display_name: "Carol", discord_user_id: null, telegram_username: null },
      ],
    };
    const msg = buildAnnounceMessage(payload);
    expect(msg).toContain("Debate in 30 min: THW abolish zoos.");
    expect(msg).toContain("<@111>");
    expect(msg).toContain("bob_tg (not linked)");
    expect(msg).toContain("Carol (not linked)");
  });

  it("uses a fallback when motion is null", () => {
    const msg = buildAnnounceMessage({ motion: null, participants: [] });
    expect(msg).toContain("Debate in 30 min");
    expect(msg).toContain("(motion TBA)");
  });
});
