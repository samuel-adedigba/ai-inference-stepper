import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { enqueueReport, generateReport, deleteReport, registerCallbacks } from '../../src/index.js';
import { initializeProviders } from '../../src/stepper/orchestrator.js';
import { PromptInput, StepperCallbacks } from '../../src/types.js';

// Mock provider adapter for controlled testing
const mockProviderCall = vi.fn();

vi.mock('../../src/providers/hfSpace.adapter.js', () => ({
    HuggingFaceSpaceAdapter: class {
        name = 'hf-space';
        async call(_input: PromptInput) {
            return mockProviderCall();
        }
    },
}));

// Mock Redis operations
vi.mock('../../src/cache/redisCache.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/cache/redisCache.js')>('../../src/cache/redisCache.js');
    const cache = new Map<string, any>();

    return {
        ...actual,
        getReportCache: vi.fn(async (key: string) => cache.get(key) ?? null),
        setDehydrated: vi.fn(async (key: string, jobId: string) => {
            cache.set(key, { status: 'dehydrated', jobId });
        }),
        setHydrated: vi.fn(async (key: string, result: any) => {
            cache.set(key, {
                status: 'hydrated',
                result,
                timestamps: { created: new Date().toISOString(), updated: new Date().toISOString() }
            });
        }),
        deleteCacheEntry: vi.fn(async (key: string) => {
            cache.delete(key);
        }),
        isHydratedFresh: vi.fn(() => true),
        isStaleButUsable: vi.fn(() => false),
        buildCacheKey: actual.buildCacheKey,
    };
});

// Mock queue operations
vi.mock('../../src/queue/producer.js', () => ({
    enqueueReportJob: vi.fn(async () => 'mock-job-id'),
    getJobStatus: vi.fn(async () => null),
}));

describe('Full Report Generation Flow', () => {
    const testInput: PromptInput = {
        userId: 'integration-test-user',
        commitSha: 'int123abc',
        repo: 'test/integration-repo',
        message: 'Integration test commit message',
        files: ['src/app.ts', 'src/utils.ts'],
        components: ['app', 'utils'],
        diffSummary: '+ added new feature\n- removed deprecated code',
    };

    const mockReport = {
        title: 'Integration Test Report',
        summary: 'This is a test report generated during integration testing',
        changes: ['Added new feature', 'Removed deprecated code'],
        rationale: 'To improve code quality and add requested functionality',
        impact_and_tests: 'Medium impact, unit tests added',
        next_steps: ['Review PR', 'Deploy to staging'],
        tags: 'feature, cleanup',
    };

    beforeEach(() => {
        vi.clearAllMocks();

        // Initialize providers with test config
        initializeProviders([
            {
                name: 'hf-space',
                enabled: true,
                baseUrl: 'http://test.local',
                rateLimitRPS: 10,
                concurrency: 1,
                timeout: 5000,
            },
        ]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('generateReport (synchronous)', () => {
        it('should generate report end-to-end with provider', async () => {
            mockProviderCall.mockResolvedValueOnce(mockReport);

            const result = await generateReport(testInput);

            expect(result.result).toBeDefined();
            expect(result.result.title).toBe('Integration Test Report');
            expect(result.result.summary).toBeTruthy();
            expect(result.usedProvider).toBe('hf-space');
            expect(result.fallback).toBe(false);
            expect(result.timings).toBeDefined();
            expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
        });

        it('should invoke all lifecycle callbacks in correct order', async () => {
            const callOrder: string[] = [];

            const callbacks: StepperCallbacks = {
                onStart: vi.fn(() => { callOrder.push('start'); }),
                onProviderAttempt: vi.fn(() => { callOrder.push('attempt'); }),
                onSuccess: vi.fn(() => { callOrder.push('success'); }),
                onFallback: vi.fn(() => { callOrder.push('fallback'); }),
            };

            registerCallbacks(callbacks);
            mockProviderCall.mockResolvedValueOnce(mockReport);

            await generateReport(testInput);

            expect(callOrder).toEqual(['start', 'attempt', 'success']);
            expect(callbacks.onStart).toHaveBeenCalledTimes(1);
            expect(callbacks.onProviderAttempt).toHaveBeenCalledTimes(1);
            expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
            expect(callbacks.onFallback).not.toHaveBeenCalled();
        });

        it('should fallback when all providers fail', async () => {
            mockProviderCall.mockRejectedValueOnce(new Error('Provider unavailable'));

            const result = await generateReport(testInput);

            expect(result.fallback).toBe(true);
            expect(result.usedProvider).toBe('fallback');
            expect(result.result).toBeDefined();
            // Fallback should still produce a valid report structure
            expect(result.result.title).toBeTruthy();
            expect(result.result.summary).toBeTruthy();
        });
    });

    describe('enqueueReport (asynchronous)', () => {
        it('should enqueue job on cache miss', async () => {
            const result = await enqueueReport(testInput);

            // On cache miss, should return 202 with jobId
            expect(result.status).toBe(202);
            if (result.status === 202) {
                expect(result.jobId).toBeDefined();
                expect(result.cached).toBe(false);
            }
        });
    });

    describe('deleteReport', () => {
        it('should not throw when deleting non-existent report', async () => {
            await expect(
                deleteReport('non-existent-user', 'non-existent-sha')
            ).resolves.not.toThrow();
        });
    });

    describe('Error handling', () => {
        it('should handle provider timeout gracefully', async () => {
            mockProviderCall.mockImplementationOnce(() =>
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout')), 100)
                )
            );

            const result = await generateReport(testInput);

            // Should fallback on timeout
            expect(result.fallback).toBe(true);
            expect(result.providersAttempted.length).toBeGreaterThan(0);
        });

        it('should track all provider attempts in metadata', async () => {
            mockProviderCall.mockRejectedValueOnce(new Error('First failure'));

            const result = await generateReport(testInput);

            expect(result.providersAttempted).toBeDefined();
            expect(result.providersAttempted.length).toBeGreaterThan(0);

            const attempt = result.providersAttempted[0];
            expect(attempt.provider).toBe('hf-space');
            expect(attempt.error).toBeDefined();
        });
    });
});
