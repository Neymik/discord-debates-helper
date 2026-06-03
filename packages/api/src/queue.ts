import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { QUEUE_NAME } from "@debates/shared";
import { buildConfig } from "./config.js";

const config = buildConfig();

// Shared ioredis connection for non-BullMQ consumers.
// BullMQ requires maxRetriesPerRequest: null on its connection.
export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

// Pass a plain RedisOptions object to BullMQ's Queue to avoid the dual-ioredis
// package type conflict between top-level ioredis and BullMQ's bundled ioredis.
export const gameEventsQueue = new Queue(QUEUE_NAME, {
  connection: { url: config.redisUrl, maxRetriesPerRequest: null },
});
