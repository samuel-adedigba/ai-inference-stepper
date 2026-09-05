// packages/stepper/src/cache/redisCache.ts

import Redis from 'ioredis';
import crypto from 'crypto';
import { CacheEntry, JobFailure, ProviderAttemptMeta, StepperRequest } from '../types.js';
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
            // Cache commands must fail promptly. The queue has its own BullMQ
            // connection and is the only client that needs blocking retries.
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: 1000,
            commandTimeout: 3000,
            enableReadyCheck: true,
            lazyConnect: false,
        });

        redisClient.on('error', (err) => {
            const errorCode = typeof (err as NodeJS.ErrnoException).code === 'string'
                ? (err as NodeJS.ErrnoException).code
                : 'REDIS_CONNECTION_ERROR';
            logger.error({ errorCode }, 'Redis client error');
            void sendDiscordAlert({
                title: 'Redis Connection Error',
                message: 'Redis client encountered a connection error.',
                severity: 'critical',
                metadata: { errorCode, timestamp: new Date().toISOString() }
            });
        });

        redisClient.on('connect', () => {
            logger.info('Redis client connected');
        });
    }

    return redisClient;
}

function stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value);
    }

    if (typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const objectValue = value as Record<string, unknown>;
    const serialized = sortedKeys.map((key) => `"${key}":${stableStringify(objectValue[key])}`);
    return `{${serialized.join(',')}}`;
}

function getOutputSchemaFingerprint(request: StepperRequest<unknown, unknown>): string {
    if (!request.outputSchema) {
        return 'none';
    }

    // We only include serializable identity hints, not full runtime schema internals.
    if (request.outputSchema.kind === 'zod') {
        return 'zod';
    }

    return 'custom';
}

/**
 * Build generic cache key for any Stepper request.
 *
 * Priority order:
 * 1) request.cacheKey (consumer-controlled stable identity)
 * 2) deterministic hash from request identity + prompt/payload fingerprint
 *
 * Caller-controlled keys are always namespaced by `ownerKey` (a
 * non-reversible hash of the authenticated API key) when one is supplied, so
 * one tenant can never read, overwrite, or clear another tenant's entry.
 * HTTP adapters must always pass the authenticated owner; omitting it is only
 * valid for single-tenant in-process use.
 */
export function buildRequestCacheKey<TPayload = unknown, TOutput = unknown>(
    request: StepperRequest<TPayload, TOutput>,
    ownerKey?: string,
): string {
    const ownerScope = ownerKey
        ? `owner:${crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 24)}:`
        : '';

    if (request.cacheKey && request.cacheKey.trim().length > 0) {
        const customKeyHash = crypto.createHash('sha256').update(request.cacheKey.trim()).digest('hex');
        return `${config.redis.keyPrefix}req:${ownerScope}custom:${customKeyHash}`;
    }

    const fingerprintSource = {
        tenantId: request.tenantId || 'public',
        requestId: request.requestId || 'auto',
        responseMode: request.responseMode || 'json',
        contractVersion: request.contractVersion || '1',
        prompt: request.prompt,
        payload: request.payload,
        outputSchema: getOutputSchemaFingerprint(request as StepperRequest<unknown, unknown>),
    };

    const hash = crypto
        .createHash('sha256')
        .update(stableStringify(fingerprintSource))
        .digest('hex')
        .slice(0, 24);

    return `${config.redis.keyPrefix}req:${ownerScope}${request.tenantId || 'public'}:${request.requestId || 'auto'}:${hash}`;
}

/** Bind compatibility cache keys to the authenticated HTTP owner. */
export function scopeCacheKeyToOwner(cacheKey: string, ownerKey?: string): string {
    if (!ownerKey) return cacheKey;
    const ownerScope = crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 24);
    return `${config.redis.keyPrefix}owner:${ownerScope}:${crypto.createHash('sha256').update(cacheKey).digest('hex')}`;
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
    } catch {
        logger.error({ errorCode: 'CACHE_READ_FAILED', key }, 'Failed to get cache entry');
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
    } catch {
        logger.error({ errorCode: 'CACHE_DEHYDRATED_WRITE_FAILED', key }, 'Failed to set dehydrated cache');
        // Queue insertion is the durable hand-off. A cache outage must not
        // cause the caller to retry and enqueue a second paid job.
    }
}

/**
 * Atomically reserve a cache key before queue insertion. Without this claim,
 * two concurrent cache misses can both enqueue provider work before either
 * process writes the dehydrated marker.
 */
