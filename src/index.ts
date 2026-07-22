// packages/stepper/src/index.ts

import {
    PromptInput,
    ReportOutput,
    ProviderResult,
    StepperCallbacks,
    StepperConfig,
    ProviderConfig,
    StepperRequest,
    StepperProviderResult,
} from './types.js';
import { logger } from './logging.js';
import {
    getReportCache,
    buildRequestCacheKey,
    setDehydrated,
    isHydratedFresh,
    isStaleButUsable,
    deleteCacheEntry,
} from './cache/redisCache.js';
import { enqueueRequestJob, getJobStatus } from './queue/producer.js';
import { generateReportNow, generateRequestNow, registerCallbacks as registerOrchestratorCallbacks, initializeProviders, getProviderHealth } from './stepper/orchestrator.js';
import { recordCacheHit, recordCacheMiss } from './metrics/metrics.js';
import { applyConfigOverrides } from './config.js';
import { createCommitReportRequest, toCommitReportInput } from './presets/commit-report/request.js';
import { buildCommitReportCacheKey, buildCommitReportCacheKeyFromParts } from './presets/commit-report/cacheKey.js';
import { LEGACY_COMMIT_REPORT_API_DEPRECATION } from './deprecations.js';

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
export function initStepper(options?: { config?: Partial<StepperConfig>; providers?: ProviderConfig[] }): StepperConfig {
    const overrides: Partial<StepperConfig> = options?.config ? { ...options.config } : {};
    if (options?.providers) {
        overrides.providers = options.providers;
    }

    const nextConfig = applyConfigOverrides(overrides);
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
        timings: { totalMs: number; providerMs?: number };
      }
    | { status: 202; jobId: string; cached: false };

type EnqueueOptions = {
    priority?: number;
    callbackUrl?: string;
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

    const cached = await getReportCache(cacheKey);
    if (cached && cached.status === 'hydrated' && cached.result !== undefined) {
        const fresh = isHydratedFresh(cached);

        if (fresh) {
            recordCacheHit('fresh', context);
            logger.info({ cacheKey, ...logMeta }, 'Cache hit (fresh), returning and clearing');

            deleteCacheEntry(cacheKey).catch(err => {
                logger.error({ err, cacheKey }, 'Failed to cleanup cache after fresh hit');
            });

            return {
                status: 200,
                data: cached.result as TOutput,
                cached: true,
                usedProvider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
                fallback: cached.fallback || false,
                timings: cached.timings || { totalMs: 0 },
            };
        }

        if (isStaleButUsable(cached)) {
            recordCacheHit('stale', context);
            logger.info({ cacheKey, ...logMeta }, 'Cache hit (stale), scheduling refresh');

            enqueueRequestJob(request, cacheKey, { ...options, priority: 10 }).catch((err) => {
                logger.error({ err, cacheKey }, 'Failed to enqueue background refresh');
            });

            return {
                status: 200,
                data: cached.result as TOutput,
                cached: true,
                stale: true,
                usedProvider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
                fallback: cached.fallback || false,
                timings: cached.timings || { totalMs: 0 },
            };
        }
    }

    recordCacheMiss(context);
    logger.info({ cacheKey, ...logMeta }, 'Cache miss, enqueueing job');

    const jobId = await enqueueRequestJob(request, cacheKey, options);
    await setDehydrated(cacheKey, jobId);

    return { status: 202, jobId, cached: false };
}

/**
 * Internal legacy enqueue path kept stable during the generic migration.
 */
async function enqueueCommitReportInternal(input: PromptInput): Promise<EnqueueResult<ReportOutput>> {
    const request = createCommitReportRequest(input);
    const cacheKey = buildCommitReportCacheKey(input);
    const context = getRequestMetricsContext(request);
    return enqueueRequestInternal(request, cacheKey, context, {
        userId: input.userId,
        commitSha: input.commitSha,
        requestId: request.requestId,
    }, {
        callbackUrl: input.callbackUrl,
    });
}

/**
 * Enqueue a generic Stepper request.
 */
export async function enqueueRequest<TPayload = unknown, TOutput = unknown>(
    request: StepperRequest<TPayload, TOutput>
): Promise<EnqueueResult<TOutput>>;
export async function enqueueRequest(input: PromptInput): Promise<EnqueueResult<ReportOutput>>;
export async function enqueueRequest<TPayload = unknown, TOutput = unknown>(
    requestOrInput: StepperRequest<TPayload, TOutput> | PromptInput
): Promise<EnqueueResult<TOutput | ReportOutput>> {
    if ('userId' in requestOrInput && 'commitSha' in requestOrInput) {
        // Compatibility branch for callers still passing PromptInput directly.
        warnLegacyApiOnce('enqueueRequest(PromptInput)', 'enqueueRequest(createCommitReportRequest(input))');
        return enqueueCommitReportInternal(requestOrInput);
    }

    const request = requestOrInput as StepperRequest<TPayload, TOutput>;
    const context = getRequestMetricsContext(request);
    const cacheKey = buildRequestCacheKey(request);

    return enqueueRequestInternal(request, cacheKey, context, {
        requestId: request.requestId,
        tenantId: request.tenantId,
    });
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
    input: PromptInput
): Promise<EnqueueResult<ReportOutput>> {
    // Compatibility wrapper to preserve the existing CommitDiary contract.
    warnLegacyApiOnce(
        'enqueueReport',
        LEGACY_COMMIT_REPORT_API_DEPRECATION.replacementApis.enqueueReport
    );
    return enqueueCommitReportInternal(input);
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
/**
 * @deprecated Use preset cache helpers and generic cache lifecycle APIs.
 * Planned removal target: v2.0.0.
 */
export async function deleteReport(userId: string, commitSha: string, template?: string): Promise<void> {
    warnLegacyApiOnce(
        'deleteReport',
        LEGACY_COMMIT_REPORT_API_DEPRECATION.replacementApis.deleteReport
    );
    const cacheKey = buildCommitReportCacheKeyFromParts(userId, commitSha, template);
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
        providers: providerHealth.map((p) => ({ name: p.name, healthy: p.healthy })),
        timestamp: new Date().toISOString(),
    };
}

// Re-export types for consumers
export * from './types.js';
export * from './presets/commit-report/index.js';
export * from './presets/commit-report/request.js';
export * from './deprecations.js';
export { config } from './config.js';
