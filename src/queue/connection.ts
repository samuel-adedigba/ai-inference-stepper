import type { ConnectionOptions } from 'bullmq';
import { config } from '../config.js';

/**
 * Build BullMQ's connection options from the configured Redis URL.
 *
 * BullMQ and the cache layer may resolve different ioredis type instances
 * under npm, so the queue should not receive the cache client's Redis object.
 */
export function getQueueConnection(): ConnectionOptions {
  return {
    url: config.redis.url,
    maxRetriesPerRequest: null,
  };
}
