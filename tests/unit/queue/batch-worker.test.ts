import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError } from '../../../src/providers/provider.interface.js';
import { processBatchJob } from '../../../src/queue/worker.js';
import { StepperBatchRequest } from '../../../src/types.js';

const mocks = vi.hoisted(() => ({
    generateRequestNow: vi.fn(),
    getReportCache: vi.fn(),
    isHydratedFresh: vi.fn(),
    buildRequestCacheKey: vi.fn(),
    setHydrated: vi.fn(),
    markFailed: vi.fn(),
    AllProvidersFailedError: class AllProvidersFailedError extends Error {
        public readonly errorCode = 'UPSTREAM_UNAVAILABLE';
        public readonly retryable = true;
        public readonly providersAttempted = [{
            provider: 'provider-a',
            attemptNumber: 1,
            errorCode: 'UPSTREAM_UNAVAILABLE',
        }];
    },
}));

vi.mock('../../../src/cache/redisCache.js', () => ({
    getReportCache: mocks.getReportCache,
    isHydratedFresh: mocks.isHydratedFresh,
    buildRequestCacheKey: mocks.buildRequestCacheKey,
    setHydrated: mocks.setHydrated,
    markFailed: mocks.markFailed,
}));

vi.mock('../../../src/stepper/orchestrator.js', () => ({
    generateRequestNow: mocks.generateRequestNow,
    AllProvidersRateLimitedError: class AllProvidersRateLimitedError extends Error {},
    AllProvidersFailedError: mocks.AllProvidersFailedError,
}));

function createBatchJob(batch: StepperBatchRequest) {
    return {
        data: { jobId: 'batch-job-1', batch, ownerKey: 'owner-a' },
        updateProgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof processBatchJob>[0];
}

function makeBatch(count: number, concurrency = 2): StepperBatchRequest {
    return {
        concurrency,
        items: Array.from({ length: count }, (_, index) => ({
            id: `item-${index}`,
            request: { prompt: `prompt-${index}`, requestId: `request-${index}` },
        })),
    };
}

describe('batch worker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getReportCache.mockResolvedValue(null);
        mocks.isHydratedFresh.mockReturnValue(false);
        mocks.buildRequestCacheKey.mockImplementation((request: { requestId?: string }) => `cache:${request.requestId}`);
        mocks.setHydrated.mockResolvedValue(undefined);
        mocks.markFailed.mockResolvedValue(undefined);
        mocks.generateRequestNow.mockImplementation(async (request: { requestId?: string }) => ({
            result: { requestId: request.requestId },
            usedProvider: 'provider-a',
            providersAttempted: [{ provider: 'provider-a', attemptNumber: 1 }],
            fallback: false,
            validated: true,
            timings: { totalMs: 1 },
        }));
    });

    it('preserves item identity and order while respecting worker concurrency', async () => {
        let active = 0;
        let peak = 0;
        mocks.generateRequestNow.mockImplementation(async (request: { requestId?: string }) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active -= 1;
            return {
                result: request.requestId,
                usedProvider: 'provider-a',
                providersAttempted: [],
                fallback: false,
                validated: true,
                timings: { totalMs: 1 },
            };
        });

        const job = createBatchJob(makeBatch(6, 2));
        const result = await processBatchJob(job);

        expect(peak).toBeLessThanOrEqual(2);
        expect(result.items.map((item) => item.id)).toEqual([
            'item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'item-5',
        ]);
        expect(result.items.every((item) => item.status === 'completed')).toBe(true);
        expect(result.completed).toBe(6);
        expect(result.failed).toBe(0);
        expect(job.updateProgress).toHaveBeenLastCalledWith({ done: 6, total: 6 });
        expect(job.updateProgress).toHaveBeenCalledTimes(2);
        expect(mocks.buildRequestCacheKey).toHaveBeenCalledWith(expect.any(Object), 'owner-a');
    });

    it('returns transient item failures with retryable error provenance', async () => {
        mocks.generateRequestNow.mockImplementation(async (request: { requestId?: string }) => {
            if (request.requestId === 'request-1') {
                throw new TimeoutError('provider timed out');
            }
            if (request.requestId === 'request-2') {
                throw new mocks.AllProvidersFailedError('all providers unavailable');
            }
            return {
                result: request.requestId,
                usedProvider: 'provider-a',
                providersAttempted: [],
                fallback: false,
                validated: true,
                timings: { totalMs: 1 },
            };
        });

        const job = createBatchJob(makeBatch(3, 2));
        const result = await processBatchJob(job);

        expect(result.completed).toBe(1);
        expect(result.failed).toBe(2);
        expect(result.items[1].failure).toMatchObject({
            errorCode: 'TIMEOUT',
            retryable: true,
        });
        expect(result.items[2].failure).toMatchObject({
            errorCode: 'UPSTREAM_UNAVAILABLE',
            retryable: true,
        });
        expect(mocks.markFailed).toHaveBeenCalledTimes(2);
    });
});
