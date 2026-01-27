// packages/stepper/src/cache/redisCache.ts

import Redis from 'ioredis';
import { CacheEntry, ReportOutput, ProviderAttemptMeta } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logging.js';
import { sendDiscordAlert } from '../alerts/discord.js';

let redisClient: Redis | null = null;

/**
 * Get or create Redis client
 */
export function getRedisClient(): Redis {
    if (!redisClient) {
        redisClient = new Redis(config.redis.url, {
            maxRetriesPerRequest: null, // Required by BullMQ for blocking operations
            enableReadyCheck: true,
            lazyConnect: false,
        });

        redisClient.on('error', (err) => {
            logger.error({ err }, 'Redis client error');
            void sendDiscordAlert({
                title: 'Redis Connection Error',
                message: `Redis client encountered an error: ${err.message}`,
                severity: 'critical',
                metadata: { error: err.message, timestamp: new Date().toISOString() }
            });
        });

        redisClient.on('connect', () => {
            logger.info('Redis client connected');
        });
    }

    return redisClient;
}

/**
 * Build cache key for a report
 */
export function buildCacheKey(userId: string, commitSha: string, templateHash: string = 'default'): string {
    return `${config.redis.keyPrefix}report:${userId}:${commitSha}:${templateHash}`;
}

/**
 * Get cache entry: Looks up a report in the cache using its key. Like asking: "Do we already have a copy of this report?"
 */
export async function getReportCache(key: string): Promise<CacheEntry | null> {
    const redis = getRedisClient();

    try {
        const data = await redis.get(key);
        if (!data) return null;

        const entry: CacheEntry = JSON.parse(data);
        return entry;
    } catch (error) {
        logger.error({ error, key }, 'Failed to get cache entry');
        return null;
    }
}

/**
 * Set dehydrated cache entry (job enqueued)
 */
export async function setDehydrated(key: string, jobId: string): Promise<void> {
    const redis = getRedisClient();

    const entry: CacheEntry = {
        status: 'dehydrated', //Mark it as "in progress"
        jobId,
        timestamps: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        },
    };

    try {
        await redis.setex(key, config.cache.ttlSeconds, JSON.stringify(entry)); //Store in Redis with expiration time Default is 604,800 seconds = 7 days
        logger.debug({ key, jobId }, 'Created dehydrated cache entry');
    } catch (error) {
        logger.error({ error, key }, 'Failed to set dehydrated cache');
        throw error;
    }
}

/**
 * Set hydrated cache entry (report generated)
 * Stores a completed report in the cache. This is the "meal is ready!" moment.
 */
export async function setHydrated(
    key: string,
    result: ReportOutput,
    providersAttempted: ProviderAttemptMeta[],
    fallback: boolean = false,
    ttl?: number // How long to keep it	604800 (7 days in seconds)
): Promise<void> {
    const redis = getRedisClient();

    const entry: CacheEntry = {
        status: 'hydrated', // Report is complete
        result,
        providersAttempted,
        fallback,
        timestamps: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        },
        ttl: ttl || config.cache.ttlSeconds,
    };

    try {
        await redis.setex(key, ttl || config.cache.ttlSeconds, JSON.stringify(entry));
        logger.debug({ key, fallback }, 'Stored hydrated cache entry');
    } catch (error) {
        logger.error({ error, key }, 'Failed to set hydrated cache');
        throw error;
    }
}

/**
 * Mark cache entry as failed: Records that report generation failed completely. All AI providers were tried and none worked.
 */
export async function markFailed(key: string, errorMessage: string, providersAttempted: ProviderAttemptMeta[]): Promise<void> {
    const redis = getRedisClient();

    const entry: CacheEntry = {
        status: 'failed',
        error: errorMessage,
        providersAttempted,
        timestamps: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        },
    };

    try {
        await redis.setex(key, 3600, JSON.stringify(entry)); // Keep failed for 1 hour
        logger.debug({ key }, 'Marked cache entry as failed');
    } catch (error) {
        logger.error({ error, key }, 'Failed to mark cache as failed');
    }
}

/**
 * Check if hydrated entry is fresh
 */
export function isHydratedFresh(entry: CacheEntry): boolean {
    if (entry.status !== 'hydrated') return false; //Is this a complete report?

    const updatedAt = new Date(entry.timestamps.updated).getTime();
    const now = Date.now();
    const ageSeconds = (now - updatedAt) / 1000; //How old is this report?

    return ageSeconds < config.cache.staleThresholdSeconds;  //Is it younger than 24 hours?
}

/**
 * Check if entry is stale but usable for stale-while-revalidate: Checks if a report is old but still usable while a new one is being generated in the background.
 */
export function isStaleButUsable(entry: CacheEntry): boolean {
    if (entry.status !== 'hydrated') return false;
    if (!config.cache.enableStaleWhileRevalidate) return false;

    return !isHydratedFresh(entry);
}

/**
 * Delete cache entry: Removes the record from Redis immediately.
 * Call this once the backend has successfully saved the report to its database.
 */
export async function deleteCacheEntry(key: string): Promise<void> {
    const redis = getRedisClient();

    try {
        await redis.del(key);
        logger.debug({ key }, 'Deleted cache entry after successful delivery');
    } catch (error) {
        logger.error({ error, key }, 'Failed to delete cache entry');
    }
}

/**
 * Close Redis connection (for graceful shutdown)
 */
export async function closeRedis(): Promise<void> {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        logger.info('Redis client disconnected');
    }
}