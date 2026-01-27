import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { getReportCache, setDehydrated, setHydrated, isHydratedFresh, buildCacheKey } from '../../src/cache/redisCache.js';

// Mock ioredis
let redisMock: RedisMock;

describe('Cache', () => {
    beforeEach(() => {
        redisMock = new RedisMock();
    });

    afterEach(async () => {
        await redisMock.flushall();
        redisMock.disconnect();
    });

    it('should build cache key correctly', () => {
        const key = buildCacheKey('user123', 'abc123', 'default');
        expect(key).toContain('user123');
        expect(key).toContain('abc123');
        expect(key).toContain('default');
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

        await setHydrated(key, report, [], false, 3600);
        const result = await getReportCache(key);

        expect(result).toBeDefined();
        expect(result?.status).toBe('hydrated');
        expect(result?.result).toEqual(report);
    });

    it('should identify fresh cache entries', () => {
        const freshEntry = {
            status: 'hydrated' as const,
            result: {} as any,
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
            result: {} as any,
            timestamps: {
                created: new Date(Date.now() - 86400 * 2 * 1000).toISOString(), // 2 days ago
                updated: new Date(Date.now() - 86400 * 2 * 1000).toISOString(),
            },
        };

        expect(isHydratedFresh(staleEntry)).toBe(false);
    });
});