// packages/stepper/src/queue/worker.ts`

import { Worker, Job } from 'bullmq';
import { getRedisClient, setHydrated, markFailed, getReportCache } from '../cache/redisCache.js';
import { generateReportNow } from '../stepper/orchestrator.js';
import { ReportJobData } from '../types.js';
import { config } from '../config.js';
import { logger, createChildLogger } from '../logging.js';
import { recordJobProcessed, recordJobFailed } from '../metrics/metrics.js';
import { sendDiscordAlert } from '../alerts/discord.js';

let worker: Worker<ReportJobData> | null = null;

/**
 * Job processor function
 */
async function processReportJob(job: Job<ReportJobData>): Promise<void> {
    const { jobId, input, cacheKey } = job.data;
    const log = createChildLogger({ jobId, userId: input.userId, commitSha: input.commitSha });

    log.info('Processing report job');

    try {
        // Check cache again (avoid race condition)
        const cached = await getReportCache(cacheKey);
        if (cached && cached.status === 'hydrated') {
            log.info('Report already hydrated in cache, skipping generation');
            return;
        }

        // Generate report
        const result = await generateReportNow(input, jobId);

        // Store in cache
        await setHydrated(cacheKey, result.result, result.providersAttempted, result.fallback);

        // Update job progress
        await job.updateProgress(100);

        recordJobProcessed();
        log.info({ usedProvider: result.usedProvider, fallback: result.fallback }, 'Job completed successfully');

        // TODO: If callbackUrl provided, send webhook notification
        // if (job.data.callbackUrl) {
        //   await notifyWebhook(job.data.callbackUrl, { jobId, status: 'completed', result });
        // }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error({ error: errorMessage }, 'Job failed');

        // Mark cache as failed
        await markFailed(cacheKey, errorMessage, []);

        recordJobFailed();

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

    const connection = getRedisClient();

    worker = new Worker<ReportJobData>(config.queue.name, processReportJob, {
        connection: connection as any,
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
                metadata: { jobId: job.id, error: err.message, userId: job.data.input.userId }
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