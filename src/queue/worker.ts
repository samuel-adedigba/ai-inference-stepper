// packages/stepper/src/queue/worker.ts`

import { Worker, Job } from 'bullmq';
import {
    setHydrated,
    markFailed,
    getReportCache,
    isHydratedFresh,
    buildRequestCacheKey,
} from '../cache/redisCache.js';
import { AllProvidersFailedError, AllProvidersRateLimitedError, generateRequestNow } from '../stepper/orchestrator.js';
import { JobFailure, ProviderErrorType, StepperBatchItemResult, StepperBatchResult, StepperCallbackPayload, StepperJobData, StepperProviderResult } from '../types.js';
import { ProviderError } from '../providers/provider.interface.js';
import { config } from '../config.js';
import { logger, createChildLogger } from '../logging.js';
import { recordJobProcessed, recordJobFailed } from '../metrics/metrics.js';
import { sendDiscordAlert } from '../alerts/discord.js';
import { notifyWebhookSuccess, notifyWebhookFailure } from '../webhooks/delivery.js';
import { deliverRequestCallbacks } from '../webhooks/requestCallbacks.js';
import { getCallbackLogOrigin } from '../security/callbackUrls.js';
import { toCommitReportInput } from '../presets/commit-report/request.js';
import { getQueueConnection } from './connection.js';
import { StepperBatchQueueJobData } from './producer.js';

let worker: Worker<StepperJobData<unknown, unknown>> | null = null;
let batchWorker: Worker<StepperBatchQueueJobData> | null = null;

function handleWorkerSystemError(error: Error, queueType: 'single' | 'batch'): void {
    const errorCode = typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code
        : 'WORKER_SYSTEM_ERROR';

    logger.error({
        err: error,
        errorCode,
        queueType,
    }, 'Worker error');
    void sendDiscordAlert({
        title: 'Worker System Error',
        message: `The ${queueType} job queue worker encountered a system error.`,
        severity: 'critical',
        metadata: { errorCode, queueType }
    });
}

function getFailure(error: unknown): JobFailure {
    const transientProviderErrors: ProviderErrorType[] = [
        ProviderErrorType.RateLimit,
        ProviderErrorType.Timeout,
        ProviderErrorType.Unavailable,
    ];
    const errorCode = error instanceof ProviderError
        ? error.type
        : error instanceof AllProvidersRateLimitedError
            ? ProviderErrorType.RateLimit
            : error instanceof AllProvidersFailedError
                ? error.errorCode
                : ProviderErrorType.Unknown;
    const message = error instanceof AllProvidersRateLimitedError
        ? 'All providers are currently rate-limited. Retry later.'
        : error instanceof AllProvidersFailedError
            ? 'All configured providers failed. Retry later.'
            : error instanceof ProviderError
                ? 'Provider request failed.'
                : 'Generation failed. Retry later.';
    const failure: JobFailure = error instanceof AllProvidersFailedError
        ? {
            errorCode,
            message,
            retryable: error.retryable,
            providersAttempted: error.providersAttempted.map(({ provider, attemptNumber, errorCode: attemptCode, durationMs, retryAfterSeconds, skipped }) => ({
                provider,
                attemptNumber,
                errorCode: attemptCode,
                durationMs,
                retryAfterSeconds,
                skipped,
            })),
        }
        : {
            errorCode,
            message,
            retryable: error instanceof AllProvidersRateLimitedError
                || (error instanceof ProviderError && transientProviderErrors.includes(error.type)),
        };

    if (error && typeof error === 'object' && 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number') {
        failure.retryAfterSeconds = error.retryAfterSeconds;
    }

    return failure;
}

/**
 * Job processor function
 */
