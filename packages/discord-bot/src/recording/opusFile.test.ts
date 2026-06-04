import { describe, it, expect, afterAll } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpusFileWriter } from "./opusFile.js";

const dir = mkdtempSync(path.join(tmpdir(), "opus-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("OpusFileWriter", () => {
  it("counts audio packets and writes an Ogg file larger than the header", async () => {
    const filePath = path.join(dir, "a.ogg");
    const writer = new OpusFileWriter(filePath);
    // 5 fake opus packets (content is opaque to the Ogg framer)
    const src = Readable.from([
      Buffer.alloc(80, 1),
      Buffer.alloc(80, 2),
      Buffer.alloc(80, 3),
      Buffer.alloc(80, 4),
      Buffer.alloc(80, 5),
    ]);
    writer.start(src);
    const { audioPackets } = await writer.finish();
    expect(audioPackets).toBe(5);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).size).toBeGreaterThan(110); // > 2 header pages
  });

  it("reports zero audio packets for an empty stream", async () => {
    const filePath = path.join(dir, "empty.ogg");
    const writer = new OpusFileWriter(filePath);
    writer.start(Readable.from([]));
    const { audioPackets } = await writer.finish();
    expect(audioPackets).toBe(0);
  });
});
