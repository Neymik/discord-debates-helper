import { describe, it, expect, afterAll } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpusFileWriter } from "./opusFile.js";

const dir = mkdtempSync(path.join(tmpdir(), "opus-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Ogg's CRC-32: poly 0x04C11DB7, init 0, no input/output reflection, xorout 0.
 * (Different from the reflected CRC-32 used by zlib/PNG.)
 */
function oggCrc32(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc ^ ((buf[i] << 24) >>> 0)) >>> 0;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

/**
 * Walks every Ogg page in `buf`, recomputes its CRC, and asserts it matches the
 * stored checksum. Returns the page count. Throws on a bad capture pattern or a
 * CRC mismatch — the exact corruption produced by `crc: false`.
 */
function assertValidOggCrcs(buf: Buffer): number {
  let off = 0;
  let pages = 0;
  while (off < buf.length) {
    if (buf.toString("ascii", off, off + 4) !== "OggS") {
      throw new Error(`bad Ogg capture pattern at byte ${off}`);
    }
    const segCount = buf[off + 26];
    let payload = 0;
    for (let s = 0; s < segCount; s++) payload += buf[off + 27 + s];
    const pageLen = 27 + segCount + payload;
    const page = Buffer.from(buf.subarray(off, off + pageLen));
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22); // CRC is computed with its own field zeroed
    const computed = oggCrc32(page);
    if (computed !== stored) {
      throw new Error(`page ${pages} CRC mismatch: stored ${stored} computed ${computed}`);
    }
    pages++;
    off += pageLen;
  }
  return pages;
}

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
    expect(writer.audioMs()).toBe(100); // 5 packets × 20 ms — anchors burst audio_offset_ms
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).size).toBeGreaterThan(110); // > 2 header pages
  });

  it("writes valid Ogg page CRC checksums (regression: crc:false corrupted every page)", async () => {
    const filePath = path.join(dir, "crc.ogg");
    const writer = new OpusFileWriter(filePath);
    // Enough packets to span multiple pages (maxPackets:10) so we validate body pages too.
    const packets = Array.from({ length: 25 }, (_, i) => Buffer.alloc(80, i + 1));
    writer.start(Readable.from(packets));
    await writer.finish();
    const bytes = readFileSync(filePath);
    const pages = assertValidOggCrcs(bytes); // throws on any CRC mismatch
    expect(pages).toBeGreaterThan(2); // 2 header pages + at least one audio page
  });

  it("reports zero audio packets for an empty stream", async () => {
    const filePath = path.join(dir, "empty.ogg");
    const writer = new OpusFileWriter(filePath);
    writer.start(Readable.from([]));
    const { audioPackets } = await writer.finish();
    expect(audioPackets).toBe(0);
  });

  it("drops zero-length packets so they cannot poison the Ogg stream", async () => {
    const filePath = path.join(dir, "drop-empty.ogg");
    const writer = new OpusFileWriter(filePath);
    // Interleave empty buffers (a known corrupt-packet shape) between real ones.
    writer.start(
      Readable.from([
        Buffer.alloc(80, 1),
        Buffer.alloc(0),
        Buffer.alloc(80, 2),
        Buffer.alloc(0),
        Buffer.alloc(80, 3),
      ]),
    );
    const { audioPackets, droppedPackets } = await writer.finish();
    expect(audioPackets).toBe(3); // only the real packets reach the framer
    expect(droppedPackets).toBe(2);
    expect(writer.audioMs()).toBe(60); // talk-time counts kept packets only
    // Stream must still be byte-valid (every page CRC matches).
    expect(assertValidOggCrcs(readFileSync(filePath))).toBeGreaterThan(2);
  });

  it("drops oversized packets (truncation/concatenation garbage)", async () => {
    const filePath = path.join(dir, "drop-oversized.ogg");
    const writer = new OpusFileWriter(filePath);
    writer.start(
      Readable.from([
        Buffer.alloc(80, 1),
        Buffer.alloc(64_000, 9), // far beyond any real 20 ms Opus packet
        Buffer.alloc(80, 2),
      ]),
    );
    const { audioPackets, droppedPackets } = await writer.finish();
    expect(audioPackets).toBe(2);
    expect(droppedPackets).toBe(1);
    expect(assertValidOggCrcs(readFileSync(filePath))).toBeGreaterThan(2);
  });
});