async function processReportJob(job: Job<StepperJobData<unknown, unknown>>): Promise<StepperProviderResult<unknown>> {
    const { jobId, request, cacheKey } = job.data;
    const log = createChildLogger({
        jobId,
        requestId: request.requestId,
        tenantId: request.tenantId,
    });

    log.info('Processing report job');

    const sendCompletionWebhook = async (result: StepperProviderResult<unknown>): Promise<void> => {
        if (!job.data.callbackUrl || !config.webhook.enabled) return;

        log.info(
            { callbackOrigin: getCallbackLogOrigin(job.data.callbackUrl) },
            'Sending success webhook'
        );
        await notifyWebhookSuccess(
            job.data.callbackUrl,
            config.webhook.secret,
            jobId,
            result.result,
            {
                provider: result.usedProvider,
                generationTimeMs: result.timings.totalMs,
                fallback: result.fallback,
            }
        );
    };

    try {
        // Check cache again (avoid race condition)
        const cached = await getReportCache(cacheKey);
        if (request.cacheControl !== 'no-cache' && request.cacheControl !== 'refresh' && cached && cached.status === 'hydrated' && isHydratedFresh(cached)) {
            log.info('Report already hydrated in cache, skipping generation');
            const cachedResult: StepperProviderResult<unknown> = {
                result: cached.result,
                usedProvider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
                providersAttempted: cached.providersAttempted || [],
                fallback: cached.fallback || false,
                validated: cached.validated ?? !cached.fallback,
                timings: cached.timings || { totalMs: 0 },
            };
            await job.updateProgress(100);
            await sendCompletionWebhook(cachedResult);
            return cachedResult;
        }

        // Generate request output with full generic request contract.
        const result = await generateRequestNow(request, jobId);

        // Store in cache
        await setHydrated(
            cacheKey,
            result.result,
            result.providersAttempted,
            result.fallback,
            undefined,
            { usedProvider: result.usedProvider, timings: result.timings, validated: result.validated }
        );

        // Update job progress
        await job.updateProgress(100);

        recordJobProcessed();
        log.info({ usedProvider: result.usedProvider, fallback: result.fallback }, 'Job completed successfully');

        // Note: input.callbacks are already executed in orchestrator immediately after generation
        // The callbackUrl below is the legacy webhook for backwards compatibility
        await sendCompletionWebhook(result);

        return result;
    } catch (error) {
        const failure = getFailure(error);
        log.error({ errorCode: failure.errorCode }, 'Job failed');

        // Preserve structured failure details for the status endpoint while BullMQ retries the job.
        await markFailed(cacheKey, failure.message, failure.providersAttempted || [], failure);

        recordJobFailed();

        // Execute failure callbacks if configured.
        // Note: this is intentionally fire-and-forget so queue retry/failure handling is not delayed.
        if (request.callbacks && request.callbacks.length > 0) {
            const commitInput = toCommitReportInput(request);
            const failurePayload: StepperCallbackPayload<unknown> = {
                success: false,
                error: failure.message,
                metadata: {
                    jobId,
                    requestId: request.requestId,
                    tenantId: request.tenantId,
                    requestMetadata: request.metadata,
                    timestamp: new Date().toISOString(),
                    userId: commitInput?.userId,
                    commitSha: commitInput?.commitSha,
                    repo: commitInput?.repo,
                },
            };

            void deliverRequestCallbacks(request.callbacks, failurePayload, { jobId })
                .then((callbackResults) => {
                    log.info({ callbackResults: callbackResults.map((r) => ({ url: r.url, success: r.success })) }, 'Failure callbacks executed');
                })
            .catch((_err: unknown) => {
                    log.warn({ errorCode: 'CALLBACK_EXECUTION_ERROR' }, 'Failed to execute failure callbacks');
                });
        }

        // Send failure webhook notification if configured (legacy)
        if (job.data.callbackUrl && config.webhook.enabled) {
            log.info(
                { callbackOrigin: getCallbackLogOrigin(job.data.callbackUrl) },
                'Sending failure webhook'
            );
            await notifyWebhookFailure(
                job.data.callbackUrl,
                config.webhook.secret,
                jobId,
                failure.message
            ).catch((_err: unknown) => {
                log.warn({ errorCode: 'FAILURE_WEBHOOK_ERROR' }, 'Failed to send failure webhook');
            });
        }

        throw error; // Let BullMQ handle retry logic
    }
}

async function processBatchItem(
    item: { id: string; request: StepperJobData<unknown, unknown>['request'] },
    index: number,
    jobId: string,
    ownerKey?: string,
): Promise<StepperBatchItemResult> {
    const { request } = item;
    const cacheKey = buildRequestCacheKey(request, ownerKey);

    try {
        const cached = request.cacheControl === 'no-cache' || request.cacheControl === 'refresh'
            ? null
            : await getReportCache(cacheKey);

        if (cached?.status === 'hydrated' && cached.result !== undefined && isHydratedFresh(cached)) {
            return {
                id: item.id,
                index,
                status: 'completed',
                data: cached.result,
                metadata: {
                    provider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
                    fallback: cached.fallback || false,
                    validated: cached.validated ?? !cached.fallback,
                    timings: cached.timings || { totalMs: 0 },
                    providersAttempted: cached.providersAttempted || [],
                },
            };
        }

        const result = await generateRequestNow(request, `${jobId}:${item.id}`);
        await setHydrated(
            cacheKey,
            result.result,
            result.providersAttempted,
            result.fallback,
            undefined,
            { usedProvider: result.usedProvider, timings: result.timings, validated: result.validated },
        );

        return {
            id: item.id,
            index,
            status: 'completed',
            data: result.result,
            metadata: {
                provider: result.usedProvider,
                fallback: result.fallback,
                validated: result.validated,
                timings: result.timings,
                providersAttempted: result.providersAttempted,
            },
        };
    } catch (error) {
        const failure = getFailure(error);
        await markFailed(cacheKey, failure.message, failure.providersAttempted || [], failure);
        return { id: item.id, index, status: 'failed', failure };
    }
}

