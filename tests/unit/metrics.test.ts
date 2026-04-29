import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMetrics,
  recordCacheHit,
  recordCacheMiss,
  recordProviderAttempt,
  recordProviderFailure,
  recordProviderSuccess,
  register,
} from '../../src/metrics/metrics.js';

describe('Metrics labels', () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it('records provider metrics with normalized preset/response_mode labels', async () => {
    recordProviderAttempt('hf-space', { preset: 'commit-report', responseMode: 'json' });
    recordProviderSuccess('hf-space', 150, { preset: 'generic', responseMode: 'text' });
    recordProviderFailure('hf-space', 'UNKNOWN', { preset: 'random-unbounded-value', responseMode: 'xml' });

    const metrics = await getMetrics();
    expect(metrics).toContain('ai_requests_total');
    expect(metrics).toContain('preset="commit-report"');
    expect(metrics).toContain('response_mode="json"');
    expect(metrics).toContain('preset="generic"');
    expect(metrics).toContain('response_mode="text"');
    expect(metrics).toContain('preset="unknown"');
    expect(metrics).toContain('response_mode="unknown"');
  });

  it('records cache metrics with normalized preset/response_mode labels', async () => {
    recordCacheHit('fresh', { preset: 'commit-report', responseMode: 'json' });
    recordCacheMiss({ preset: 'wildcard-value', responseMode: 'custom-mode' });

    const metrics = await getMetrics();
    expect(metrics).toContain('cache_hits_total');
    expect(metrics).toContain('cache_misses_total');
    expect(metrics).toContain('preset="commit-report"');
    expect(metrics).toContain('preset="unknown"');
  });
});
