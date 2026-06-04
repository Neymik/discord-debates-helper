import { Worker, type Job } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { QUEUE_NAME } from "@debates/shared";
import type { Client, TextChannel } from "discord.js";
import type { BotConfig } from "../config.js";
import { buildAnnounceMessage, type AnnouncePayload } from "./message.js";

/**
 * The Discord bot owns ONLY `announce_t30` on the shared `game-events` queue.
 * Every other job type belongs to the Telegram bot. Because both bots attach a
 * Worker to the same queue, this worker must explicitly skip foreign jobs by
 * `job.name` and return early WITHOUT throwing (a thrown job is retried, which
 * would fight the Telegram bot). Returning resolves/acks the job for this
 * consumer; BullMQ delivers each job to exactly one worker, so the Telegram
 * bot's worker applies the same name-filter for its own set.
 */
export function shouldHandle(jobName: string): boolean {
  return jobName === "announce_t30";
}

interface AnnounceJobData {
  gameId: string;
  type: string;
  announce?: AnnouncePayload;
}

export function startAnnounceWorker(client: Client, cfg: BotConfig): Worker {
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<AnnounceJobData>(
    QUEUE_NAME,
    async (job: Job<AnnounceJobData>) => {
      if (!shouldHandle(job.name)) return; // foreign job → ack-and-ignore, no throw
      const payload: AnnouncePayload = job.data.announce ?? { motion: null, participants: [] };
      const message = buildAnnounceMessage(payload);
      const channel = await client.channels.fetch(cfg.announceChannelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send({
          content: message,
          allowedMentions: { parse: ["users"] },
        });
      } else {
        console.error(`[discord-bot] announce channel ${cfg.announceChannelId} not a text channel`);
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`[discord-bot] announce job ${job?.id} failed:`, err);
  });
  return worker;
}
