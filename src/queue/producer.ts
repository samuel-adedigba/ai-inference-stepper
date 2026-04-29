// packages/stepper/src/queue/producer.ts`

import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../cache/redisCache.js';
import { PromptInput, StepperJobData, StepperRequest } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logging.js';
import { createCommitReportRequest } from '../presets/commit-report/request.js';

let queue: Queue<StepperJobData<unknown, unknown>> | null = null;

/**
 * Get or create BullMQ queue
 */
export function getQueue(): Queue<StepperJobData<unknown, unknown>> {
    if (!queue) {
        const connection = getRedisClient();
        queue = new Queue<StepperJobData<unknown, unknown>>(config.queue.name, { connection });

        logger.info({ queueName: config.queue.name }, 'BullMQ queue initialized');
    }

    return queue;
}

/**
 * Enqueue a generic Stepper generation job.
 */
export async function enqueueRequestJob<TPayload = unknown, TOutput = unknown>(
    request: StepperRequest<TPayload, TOutput>,
    cacheKey: string,
    options: { priority?: number; callbackUrl?: string } = {}
): Promise<string> {
    const jobId = uuidv4();
    const queue = getQueue();

    const jobData: StepperJobData<TPayload, TOutput> = {
        jobId,
        request,
        cacheKey,
        priority: options.priority,
        callbackUrl: options.callbackUrl,
    };

    try {
        await queue.add('generate', jobData as StepperJobData<unknown, unknown>, {
            jobId,
            priority: options.priority,
            removeOnComplete: 100, // Keep last 100 completed jobs
            removeOnFail: 500, // Keep last 500 failed jobs
            attempts: 5, // Retry up to 5 times if all providers fail
            backoff: {
                type: 'exponential',
                delay: 10000, // Start with 10 seconds, doubles each retry
            },
        });

        logger.info({ jobId, cacheKey }, 'Job enqueued');
        return jobId;
    } catch (error) {
        logger.error({ error, jobId }, 'Failed to enqueue job');
        throw error;
    }
}

/**
 * Legacy compatibility wrapper for CommitDiary report enqueue flow.
 */
export async function enqueueReportJob(
    input: PromptInput,
    cacheKey: string,
    options: { priority?: number; callbackUrl?: string } = {}
): Promise<string> {
    const request = createCommitReportRequest(input);
    return enqueueRequestJob(request, cacheKey, options);
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<{
    id: string;
    state: string;
    progress?: number;
    result?: unknown;
    failedReason?: string;
    data?: unknown;
} | null> {
    const queue = getQueue();

    try {
        const job = await queue.getJob(jobId);
        if (!job) return null;

        const state = await job.getState();
        return {
            id: job.id!,
            state,
            progress: job.progress as number | undefined,
            result: job.returnvalue,
            failedReason: job.failedReason,
            data: job.data,
        };
    } catch (error) {
        logger.error({ error, jobId }, 'Failed to get job status');
        return null;
    }
}

/**
 * Close queue connection (for graceful shutdown)
 */
export async function closeQueue(): Promise<void> {
    if (queue) {
        await queue.close();
        queue = null;
        logger.info('Queue closed');
    }
}
