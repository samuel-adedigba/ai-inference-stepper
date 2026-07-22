import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { getReportCache, setDehydrated, setHydrated, isHydratedFresh, buildRequestCacheKey, closeRedis } from '../../src/cache/redisCache.js';
import { buildCommitReportCacheKey } from '../../src/presets/commit-report/cacheKey.js';

vi.mock('ioredis', () => ({ default: RedisMock }));

describe('Cache', () => {
    beforeEach(async () => {
        await closeRedis();
    });

    afterEach(async () => {
        await closeRedis();
    });

    it('should build generic cache key deterministically', () => {
        const key = buildRequestCacheKey({
            tenantId: 'tenant-1',
            requestId: 'req-1',
            prompt: 'Hello',
            payload: { a: 1, b: 'x' },
            responseMode: 'json',
        });
        const key2 = buildRequestCacheKey({
            tenantId: 'tenant-1',
            requestId: 'req-1',
            prompt: 'Hello',
            payload: { b: 'x', a: 1 },
            responseMode: 'json',
        });

        expect(key).toContain('tenant-1');
        expect(key).toContain('req-1');
        expect(key).toBe(key2);
    });

    it('should build commit compatibility cache key correctly', () => {
        const key = buildCommitReportCacheKey({
            userId: 'user123',
            commitSha: 'abc123',
            repo: 'org/repo',
            message: 'feat: test',
            files: ['a.ts'],
            components: ['api'],
            diffSummary: '+ test',
            template: 'default',
        });
        expect(key).toContain('user123');
        expect(key).toContain('abc123');
    });

    it('should return null for non-existent cache entry', async () => {
        const result = await getReportCache('non-existent-key');
        expect(result).toBeNull();
    });

    it('should store and retrieve dehydrated cache entry', async () => {
        const key = 'test:dehydrated';
        const jobId = 'job-123';

        await setDehydrated(key, jobId);
        const result = await getReportCache(key);

        expect(result).toBeDefined();
        expect(result?.status).toBe('dehydrated');
        expect(result?.jobId).toBe(jobId);
    });

    it('should store and retrieve hydrated cache entry', async () => {
        const key = 'test:hydrated';
        const report = {
            title: 'Test Report',
            summary: 'Test summary',
            changes: ['Change 1'],
            rationale: 'Test rationale',
            impact_and_tests: 'Test impact',
            next_steps: ['Step 1'],
            tags: 'test',
        };

        await setHydrated(
            key,
            report,
            [],
            false,
            3600,
            { usedProvider: 'gemini', timings: { totalMs: 912, providerMs: 800 } },
        );
        const result = await getReportCache(key);

        expect(result).toBeDefined();
        expect(result?.status).toBe('hydrated');
        expect(result?.result).toEqual(report);
        expect(result?.usedProvider).toBe('gemini');
        expect(result?.timings).toEqual({ totalMs: 912, providerMs: 800 });
    });

    it('should identify fresh cache entries', () => {
        const freshEntry = {
            status: 'hydrated' as const,
            result: {},
            timestamps: {
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
            },
        };

        expect(isHydratedFresh(freshEntry)).toBe(true);
    });

    it('should identify stale cache entries', () => {
        const staleEntry = {
            status: 'hydrated' as const,
            result: {},
            timestamps: {
                created: new Date(Date.now() - 86400 * 2 * 1000).toISOString(), // 2 days ago
                updated: new Date(Date.now() - 86400 * 2 * 1000).toISOString(),
            },
        };

        expect(isHydratedFresh(staleEntry)).toBe(false);
    });
});
