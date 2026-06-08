import { createWriteStream, type WriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { opus } from "prism-media";

/**
 * Upper bound on a single Discord Opus packet. Discord voice is 48 kHz, 20 ms
 * single-frame packets; even at the Opus ceiling a 20 ms frame is ≤1275 bytes
 * (RFC 6716). Anything larger is truncation/concatenation garbage, not real
 * audio, so we drop it rather than let it poison the Ogg stream. The bound is
 * deliberately generous (≈2× the theoretical max) to never drop a legit packet.
 */
const MAX_OPUS_PACKET_BYTES = 3000;

/**
 * Repackages a stream of raw Opus packets (from @discordjs/voice
 * `receiver.subscribe`) into an Ogg/Opus file WITHOUT re-encoding.
 *
 * Discord audio is 48 kHz, 2-channel Opus frames. We configure the Ogg
 * logical bitstream with the matching OpusHead so players read it correctly.
 * The file is opened lazily on the first write (caller calls `start()` only
 * when the first packet arrives — see RecordingManager, Task 8).
 */
export class OpusFileWriter {
  private fileStream: WriteStream | null = null;
  private ogg: opus.OggLogicalBitstream | null = null;
  private pipelinePromise: Promise<void> | null = null;
  private bytesWritten = 0;
  private audioPackets = 0;
  private droppedPackets = 0;

  constructor(private readonly filePath: string) {}

  /** Begin piping `opusPackets` into the Ogg container at `filePath`. */
  start(opusPackets: Readable): void {
    if (this.ogg) throw new Error("OpusFileWriter already started");
    this.fileStream = createWriteStream(this.filePath);
    this.ogg = new opus.OggLogicalBitstream({
      opusHead: new opus.OpusHead({ channelCount: 2, sampleRate: 48000 }),
      pageSizeControl: { maxPackets: 10 },
      // CRC MUST stay on: with crc:false prism writes a zeroed checksum into every
      // Ogg page header, producing a technically-invalid stream that strict decoders
      // (ffmpeg) reject with "CRC mismatch". prism computes the checksum via the
      // native `node-crc` package (a direct dependency), so leave crc enabled.
      crc: true,
    });
    // Track size as data flows to the file.
    this.ogg.on("data", (chunk: Buffer) => {
      this.bytesWritten += chunk.length;
    });
    // Drop structurally-corrupt packets BEFORE they reach the Ogg framer. A
    // single empty or oversized buffer written as an Opus packet yields a stream
    // that strict decoders (ffmpeg / faster-whisper) reject outright — bailing on
    // the first bad packet and discarding the *entire* speaker's audio (this is
    // exactly how a track silently came back with 0 transcript segments). We can
    // only catch framing-level garbage here, not codec-level rot, but dropping it
    // keeps the rest of the track decodable instead of losing all of it.
    const sanitizer = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > MAX_OPUS_PACKET_BYTES) {
          this.droppedPackets++;
          cb(); // swallow the packet — emit nothing downstream
          return;
        }
        cb(null, chunk);
      },
    });
    // Count audio packets AFTER the sanitizer but BEFORE the Ogg framer (each
    // surviving chunk is one Opus packet), so audioMs() and the empty-skip in
    // stop() key off real, kept audio rather than the Ogg header or dropped junk.
    const counter = new Transform({
      transform: (chunk, _enc, cb) => {
        this.audioPackets++;
        cb(null, chunk);
      },
    });
    this.pipelinePromise = pipeline(opusPackets, sanitizer, counter, this.ogg, this.fileStream);
  }

  /** Resolves once the underlying pipeline has fully flushed and closed. */
  async finish(): Promise<{ bytesWritten: number; audioPackets: number; droppedPackets: number }> {
    if (!this.pipelinePromise)
      return { bytesWritten: 0, audioPackets: 0, droppedPackets: this.droppedPackets };
    try {
      await this.pipelinePromise;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ERR_STREAM_PREMATURE_CLOSE") {
        console.error(`[discord-bot] opus pipeline error for ${this.filePath}:`, err);
      }
      // premature close (teardown) is expected for the abort path; partial Ogg is still valid.
    }
    if (this.droppedPackets > 0) {
      console.warn(
        `[discord-bot] dropped ${this.droppedPackets} corrupt opus packet(s) for ${this.filePath} ` +
          `(kept ${this.audioPackets})`,
      );
    }
    return {
      bytesWritten: this.bytesWritten,
      audioPackets: this.audioPackets,
      droppedPackets: this.droppedPackets,
    };
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Talk-time written so far, in ms. Discord Opus frames are 20 ms each, and the
   * compacted file omits silence, so packets×20 equals the current playback
   * offset inside the .ogg — used to anchor each speaking burst's audio_offset_ms.
   */
  audioMs(): number {
    return this.audioPackets * 20;
  }
}
