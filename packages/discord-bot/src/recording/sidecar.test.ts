import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeSessionJson,
  appendOpen,
  appendSeg,
  touchHeartbeat,
  heartbeatAgeMs,
  readSidecars,
} from "./sidecar.js";

const root = mkdtempSync(path.join(tmpdir(), "sidecar-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("sidecar", () => {
  it("round-trips session identity, per-user identity, and the burst timeline", () => {
    const dir = mkdtempSync(path.join(root, "ok-"));
    writeSessionJson(dir, {
      sessionId: "sess-1",
      guildId: "g1",
      voiceChannelId: "vc1",
      voiceChannelName: "Main",
      startedAtMs: 1000,
    });
    appendOpen(dir, "alice_1234.ogg", { discordUserId: "uA", discordUsername: "alice" });
    appendSeg(dir, "alice_1234.ogg", { wallMs: 0, audioOffsetMs: 0, durationMs: 5000 });
    appendSeg(dir, "alice_1234.ogg", { wallMs: 8000, audioOffsetMs: 5000, durationMs: 3000 });
    appendOpen(dir, "bob_5678.ogg", { discordUserId: "uB", discordUsername: "bob" });
    appendSeg(dir, "bob_5678.ogg", { wallMs: 5000, audioOffsetMs: 0, durationMs: 2000 });

    const { session, files } = readSidecars(dir);
    expect(session?.sessionId).toBe("sess-1");
    expect(session?.guildId).toBe("g1");
    expect(files).toHaveLength(2);
    const alice = files.find((f) => f.discordUsername === "alice")!;
    expect(alice.fileName).toBe("alice_1234.ogg");
    expect(alice.discordUserId).toBe("uA");
    expect(alice.segments).toEqual([
      { wallMs: 0, audioOffsetMs: 0, durationMs: 5000 },
      { wallMs: 8000, audioOffsetMs: 5000, durationMs: 3000 },
    ]);
    const bob = files.find((f) => f.discordUsername === "bob")!;
    expect(bob.segments).toEqual([{ wallMs: 5000, audioOffsetMs: 0, durationMs: 2000 }]);
  });

  it("skips a torn final line (partial write at crash)", () => {
    const dir = mkdtempSync(path.join(root, "torn-"));
    appendOpen(dir, "c_9.ogg", { discordUserId: "uC", discordUsername: "carol" });
    appendSeg(dir, "c_9.ogg", { wallMs: 0, audioOffsetMs: 0, durationMs: 1000 });
    // Simulate a half-written final JSONL line (no newline, truncated JSON).
    appendFileSync(path.join(dir, "c_9.ogg.segments.jsonl"), '{"t":"seg","wall_ms":2000,"audio_off');

    const { files } = readSidecars(dir);
    expect(files).toHaveLength(1);
    expect(files[0].segments).toEqual([{ wallMs: 0, audioOffsetMs: 0, durationMs: 1000 }]); // torn line dropped
  });

  it("ignores a jsonl with no open record (no identity → cannot register)", () => {
    const dir = mkdtempSync(path.join(root, "noident-"));
    appendFileSync(path.join(dir, "ghost_0.ogg.segments.jsonl"), '{"t":"seg","wall_ms":0,"audio_offset_ms":0,"duration_ms":1}\n');
    const { files } = readSidecars(dir);
    expect(files).toHaveLength(0);
  });

  it("returns null session when _session.json is absent", () => {
    const dir = mkdtempSync(path.join(root, "nosession-"));
    appendOpen(dir, "x_1.ogg", { discordUserId: "uX", discordUsername: "x" });
    const { session, files } = readSidecars(dir);
    expect(session).toBeNull();
    expect(files).toHaveLength(1);
  });

  it("reports heartbeat age and treats a missing heartbeat as infinitely old", () => {
    const dir = mkdtempSync(path.join(root, "hb-"));
    expect(heartbeatAgeMs(dir)).toBe(Infinity);
    touchHeartbeat(dir);
    const age = heartbeatAgeMs(dir, Date.now() + 50);
    expect(age).toBeGreaterThanOrEqual(40);
    expect(age).toBeLessThan(5000);
  });
});
