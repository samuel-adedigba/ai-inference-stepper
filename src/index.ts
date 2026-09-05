// packages/stepper/src/index.ts

import {
    PromptInput,
    ReportOutput,
    ProviderResult,
    StepperCallbacks,
    StepperConfig,
    StepperConfigOverrides,
    ProviderConfig,
    StepperRequest,
    StepperProviderResult,
    StepperBatchRequest,
} from './types.js';
import { logger } from './logging.js';
import {
    getReportCache,
    buildRequestCacheKey,
    scopeCacheKeyToOwner,
    claimDehydrated,
    setDehydrated,
    claimStaleRefresh,
    isHydratedFresh,
    isStaleButUsable,
    deleteCacheEntry,
    releaseDehydratedClaim,
} from './cache/redisCache.js';
import { enqueueBatchJob, enqueueRequestJob, getJobStatus } from './queue/producer.js';
import { generateReportNow, generateRequestNow, registerCallbacks as registerOrchestratorCallbacks, initializeProviders, getProviderHealth } from './stepper/orchestrator.js';
import { recordCacheHit, recordCacheMiss } from './metrics/metrics.js';
import { applyConfigOverrides, assertRuntimeConfig, config } from './config.js';
import { createCommitReportRequest, toCommitReportInput } from './presets/commit-report/request.js';
import { buildCommitReportCacheKey, buildCommitReportCacheKeyFromParts } from './presets/commit-report/cacheKey.js';
import { LEGACY_COMMIT_REPORT_API_DEPRECATION } from './deprecations.js';
import { validateBatchEnvelope } from './validation/batch.js';
import { randomUUID } from 'node:crypto';

let isInitialized = false;
const emittedLegacyApiWarnings = new Set<string>();

function warnLegacyApiOnce(apiName: string, replacement: string): void {
    if (emittedLegacyApiWarnings.has(apiName)) {
        return;
    }

    emittedLegacyApiWarnings.add(apiName);
    logger.warn(
        {
            api: apiName,
            replacement,
            removalTarget: LEGACY_COMMIT_REPORT_API_DEPRECATION.removalTarget,
            softDeprecationDate: LEGACY_COMMIT_REPORT_API_DEPRECATION.softDeprecationDate,
        },
        'Legacy CommitDiary API in use; migrate to generic request API'
    );
}

function ensureInitialized(): void {
    if (!isInitialized) {
        const existingProviders = getProviderHealth();
        if (existingProviders.length > 0) {
            isInitialized = true;
            return;
        }
        initStepper();
    }
}

/**
 * Initialize Stepper with optional config overrides.
 * Useful for npm consumers who want programmatic config instead of env.
 */
