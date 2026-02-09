// packages/stepper/src/index.ts

import { PromptInput, ReportOutput, ProviderResult, StepperCallbacks } from './types.js';
import { logger } from './logging.js';
import {
    buildCacheKey,
    getReportCache,
    setDehydrated,
    isHydratedFresh,
    isStaleButUsable,
    deleteCacheEntry,
} from './cache/redisCache.js';
import { enqueueReportJob, getJobStatus } from './queue/producer.js';
import { generateReportNow, registerCallbacks as registerOrchestratorCallbacks, initializeProviders, getProviderHealth } from './stepper/orchestrator.js';
import { recordCacheHit, recordCacheMiss } from './metrics/metrics.js';
import crypto from 'crypto';

// Initialize providers on module load
initializeProviders();

/**
 * Compute template hash for cache key
 */
function computeTemplateHash(template?: string): string {
    const templateStr = template || 'default';
    return crypto.createHash('sha256').update(templateStr).digest('hex').slice(0, 16);
}

/**
 * Register lifecycle callbacks
 * 
 * @example
 * registerCallbacks({
 *   onSuccess: (jobId, provider, result) => {
 *     // handle success
 *   },
 *   onFallback: (jobId, result, meta) => {
 *     // handle fallback
 *   }
 * });
 */
export function registerCallbacks(callbacks: StepperCallbacks): void {
    registerOrchestratorCallbacks(callbacks);
    logger.info('Callbacks registered');
}

/**
 * Enqueue a report generation job (async, non-blocking)
 * 
 * Returns cached result immediately if available (fresh or stale),
 * or enqueues job and returns 202 status with jobId.
 * 
 * @param input - Commit information
 * @returns Promise with either immediate result or job info
 * 
 * @example
 * const result = await enqueueReport({
 *   userId: 'user_123',
 *   commitSha: 'abc123',
 *   repo: 'myorg/myrepo',
 *   message: 'Fix bug in auth',
 *   files: ['src/auth.ts'],
 *   components: ['auth'],
 *   diffSummary: '+ fixed token validation'
 * });
 * 
 * if (result.status === 200) {
 *   // handle cached result
 * } else {
 *   // handle enqueued result
 * }
 */
export async function enqueueReport(
    input: PromptInput
): Promise<
    | { status: 200; data: ReportOutput; cached: true; stale?: boolean }
    | { status: 202; jobId: string; cached: false }
> {
    const templateHash = computeTemplateHash(input.template);
    const cacheKey = buildCacheKey(input.userId, input.commitSha, templateHash);

    // Check cache
    const cached = await getReportCache(cacheKey);

    if (cached && cached.status === 'hydrated' && cached.result) {
        const fresh = isHydratedFresh(cached);

        if (fresh) {
            // Fresh cache hit - return immediately and cleanup
            recordCacheHit('fresh');
            logger.info({ cacheKey, userId: input.userId }, 'Cache hit (fresh), returning and clearing');

            // We clear immediately because caller is expected to save this
            deleteCacheEntry(cacheKey).catch(err => {
                logger.error({ err, cacheKey }, 'Failed to cleanup cache after fresh hit');
            });

            return { status: 200, data: cached.result, cached: true };
        }

        // Stale but usable - return and schedule background refresh
        if (isStaleButUsable(cached)) {
            recordCacheHit('stale');
            logger.info({ cacheKey, userId: input.userId }, 'Cache hit (stale), scheduling refresh');

            // Schedule low-priority background refresh
            enqueueReportJob(input, cacheKey, { priority: 10 }).catch((err) => {
                logger.error({ err, cacheKey }, 'Failed to enqueue background refresh');
            });

            return { status: 200, data: cached.result, cached: true, stale: true };
        }
    }

    // Cache miss or dehydrated - enqueue job
    recordCacheMiss();
    logger.info({ cacheKey, userId: input.userId }, 'Cache miss, enqueueing job');

    const jobId = await enqueueReportJob(input, cacheKey);

    // Create dehydrated placeholder
    await setDehydrated(cacheKey, jobId);

    return { status: 202, jobId, cached: false };
}

/**
 * Generate report synchronously (blocking, immediate)
 * 
 * Useful for testing or when you need the result immediately.
 * This bypasses the queue and calls providers directly.
 * 
 * @param input - Commit information
 * @returns Promise with generated report and metadata
 * 
 * @example
 * const result = await generateReportNow({
 *   userId: 'user_123',
 *   commitSha: 'abc123',
 *   repo: 'myorg/myrepo',
 *   message: 'Refactor API',
 *   files: ['src/api.ts'],
 *   components: ['api'],
 *   diffSummary: '- old code\n+ new code'
 * });
 * 
 * // handle provider and report result
 */
export async function generateReport(input: PromptInput): Promise<ProviderResult> {
    const jobId = `sync_${Date.now()}`;
    return generateReportNow(input, jobId);
}

/**
 * Get job status by ID
 * 
 * @param jobId - Job identifier returned from enqueueReport
 * @returns Job status information or null if not found
 */
export async function getJob(jobId: string): Promise<{
    id: string;
    state: string;
    progress?: number;
    result?: unknown;
    failedReason?: string;
    data?: unknown;
} | null> {
    return getJobStatus(jobId);
}

/**
 * Delete a cached report entry.
 * 
 * Call this once you have successfully saved the report to your own database
 * to keep the Stepper's Redis storage footprint minimal.
 * 
 * @param userId - User identifier
 * @param commitSha - Commit SHA
 * @param template - Template name (optional)
 */
export async function deleteReport(userId: string, commitSha: string, template?: string): Promise<void> {
    const templateHash = computeTemplateHash(template);
    const cacheKey = buildCacheKey(userId, commitSha, templateHash);
    await deleteCacheEntry(cacheKey);
}

/**
 * Health check - returns provider status and system health
 */
export async function healthcheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    providers: Array<{ name: string; healthy: boolean }>;
    timestamp: string;
}> {
    const providerHealth = getProviderHealth();
    const healthyCount = providerHealth.filter((p) => p.healthy).length;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (healthyCount === 0) {
        status = 'unhealthy';
    } else if (healthyCount < providerHealth.length) {
        status = 'degraded';
    } else {
        status = 'healthy';
    }

    return {
        status,
        providers: providerHealth.map((p) => ({ name: p.name, healthy: p.healthy })),
        timestamp: new Date().toISOString(),
    };
}

// Re-export types for consumers
export * from './types.js';
export { config } from './config.js';
