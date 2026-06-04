import { describe, it, expect } from "vitest";
import { recordingFileName } from "./filename.js";

describe("recordingFileName", () => {
  it("joins sanitized username + last4 id with the .ogg extension", () => {
    expect(recordingFileName("alice", "998877665544332211")).toBe("alice_2211.ogg");
  });

  it("sanitizes the username segment", () => {
    expect(recordingFileName("Bob the Builder!", "111122223333")).toBe("Bob_the_Builder_3333.ogg");
  });

  it("falls back to 'user' for an unusable username", () => {
    expect(recordingFileName("!!!", "9999")).toBe("user_9999.ogg");
  });
});
