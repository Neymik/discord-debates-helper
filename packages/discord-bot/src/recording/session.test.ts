import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordingManager, type SpawnFn } from "./session.js";
import { TRANSCRIBE_MARKER } from "./sidecar.js";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "session-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * `start()` needs a live Discord voice connection, so we exercise the
 * transcription wiring through the private `persist()` — the method that, after
 * registering files and completing the session (which is when the API writes the
 * `_metadata.json` the transcriber reads), fires the hook. An injected `spawnFn`
 * stands in for launching a real process.
 */
function makeManager(opts: { hook?: string }) {
  const api = {
    registerFile: vi.fn(async () => ({ sessionId: "s1", discordUserId: "u1" })),
    completeSession: vi.fn(async () => ({})),
  } as unknown as ApiClient;
  const cfg = { transcribeHook: opts.hook } as unknown as BotConfig;
  const spawned: Array<{ unref: () => void }> = [];
  const spawnFn: SpawnFn = vi.fn((_c, _a, _o) => {
    const child = { unref: vi.fn() };
    spawned.push(child);
    return child;
  });
  const manager = new RecordingManager(api, cfg, spawnFn);
  // persist is private; reach it directly to test the wiring in isolation.
  const persist = (sessionId: string, files: unknown[], fileDir: string, t?: unknown) =>
    (manager as unknown as {
      persist: (s: string, f: unknown[], d: string, t?: unknown) => Promise<void>;
    }).persist(sessionId, files, fileDir, t);
  return { api, spawnFn: spawnFn as unknown as ReturnType<typeof vi.fn>, spawned, persist };
}

const FILE_DIR = "/data/records/2026-06-15T10-00-00_Main_abc-uuid";

describe("RecordingManager transcription hook", () => {
  it("launches the hook with <dir-name> <type> after the session completes", async () => {
    const { api, spawnFn, spawned, persist } = makeManager({ hook: "/x/transcribe.sh" });
    await persist("s1", [{ a: 1 }], FILE_DIR, { transcribe: true, type: "batch" });

    expect(api.completeSession).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith(
      "/x/transcribe.sh",
      ["2026-06-15T10-00-00_Main_abc-uuid", "batch"],
      { detached: true, stdio: "ignore" },
    );
    expect(spawned[0].unref).toHaveBeenCalledTimes(1); // detached → unref so it outlives us
  });

  it("does NOT launch the hook when transcribe is false", async () => {
    const { spawnFn, persist } = makeManager({ hook: "/x/transcribe.sh" });
    await persist("s1", [{ a: 1 }], FILE_DIR, { transcribe: false, type: "batch" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("drops a _transcribe.request marker (not a spawn) when no hook is configured (in-container path)", async () => {
    const { spawnFn, persist } = makeManager({ hook: undefined });
    const dir = mkdtempSync(path.join(tmpRoot, "marker-"));
    await persist("s1", [{ a: 1 }], dir, { transcribe: true, type: "batch" });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, TRANSCRIBE_MARKER))).toBe(true); // worker will pick it up
  });

  it("does NOT drop a marker when transcribe is false and no hook", async () => {
    const { spawnFn, persist } = makeManager({ hook: undefined });
    const dir = mkdtempSync(path.join(tmpRoot, "nomarker-"));
    await persist("s1", [{ a: 1 }], dir, { transcribe: false, type: "batch" });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, TRANSCRIBE_MARKER))).toBe(false);
  });

  it("passes the chosen type through to the hook (incremental)", async () => {
    const { spawnFn, persist } = makeManager({ hook: "/x/transcribe.sh" });
    await persist("s1", [{ a: 1 }], FILE_DIR, { transcribe: true, type: "incremental" });
    expect(spawnFn).toHaveBeenCalledWith(
      "/x/transcribe.sh",
      ["2026-06-15T10-00-00_Main_abc-uuid", "incremental"],
      { detached: true, stdio: "ignore" },
    );
  });
});
