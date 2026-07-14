// packages/stepper/src/queue/worker.ts`

import { Worker, Job } from 'bullmq';
import { setHydrated, markFailed, getReportCache } from '../cache/redisCache.js';
import { generateRequestNow } from '../stepper/orchestrator.js';
import { StepperCallbackPayload, StepperJobData, StepperProviderResult } from '../types.js';
import { config } from '../config.js';
import { logger, createChildLogger } from '../logging.js';
import { recordJobProcessed, recordJobFailed } from '../metrics/metrics.js';
import { sendDiscordAlert } from '../alerts/discord.js';
import { notifyWebhookSuccess, notifyWebhookFailure } from '../webhooks/delivery.js';
import { deliverRequestCallbacks } from '../webhooks/requestCallbacks.js';
import { toCommitReportInput } from '../presets/commit-report/request.js';
import { getQueueConnection } from './connection.js';

let worker: Worker<StepperJobData<unknown, unknown>> | null = null;

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

    try {
        // Check cache again (avoid race condition)
        const cached = await getReportCache(cacheKey);
        if (cached && cached.status === 'hydrated') {
            log.info('Report already hydrated in cache, skipping generation');
            return {
                result: cached.result,
                usedProvider: 'cache',
                providersAttempted: cached.providersAttempted || [],
                fallback: cached.fallback || false,
                timings: { totalMs: 0 },
            };
        }

        // Generate request output with full generic request contract.
        const result = await generateRequestNow(request, jobId);

        // Store in cache
        await setHydrated(cacheKey, result.result, result.providersAttempted, result.fallback);

        // Update job progress
        await job.updateProgress(100);

        recordJobProcessed();
        log.info({ usedProvider: result.usedProvider, fallback: result.fallback }, 'Job completed successfully');

        // Note: input.callbacks are already executed in orchestrator immediately after generation
        // The callbackUrl below is the legacy webhook for backwards compatibility
        if (job.data.callbackUrl && config.webhook.enabled) {
            log.info({ callbackUrl: job.data.callbackUrl }, 'Sending success webhook');
            await notifyWebhookSuccess(
                job.data.callbackUrl,
                config.webhook.secret,
                jobId,
                result.result
            );
        }

        return result;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Job failed');

        // Mark cache as failed
        await markFailed(cacheKey, errorMessage, []);

        recordJobFailed();

        // Execute failure callbacks if configured.
        // Note: this is intentionally fire-and-forget so queue retry/failure handling is not delayed.
        if (request.callbacks && request.callbacks.length > 0) {
            const commitInput = toCommitReportInput(request);
            const failurePayload: StepperCallbackPayload<unknown> = {
                success: false,
                error: errorMessage,
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
                .catch((err: unknown) => {
                    log.warn({
                        error: err instanceof Error ? err.message : String(err),
                    }, 'Failed to execute failure callbacks');
                });
        }

        // Send failure webhook notification if configured (legacy)
        if (job.data.callbackUrl && config.webhook.enabled) {
            log.info({ callbackUrl: job.data.callbackUrl }, 'Sending failure webhook');
            await notifyWebhookFailure(
                job.data.callbackUrl,
                config.webhook.secret,
                jobId,
                errorMessage
            ).catch(err => {
                log.warn({ error: err.message }, 'Failed to send failure webhook');
            });
        }

        throw error; // Let BullMQ handle retry logic
    }
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

    worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.id, error: err.message }, 'Job failed');
        if (job) {
            void sendDiscordAlert({
                title: 'Job Failed Permanently',
                message: `Job **${job.id}** failed after all retries.\n\n**Error:**\n\`${err.message}\``,
                severity: 'warning',
                metadata: {
                    jobId: job.id,
                    error: err.message,
                    tenantId: job.data.request.tenantId || 'unknown',
                    requestId: job.data.request.requestId,
                }
            });
        }
    });

    worker.on('error', (err) => {
        logger.error({ error: err }, 'Worker error');
        void sendDiscordAlert({
            title: 'Worker System Error',
            message: `The job queue worker encountered a system error: ${err.message}`,
            severity: 'critical',
            metadata: { error: err.message }
        });
    });

    logger.info({ concurrency: config.queue.concurrency }, 'Worker started');
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
}
