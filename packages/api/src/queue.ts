import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { QUEUE_NAME } from "@debates/shared";
import { buildConfig } from "./config.js";

const config = buildConfig();

// BullMQ requires maxRetriesPerRequest: null on the shared connection.
export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export const gameEventsQueue = new Queue(QUEUE_NAME, { connection });
