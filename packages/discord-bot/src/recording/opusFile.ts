import { createWriteStream, type WriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { opus } from "prism-media";

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

  constructor(private readonly filePath: string) {}

  /** Begin piping `opusPackets` into the Ogg container at `filePath`. */
  start(opusPackets: Readable): void {
    if (this.ogg) throw new Error("OpusFileWriter already started");
    this.fileStream = createWriteStream(this.filePath);
    this.ogg = new opus.OggLogicalBitstream({
      opusHead: new opus.OpusHead({ channelCount: 2, sampleRate: 48000 }),
      pageSizeControl: { maxPackets: 10 },
    });
    // Track size as data flows to the file.
    this.ogg.on("data", (chunk: Buffer) => {
      this.bytesWritten += chunk.length;
    });
    this.pipelinePromise = pipeline(opusPackets, this.ogg, this.fileStream);
  }

  /** Resolves once the underlying pipeline has fully flushed and closed. */
  async finish(): Promise<{ bytesWritten: number }> {
    if (!this.pipelinePromise) return { bytesWritten: 0 };
    try {
      await this.pipelinePromise;
    } catch {
      // Stream ended (manual end / disconnect); partial file is still valid Ogg.
    }
    return { bytesWritten: this.bytesWritten };
  }

  get path(): string {
    return this.filePath;
  }
}