export function initStepper(options?: { config?: StepperConfigOverrides<StepperConfig>; providers?: ProviderConfig[] }): StepperConfig {
    const overrides: StepperConfigOverrides<StepperConfig> = options?.config ? { ...options.config } : {};
    if (options?.providers) {
        overrides.providers = options.providers;
    }

    const nextConfig = applyConfigOverrides(overrides);
    assertRuntimeConfig(nextConfig);
    initializeProviders(nextConfig.providers);
    isInitialized = true;
    return nextConfig;
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

type EnqueueResult<TOutput> =
    | {
        status: 200;
        data: TOutput;
        cached: true;
        stale?: boolean;
        usedProvider: string;
        fallback: boolean;
        validated: boolean;
        timings: { totalMs: number; providerMs?: number };
      }
    | { status: 202; jobId: string; cached: false };

export type EnqueueOptions = {
    priority?: number;
    callbackUrl?: string;
    /** Internal HTTP ownership binding; never expose this value in responses. */
    ownerKey?: string;
};

function getRequestMetricsContext(request: StepperRequest<unknown, unknown>): { preset: 'commit-report' | 'generic'; responseMode: 'json' | 'text' } {
    const commitInput = toCommitReportInput(request);
    return {
        preset: commitInput ? 'commit-report' : 'generic',
        responseMode: request.responseMode === 'text' ? 'text' : 'json',
    };
}

async function enqueueRequestInternal<TPayload = unknown, TOutput = unknown>(
    request: StepperRequest<TPayload, TOutput>,
    cacheKey: string,
    context: { preset: 'commit-report' | 'generic'; responseMode: 'json' | 'text' },
    logMeta: Record<string, unknown>,
    options: EnqueueOptions = {}
): Promise<EnqueueResult<TOutput>> {
    ensureInitialized();

    const cached = request.cacheControl === 'no-cache' || request.cacheControl === 'refresh'
        ? null
        : await getReportCache(cacheKey);
    if (cached && cached.status === 'hydrated' && cached.result !== undefined) {
        const fresh = isHydratedFresh(cached);

        if (fresh) {
            recordCacheHit('fresh', context);
            logger.info({ cacheKey, ...logMeta }, 'Cache hit (fresh), returning and clearing');

            deleteCacheEntry(cacheKey).catch(() => {
                logger.error({ errorCode: 'CACHE_CLEANUP_FAILED', cacheKey }, 'Failed to cleanup cache after fresh hit');
            });

            return {
                status: 200,
                data: cached.result as TOutput,
                cached: true,
                usedProvider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
                fallback: cached.fallback || false,
                validated: cached.validated ?? !cached.fallback,
                timings: cached.timings || { totalMs: 0 },
            };
        }

        if (isStaleButUsable(cached)) {
            recordCacheHit('stale', context);
            logger.info({ cacheKey, ...logMeta }, 'Cache hit (stale), scheduling refresh');

            const refreshJobId = randomUUID();
            claimStaleRefresh(cacheKey, refreshJobId, cached.timestamps.updated)
                .then(async (claim) => {
                    if (claim.state !== 'claimed') return;
                    try {
                        await enqueueRequestJob(request, cacheKey, { ...options, priority: 10, jobId: refreshJobId });
                    } catch (error) {
                        await releaseDehydratedClaim(cacheKey, refreshJobId).catch(() => {
                            logger.error({ errorCode: 'CACHE_REFRESH_CLAIM_RELEASE_FAILED', cacheKey }, 'Failed to release refresh claim');
                        });
                        throw error;
                    }
                })
                .catch(() => {
                    logger.error({ errorCode: 'CACHE_REFRESH_ENQUEUE_FAILED', cacheKey }, 'Failed to enqueue background refresh');
                });

            return {
                status: 200,
                data: cached.result as TOutput,
                cached: true,
                stale: true,
                usedProvider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
                fallback: cached.fallback || false,
                validated: cached.validated ?? !cached.fallback,
                timings: cached.timings || { totalMs: 0 },
            };
        }
    }

    recordCacheMiss(context);
    logger.info({ cacheKey, ...logMeta }, 'Cache miss, enqueueing job');

    const proposedJobId = randomUUID();
    if (request.cacheControl === 'no-cache' || request.cacheControl === 'refresh') {
        // These modes explicitly request a new generation and therefore opt out
        // of cache-key deduplication by contract.
        const jobId = await enqueueRequestJob(request, cacheKey, { ...options, jobId: proposedJobId });
        return { status: 202, jobId, cached: false };
    }

    // Reserve the key before queue insertion. This is a distributed idempotency
    // gate for multiple Stepper instances sharing Redis.
    let claim: Awaited<ReturnType<typeof claimDehydrated>>;
    try {
        claim = await claimDehydrated(cacheKey, proposedJobId);
    } catch (error) {
        // Local/library development may intentionally run without Redis. Keep
        // that mode usable, while production fails closed to avoid duplicate
        // provider spend when the idempotency gate is unavailable.
        if (process.env.NODE_ENV === 'production') throw error;
        logger.warn({ cacheKey }, 'Cache claim unavailable outside production; queueing without distributed deduplication');
        const jobId = await enqueueRequestJob(request, cacheKey, { ...options, jobId: proposedJobId });
        await setDehydrated(cacheKey, jobId).catch(() => undefined);
        return { status: 202, jobId, cached: false };
    }
    if (claim.state === 'existing' && claim.jobId) {
        return { status: 202, jobId: claim.jobId, cached: false };
    }
    if (claim.state === 'hydrated') {
        // Another worker completed the request between the initial read and the
        // claim. Re-read rather than paying for a second provider call.
        const completed = await getReportCache(cacheKey);
        if (completed?.status === 'hydrated' && completed.result !== undefined) {
            return {
                status: 200,
                data: completed.result as TOutput,
                cached: true,
                usedProvider: completed.usedProvider || (completed.fallback ? 'fallback' : 'cache'),
                fallback: completed.fallback || false,
                validated: completed.validated ?? !completed.fallback,
                timings: completed.timings || { totalMs: 0 },
            };
        }
        throw new Error('Cache claim lost before queue insertion; retry request');
    }

    let jobId: string;
    try {
        jobId = await enqueueRequestJob(request, cacheKey, { ...options, jobId: proposedJobId });
    } catch (error) {
        await releaseDehydratedClaim(cacheKey, proposedJobId).catch(() => {
            logger.error({ errorCode: 'CACHE_CLAIM_RELEASE_FAILED', cacheKey }, 'Failed to release cache claim after queue failure');
        });
        throw error;
    }

    return { status: 202, jobId, cached: false };
}

/**
 * Internal legacy enqueue path kept stable during the generic migration.
 */
async function enqueueCommitReportInternal(input: PromptInput, options: EnqueueOptions = {}): Promise<EnqueueResult<ReportOutput>> {
    const request = createCommitReportRequest(input);
    const cacheKey = scopeCacheKeyToOwner(buildCommitReportCacheKey(input), options.ownerKey);
    const context = getRequestMetricsContext(request);
    return enqueueRequestInternal(request, cacheKey, context, {
        userId: input.userId,
        commitSha: input.commitSha,
        requestId: request.requestId,
    }, { ...options, callbackUrl: input.callbackUrl });
}

/**
 * Enqueue a generic Stepper request.
 */
export async function enqueueRequest<TPayload = unknown, TOutput = unknown>(
    request: StepperRequest<TPayload, TOutput>,
    options?: EnqueueOptions,
): Promise<EnqueueResult<TOutput>>;
export async function enqueueRequest(input: PromptInput, options?: EnqueueOptions): Promise<EnqueueResult<ReportOutput>>;
export async function enqueueRequest<TPayload = unknown, TOutput = unknown>(
    requestOrInput: StepperRequest<TPayload, TOutput> | PromptInput,
    options: EnqueueOptions = {},
): Promise<EnqueueResult<TOutput | ReportOutput>> {
    if ('userId' in requestOrInput && 'commitSha' in requestOrInput) {
        // Compatibility branch for callers still passing PromptInput directly.
        warnLegacyApiOnce('enqueueRequest(PromptInput)', 'enqueueRequest(createCommitReportRequest(input))');
        return enqueueCommitReportInternal(requestOrInput, options);
    }

    const request = requestOrInput as StepperRequest<TPayload, TOutput>;
    const context = getRequestMetricsContext(request);
    const cacheKey = buildRequestCacheKey(request, options.ownerKey);

    return enqueueRequestInternal(request, cacheKey, context, {
        requestId: request.requestId,
        tenantId: request.tenantId,
    }, options);
}

/**
 * Enqueue independently identified generic requests as one bounded-concurrency job.
 * Results retain the input order and item IDs.
 */
export async function enqueueBatch(batch: StepperBatchRequest, options: { ownerKey?: string } = {}): Promise<{
    status: 202;
    jobId: string;
    itemCount: number;
    concurrency: number;
}> {
    const envelope = validateBatchEnvelope(batch, {
        maxItems: config.batch.maxItems,
        maxConcurrency: config.batch.maxConcurrency,
    });
    if (!envelope.valid) {
        throw new Error(envelope.error);
    }

    const items = envelope.batch.items.map((item) => {
        if (!('prompt' in item.request)) {
            throw new Error(`Invalid items[].request for '${item.id}': missing required field: prompt`);
        }

        return {
            id: item.id,
            request: {
                ...(item.request as unknown as StepperRequest<unknown, unknown>),
                tenantId: (item.request.tenantId as string | undefined) || envelope.batch.tenantId,
                requestId: (item.request.requestId as string | undefined)
                    || `${envelope.batch.requestId || 'batch'}:${item.id}`,
            },
        };
    });
    const concurrency = envelope.batch.concurrency;

    ensureInitialized();
    const jobId = await enqueueBatchJob({
        tenantId: envelope.batch.tenantId,
        requestId: envelope.batch.requestId,
        items,
        concurrency,
    }, options);
    return { status: 202, jobId, itemCount: items.length, concurrency };
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
/**
 * @deprecated Use `enqueueRequest(createCommitReportRequest(input))`.
 * Planned removal target: v2.0.0.
 */
export async function enqueueReport(
    input: PromptInput,
    options?: EnqueueOptions,
): Promise<EnqueueResult<ReportOutput>> {
    // Compatibility wrapper to preserve the existing CommitDiary contract.
    warnLegacyApiOnce(
        'enqueueReport',
        LEGACY_COMMIT_REPORT_API_DEPRECATION.replacementApis.enqueueReport
    );
    return enqueueCommitReportInternal(input, options);
}

/**
 * Generate immediately from a generic Stepper request.
 */
export async function generateRequest<TPayload = unknown, TOutput = unknown>(
    request: StepperRequest<TPayload, TOutput>
): Promise<StepperProviderResult<TOutput>>;
export async function generateRequest(input: PromptInput): Promise<ProviderResult>;
export async function generateRequest<TPayload = unknown, TOutput = unknown>(
    requestOrInput: StepperRequest<TPayload, TOutput> | PromptInput
): Promise<StepperProviderResult<TOutput | ReportOutput>> {
    if ('userId' in requestOrInput && 'commitSha' in requestOrInput) {
        // Compatibility branch for callers still passing PromptInput directly.
        warnLegacyApiOnce('generateRequest(PromptInput)', 'generateRequest(createCommitReportRequest(input))');
        ensureInitialized();
        const jobId = `sync_${Date.now()}`;
        return generateReportNow(requestOrInput, jobId);
    }

    ensureInitialized();
    const request = requestOrInput as StepperRequest<TPayload, TOutput>;
    const jobId = request.requestId ? `sync_${request.requestId}` : `sync_${Date.now()}`;
    const result = await generateRequestNow<TOutput>(request, jobId);
    return result as StepperProviderResult<TOutput>;
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
/**
 * @deprecated Use `generateRequest(createCommitReportRequest(input))`.
 * Planned removal target: v2.0.0.
 */
export async function generateReport(input: PromptInput): Promise<ProviderResult> {
    // Compatibility wrapper to preserve the existing CommitDiary contract.
    warnLegacyApiOnce(
        'generateReport',
        LEGACY_COMMIT_REPORT_API_DEPRECATION.replacementApis.generateReport
    );
    const request = createCommitReportRequest(input);
    return generateRequest<PromptInput, ReportOutput>(request);
}

/**
 * Get job status by ID
 * 
 * @param jobId - Job identifier returned from enqueueReport
 * @returns Job status information or null if not found
 */
export async function getJob(jobId: string, options: { includeData?: boolean } = {}): Promise<{
    id: string;
    state: string;
    progress?: unknown;
    result?: unknown;
    failedReason?: string;
    data?: unknown;
} | null> {
    return getJobStatus(jobId, options);
}

/**
 * Delete a cached report entry.
 *
 * Call this once you have successfully saved the report to your own database
 * to keep the Stepper's Redis storage footprint minimal.
 *
 * Pass the same `ownerKey` used at enqueue time so the scoped entry is
 * removed. Omitting it deletes only the legacy unscoped key (in-process
 * single-tenant callers).
 *
 * @param userId - User identifier
 * @param commitSha - Commit SHA
 * @param template - Template name (optional)
 * @param ownerKey - Non-reversible digest of the API key that created the job (optional)
 */
/**
 * @deprecated Use preset cache helpers and generic cache lifecycle APIs.
 * Planned removal target: v2.0.0.
 */
export async function deleteReport(userId: string, commitSha: string, template?: string, ownerKey?: string): Promise<void> {
    warnLegacyApiOnce(
        'deleteReport',
        LEGACY_COMMIT_REPORT_API_DEPRECATION.replacementApis.deleteReport
    );
    const cacheKey = scopeCacheKeyToOwner(buildCommitReportCacheKeyFromParts(userId, commitSha, template), ownerKey);
    await deleteCacheEntry(cacheKey);
}

/**
 * Health check - returns provider status and system health
 */
export async function healthcheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    providers: Array<{
        name: string;
        healthy: boolean;
        circuitOpen: boolean;
        retryAfterSeconds: number;
        lastChecked: string;
        inferredFrom: 'circuit_breaker';
        supportsBatch: false;
        maxTokens: number | null;
    }>;
    timestamp: string;
}> {
    ensureInitialized();
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
        providers: providerHealth,
        timestamp: new Date().toISOString(),
    };
}

// Re-export types for consumers
export * from './types.js';
export * from './presets/commit-report/index.js';
export * from './presets/commit-report/request.js';
export * from './deprecations.js';
export { config } from './config.js';