export async function claimDehydrated(key: string, jobId: string): Promise<{ state: 'claimed' | 'existing' | 'hydrated'; jobId?: string }> {
    const redis = getRedisClient();
    const entry: CacheEntry = {
        status: 'dehydrated',
        jobId,
        timestamps: { created: new Date().toISOString(), updated: new Date().toISOString() },
    };
    const script = `
        local current = redis.call('GET', KEYS[1])
        if not current then
            redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1])
            return {'claimed', ARGV[3]}
        end
        local ok, decoded = pcall(cjson.decode, current)
        if ok and decoded.status == 'dehydrated' and type(decoded.jobId) == 'string' then
            return {'existing', decoded.jobId}
        end
        if ok and decoded.status == 'failed' then
            redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1])
            return {'claimed', ARGV[3]}
        end
        return {'hydrated', ''}
    `;
    const result = await redis.eval(script, 1, key, JSON.stringify(entry), String(config.cache.ttlSeconds), jobId) as string[];
    const state = result?.[0];
    if (state === 'claimed' || state === 'existing' || state === 'hydrated') {
        return { state, jobId: result[1] || undefined };
    }
    throw new Error('Invalid cache claim response');
}

/** Release only the marker created by this enqueue attempt. */
export async function releaseDehydratedClaim(key: string, jobId: string): Promise<void> {
    const redis = getRedisClient();
    const script = `
        local current = redis.call('GET', KEYS[1])
        if not current then return 0 end
        local ok, decoded = pcall(cjson.decode, current)
        if ok and decoded.status == 'dehydrated' and decoded.jobId == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
    `;
    await redis.eval(script, 1, key, jobId);
}

/** Claim a stale hydrated entry for one refresh, using the observed version as a CAS token. */
export async function claimStaleRefresh(
    key: string,
    jobId: string,
    expectedUpdatedAt: string,
): Promise<{ state: 'claimed' | 'existing' | 'changed'; jobId?: string }> {
    const redis = getRedisClient();
    const entry: CacheEntry = {
        status: 'dehydrated',
        jobId,
        timestamps: { created: new Date().toISOString(), updated: new Date().toISOString() },
    };
    const script = `
        local current = redis.call('GET', KEYS[1])
        if not current then return {'changed', ''} end
        local ok, decoded = pcall(cjson.decode, current)
        if not ok then return {'changed', ''} end
        if decoded.status == 'dehydrated' and type(decoded.jobId) == 'string' then
            return {'existing', decoded.jobId}
        end
        if decoded.status == 'hydrated' and decoded.timestamps.updated == ARGV[3] then
            redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1])
            return {'claimed', ARGV[4]}
        end
        return {'changed', ''}
    `;
    const result = await redis.eval(
        script,
        1,
        key,
        JSON.stringify(entry),
        String(config.cache.ttlSeconds),
        expectedUpdatedAt,
        jobId,
    ) as string[];
    const state = result?.[0];
    if (state === 'claimed' || state === 'existing' || state === 'changed') {
        return { state, jobId: result[1] || undefined };
    }
    throw new Error('Invalid stale refresh claim response');
}

/**
 * Set hydrated cache entry (report generated)
 * Stores a completed report in the cache. This is the "meal is ready!" moment.
 */
export async function setHydrated(
    key: string,
    result: unknown,
    providersAttempted: ProviderAttemptMeta[],
    fallback: boolean = false,
    ttl?: number, // How long to keep it	604800 (7 days in seconds)
    provenance?: {
        usedProvider: string;
        timings: { totalMs: number; providerMs?: number };
        validated?: boolean;
    }
): Promise<void> {
    const redis = getRedisClient();

    const entry: CacheEntry = {
        status: 'hydrated', // Report is complete
        result,
        providersAttempted,
        fallback,
        usedProvider: provenance?.usedProvider,
        timings: provenance?.timings,
        validated: provenance?.validated,
        timestamps: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        },
        ttl: ttl || config.cache.ttlSeconds,
    };

    try {
        await redis.setex(key, ttl || config.cache.ttlSeconds, JSON.stringify(entry));
        logger.debug({ key, fallback }, 'Stored hydrated cache entry');
    } catch {
        logger.error({ errorCode: 'CACHE_HYDRATED_WRITE_FAILED', key }, 'Failed to set hydrated cache');
        // Cache persistence is an optimization. The worker has already paid for
        // and produced the result, so a cache outage must not trigger a provider
        // retry and duplicate external API spend.
    }
}

/**
 * Mark cache entry as failed: Records that report generation failed completely. All AI providers were tried and none worked.
 */
export async function markFailed(
    key: string,
    errorMessage: string,
    providersAttempted: ProviderAttemptMeta[],
    failure?: JobFailure
): Promise<void> {
    const redis = getRedisClient();

    const entry: CacheEntry = {
        status: 'failed',
        error: errorMessage,
        providersAttempted,
        failure,
        timestamps: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        },
    };

    try {
        await redis.setex(key, 3600, JSON.stringify(entry)); // Keep failed for 1 hour
        logger.debug({ key }, 'Marked cache entry as failed');
    } catch {
        logger.error({ errorCode: 'CACHE_FAILURE_WRITE_FAILED', key }, 'Failed to mark cache as failed');
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
    } catch {
        logger.error({ errorCode: 'CACHE_DELETE_FAILED', key }, 'Failed to delete cache entry');
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
