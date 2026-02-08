// packages/stepper/src/queue/producer.ts`

import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../cache/redisCache.js';
import { PromptInput, ReportJobData } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logging.js';

let queue: Queue<ReportJobData> | null = null;

/**
 * Get or create BullMQ queue
 */
export function getQueue(): Queue<ReportJobData> {
    if (!queue) {
        const connection = getRedisClient();
        queue = new Queue<ReportJobData>(config.queue.name, {
            connection: connection as any, // BullMQ expects Redis client
        });

        logger.info({ queueName: config.queue.name }, 'BullMQ queue initialized');
    }

    return queue;
}

/**
 * Enqueue a report generation job
 * The "Order Taker"
 */
export async function enqueueReportJob(
    input: PromptInput,
    cacheKey: string,
    options: { priority?: number; callbackUrl?: string } = {}
): Promise<string> {
    const jobId = uuidv4();
    const queue = getQueue();

    const jobData: ReportJobData = {
        jobId,
        input,
        cacheKey,
        priority: options.priority,
        callbackUrl: options.callbackUrl,
    };

    try {
        await queue.add('generate-report', jobData, {
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

        logger.info({ jobId, userId: input.userId, commitSha: input.commitSha }, 'Job enqueued');
        return jobId;
    } catch (error) {
        logger.error({ error, jobId }, 'Failed to enqueue job');
        throw error;
    }
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
    data?: any;
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