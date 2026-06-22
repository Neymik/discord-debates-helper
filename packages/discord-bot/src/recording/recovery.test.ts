import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recoverOrphans } from "./recovery.js";
import { writeSessionJson, appendOpen, appendSeg, touchHeartbeat, TRANSCRIBE_MARKER } from "./sidecar.js";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";

const root = mkdtempSync(path.join(tmpdir(), "recovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fake API recording register/complete calls. */
function fakeApi() {
  return {
    registerFile: vi.fn(async () => undefined),
    completeSession: vi.fn(async () => undefined),
  } as unknown as ApiClient & { registerFile: ReturnType<typeof vi.fn>; completeSession: ReturnType<typeof vi.fn> };
}

function cfg(recordingsDir: string, over: Partial<BotConfig> = {}): BotConfig {
  return { recordingsDir, recoverOnBoot: true, recoverTranscribe: true, ...over } as unknown as BotConfig;
}

/** Build an orphaned session dir: sidecars + a >512B .ogg, NO _metadata.json, stale heartbeat. */
function makeOrphan(recDir: string, name: string, opts: { audio?: boolean; heartbeat?: boolean } = {}): string {
  const dir = path.join(recDir, name);
  mkdirSync(dir, { recursive: true });
  writeSessionJson(dir, {
    sessionId: `sess-${name}`,
    guildId: "g1",
    voiceChannelId: "vc1",
    voiceChannelName: "Main",
    startedAtMs: 1000,
  });
  appendOpen(dir, "alice_1234.ogg", { discordUserId: "uA", discordUsername: "alice" });
  appendSeg(dir, "alice_1234.ogg", { wallMs: 0, audioOffsetMs: 0, durationMs: 5000 });
  if (opts.audio !== false) writeFileSync(path.join(dir, "alice_1234.ogg"), Buffer.alloc(2048, 7));
  if (opts.heartbeat) touchHeartbeat(dir); // fresh heartbeat → looks live
  return dir;
}

describe("recoverOrphans", () => {
  it("finalizes an orphaned session: registerFile + completeSession + transcribe marker", async () => {
    const recDir = mkdtempSync(path.join(root, "rec-"));
    const dir = makeOrphan(recDir, "2026-06-15T10-00-00_Main_uuid1");
    const api = fakeApi();

    const n = await recoverOrphans(api, cfg(recDir));
    expect(n).toBe(1);
    expect(api.registerFile).toHaveBeenCalledTimes(1);
    expect(api.registerFile).toHaveBeenCalledWith(
      "sess-2026-06-15T10-00-00_Main_uuid1",
      expect.objectContaining({
        discord_user_id: "uA",
        discord_username: "alice",
        file_path: "alice_1234.ogg",
        segments: [{ wall_ms: 0, audio_offset_ms: 0, duration_ms: 5000 }],
      }),
    );
    expect(api.completeSession).toHaveBeenCalledWith("sess-2026-06-15T10-00-00_Main_uuid1");
    expect(existsSync(path.join(dir, TRANSCRIBE_MARKER))).toBe(true);
  });

  it("skips a session that already has _metadata.json (already finalized)", async () => {
    const recDir = mkdtempSync(path.join(root, "rec-"));
    const dir = makeOrphan(recDir, "done");
    writeFileSync(path.join(dir, "_metadata.json"), "{}");
    const api = fakeApi();
    expect(await recoverOrphans(api, cfg(recDir))).toBe(0);
    expect(api.completeSession).not.toHaveBeenCalled();
  });

  it("skips a session with a fresh heartbeat (a live recording, not an orphan)", async () => {
    const recDir = mkdtempSync(path.join(root, "rec-"));
    makeOrphan(recDir, "live", { heartbeat: true });
    const api = fakeApi();
    expect(await recoverOrphans(api, cfg(recDir))).toBe(0);
    expect(api.completeSession).not.toHaveBeenCalled();
  });

  it("completes (to free the lock) but registers nothing when no real audio exists", async () => {
    const recDir = mkdtempSync(path.join(root, "rec-"));
    makeOrphan(recDir, "noaudio", { audio: false });
    const api = fakeApi();
    expect(await recoverOrphans(api, cfg(recDir))).toBe(1);
    expect(api.registerFile).not.toHaveBeenCalled(); // header-less/no .ogg → skipped
    expect(api.completeSession).toHaveBeenCalledTimes(1); // still completed to release the guild
  });

  it("does not drop a transcribe marker when recoverTranscribe is false", async () => {
    const recDir = mkdtempSync(path.join(root, "rec-"));
    const dir = makeOrphan(recDir, "notrans");
    const api = fakeApi();
    await recoverOrphans(api, cfg(recDir, { recoverTranscribe: false }));
    expect(existsSync(path.join(dir, TRANSCRIBE_MARKER))).toBe(false);
  });

  it("returns 0 and does nothing when recoverOnBoot is false", async () => {
    const recDir = mkdtempSync(path.join(root, "rec-"));
    makeOrphan(recDir, "off");
    const api = fakeApi();
    expect(await recoverOrphans(api, cfg(recDir, { recoverOnBoot: false }))).toBe(0);
    expect(api.completeSession).not.toHaveBeenCalled();
  });

  it("tolerates a missing recordings dir", async () => {
    const api = fakeApi();
    expect(await recoverOrphans(api, cfg(path.join(root, "does-not-exist")))).toBe(0);
  });
});
