import type { Options, Store } from 'express-rate-limit';
import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logging.js';

let rateLimitRedis: Redis | null = null;

export function getRateLimitRedisClient(): Redis {
    if (!rateLimitRedis) {
        rateLimitRedis = new Redis(config.redis.url, {
            // Rate-limit requests must fail promptly if Redis is unavailable;
            // the BullMQ client intentionally uses a different retry policy.
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            enableReadyCheck: true,
            connectTimeout: 1000,
        });
        rateLimitRedis.on('error', (error) => {
            logger.error({ error }, 'Rate-limit Redis client error');
        });
    }
    return rateLimitRedis;
}

export async function closeRateLimitRedis(): Promise<void> {
    if (rateLimitRedis) {
        await rateLimitRedis.quit();
        rateLimitRedis = null;
    }
}

/**
 * Shared rate-limit store for horizontally scaled API processes.
 * Redis failures are intentionally surfaced to express-rate-limit so its
 * default fail-closed behavior protects the API during store outages.
 */
export class RedisRateLimitStore implements Store {
    public readonly localKeys = false;
    private windowMs = 60_000;

    public init(options: Options): void {
        this.windowMs = options.windowMs;
    }

    public async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
        const redisKey = `${config.redis.keyPrefix}rate-limit:ip:${key}`;
        const redis = getRateLimitRedisClient();
        const totalHits = await redis.incr(redisKey);
        if (totalHits === 1) {
            await redis.pexpire(redisKey, this.windowMs);
        }

        return {
            totalHits,
            resetTime: new Date(Date.now() + await this.getTtl(redisKey)),
        };
    }

    public async decrement(key: string): Promise<void> {
        const redis = getRateLimitRedisClient();
        await redis.decr(`${config.redis.keyPrefix}rate-limit:ip:${key}`);
    }

    public async resetKey(key: string): Promise<void> {
        const redis = getRateLimitRedisClient();
        await redis.del(`${config.redis.keyPrefix}rate-limit:ip:${key}`);
    }

    private async getTtl(key: string): Promise<number> {
        const ttl = await getRateLimitRedisClient().pttl(key);
        return ttl > 0 ? ttl : this.windowMs;
    }
}