export async function processBatchJob(job: Job<StepperBatchQueueJobData>): Promise<StepperBatchResult> {
    const { jobId, batch, ownerKey } = job.data;
    const results: StepperBatchItemResult[] = new Array(batch.items.length);
    let nextIndex = 0;
    let completed = 0;
    const concurrency = Math.max(1, Math.min(batch.concurrency || config.batch.maxConcurrency, config.batch.maxConcurrency));

    const runNext = async (): Promise<void> => {
        while (nextIndex < batch.items.length) {
            const index = nextIndex++;
            if (index >= batch.items.length) return;
            results[index] = await processBatchItem(batch.items[index], index, jobId, ownerKey);
            completed += 1;
            // Persist progress at a bounded cadence to avoid one Redis write per
            // item while still guaranteeing an exact final progress update.
            if (completed % 5 === 0 || completed === batch.items.length) {
                await job.updateProgress({ done: completed, total: batch.items.length });
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, batch.items.length) }, () => runNext()));
    return {
        items: results,
        total: results.length,
        completed: results.filter((result) => result.status === 'completed').length,
        failed: results.filter((result) => result.status === 'failed').length,
    };
}

/**
 * Start worker
 */
export function startWorker(): void {
    if (worker) {
        logger.warn('Worker already started');
        return;
    }

    worker = new Worker<StepperJobData<unknown, unknown>>(config.queue.name, processReportJob, {
        connection: getQueueConnection(),
        concurrency: config.queue.concurrency, //(how many jobs it can do at once).
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
    });

    worker.on('completed', (job) => {
        logger.info({ jobId: job.id }, 'Job completed');
    });

    worker.on('failed', (job, _err) => {
        logger.error({ jobId: job?.id, errorCode: 'JOB_FAILED_PERMANENTLY' }, 'Job failed');
        if (job) {
            void sendDiscordAlert({
                title: 'Job Failed Permanently',
                message: `Job **${job.id}** failed after all retries.`,
                severity: 'warning',
                metadata: {
                    jobId: job.id,
                    errorCode: 'JOB_FAILED_PERMANENTLY',
                    tenantId: job.data.request.tenantId || 'unknown',
                    requestId: job.data.request.requestId,
                }
            });
        }
    });

    batchWorker = new Worker<StepperBatchQueueJobData>(config.batch.queueName, processBatchJob, {
        connection: getQueueConnection(),
        concurrency: config.batch.queueConcurrency,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
    });

    batchWorker.on('completed', (job) => {
        logger.info({ jobId: job.id, itemCount: job.data.batch.items.length }, 'Batch job completed');
    });

    batchWorker.on('failed', (job, _err) => {
        logger.error({ jobId: job?.id, errorCode: 'BATCH_JOB_FAILED' }, 'Batch job failed at worker level');
        if (job) {
            void sendDiscordAlert({
                title: 'Batch Worker Failure',
                message: `Batch job **${job.id}** failed before returning item results.`,
                severity: 'warning',
                metadata: {
                    jobId: job.id,
                    errorCode: 'BATCH_JOB_FAILED',
                    tenantId: job.data.batch.tenantId || 'unknown',
                    requestId: job.data.batch.requestId,
                },
            });
        }
    });

    worker.on('error', (error) => handleWorkerSystemError(error, 'single'));
    batchWorker.on('error', (error) => handleWorkerSystemError(error, 'batch'));

    logger.info({ concurrency: config.queue.concurrency, batchConcurrency: config.batch.queueConcurrency }, 'Workers started');
}

/**
 * Stop worker gracefully
 */
export async function stopWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
        logger.info('Worker stopped');
    }
    if (batchWorker) {
        await batchWorker.close();
        batchWorker = null;
        logger.info('Batch worker stopped');
    }
}
