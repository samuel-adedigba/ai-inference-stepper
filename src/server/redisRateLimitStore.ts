import type { Options, Store } from 'express-rate-limit';
import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logging.js';

let rateLimitRedis: Redis | null = null;
const RATE_LIMIT_REDIS_READY_TIMEOUT_MS = 2_000;

class RateLimitRedisUnavailableError extends Error {
    public readonly code = 'RATE_LIMIT_REDIS_NOT_READY';
    public readonly statusCode = 503;

    constructor() {
        super('Rate-limit Redis is not ready');
        this.name = 'RateLimitRedisUnavailableError';
    }
}

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
            const errorCode = typeof (error as NodeJS.ErrnoException).code === 'string'
                ? (error as NodeJS.ErrnoException).code
                : 'REDIS_RATE_LIMIT_ERROR';
            logger.error({ errorCode }, 'Rate-limit Redis client error');
        });
    }
    return rateLimitRedis;
}

/** Wait for the lazily-created Redis socket before issuing the first command. */
export async function getReadyRateLimitRedisClient(): Promise<Redis> {
    const redis = getRateLimitRedisClient();
    if (redis.status === 'ready') return redis;
    if (redis.status === 'end') throw new RateLimitRedisUnavailableError();

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            redis.off('ready', onReady);
            redis.off('error', onError);
            redis.off('end', onEnd);
        };
        const onReady = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new RateLimitRedisUnavailableError());
        };
        const onEnd = () => {
            cleanup();
            reject(new RateLimitRedisUnavailableError());
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new RateLimitRedisUnavailableError());
        }, RATE_LIMIT_REDIS_READY_TIMEOUT_MS);

        redis.once('ready', onReady);
        redis.once('error', onError);
        redis.once('end', onEnd);

        // The socket may have become ready between the initial check and the listeners.
        if (redis.status === 'ready') onReady();
    });

    return redis;
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
        const redis = await getReadyRateLimitRedisClient();
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
        const redis = await getReadyRateLimitRedisClient();
        await redis.decr(`${config.redis.keyPrefix}rate-limit:ip:${key}`);
    }

    public async resetKey(key: string): Promise<void> {
        const redis = await getReadyRateLimitRedisClient();
        await redis.del(`${config.redis.keyPrefix}rate-limit:ip:${key}`);
    }

    private async getTtl(key: string): Promise<number> {
        const ttl = await (await getReadyRateLimitRedisClient()).pttl(key);
        return ttl > 0 ? ttl : this.windowMs;
    }
}
