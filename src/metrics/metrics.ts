

// packages/stepper/src/metrics/metrics.ts

import { Registry, Counter, Histogram, Gauge } from 'prom-client';

// Create registry
export const register = new Registry();

type MetricsPresetLabel = 'commit-report' | 'generic' | 'unknown';
type MetricsResponseModeLabel = 'json' | 'text' | 'unknown';

interface MetricsContext {
    preset?: string;
    responseMode?: string;
}

/**
 * Normalize metrics labels into a very small set of values.
 *
 * Why this exists:
 * - Prometheus label cardinality can explode quickly and become expensive.
 * - Stepper request metadata can be arbitrary; do not map raw values directly.
 */
function normalizeMetricsContext(context?: MetricsContext): {
    preset: MetricsPresetLabel;
    responseMode: MetricsResponseModeLabel;
} {
    const rawPreset = context?.preset;
    const rawResponseMode = context?.responseMode;

    const preset: MetricsPresetLabel =
        rawPreset === 'commit-report'
            ? 'commit-report'
            : rawPreset === 'generic'
                ? 'generic'
                : 'unknown';

    const responseMode: MetricsResponseModeLabel =
        rawResponseMode === 'json'
            ? 'json'
            : rawResponseMode === 'text'
                ? 'text'
                : 'unknown';

    return { preset, responseMode };
}

// Metrics
export const aiRequestsTotal = new Counter({
    name: 'ai_requests_total',
    help: 'Total number of AI provider requests',
    labelNames: ['provider', 'status', 'preset', 'response_mode'],
    registers: [register],
});

export const aiRequestDuration = new Histogram({
    name: 'ai_request_duration_seconds',
    help: 'Duration of AI provider requests in seconds',
    labelNames: ['provider', 'preset', 'response_mode'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
});

export const cacheHitsTotal = new Counter({
    name: 'cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['status', 'preset', 'response_mode'],
    registers: [register],
});
export const cacheMissesTotal = new Counter({
    name: 'cache_misses_total',
    help: 'Total number of cache misses',
    labelNames: ['preset', 'response_mode'],
    registers: [register],
});
export const jobQueueSize = new Gauge({
    name: 'job_queue_size',
    help: 'Current size of job queue',
    registers: [register],
});
export const providerFailuresTotal = new Counter({
    name: 'provider_failures_total',
    help: 'Total number of provider failures',
    labelNames: ['provider', 'reason', 'preset', 'response_mode'],
    registers: [register],
});
export const jobsProcessedTotal = new Counter({
    name: 'jobs_processed_total',
    help: 'Total number of jobs processed',
    labelNames: ['status'],
    registers: [register],
});
// Helper functions
export function recordProviderAttempt(provider: string, context?: MetricsContext): void {
    const labels = normalizeMetricsContext(context);
    aiRequestsTotal.inc({
        provider,
        status: 'attempted',
        preset: labels.preset,
        response_mode: labels.responseMode,
    });
}
export function recordProviderSuccess(provider: string, durationMs: number, context?: MetricsContext): void {
    const labels = normalizeMetricsContext(context);
    aiRequestsTotal.inc({
        provider,
        status: 'success',
        preset: labels.preset,
        response_mode: labels.responseMode,
    });
    aiRequestDuration.observe({
        provider,
        preset: labels.preset,
        response_mode: labels.responseMode,
    }, durationMs / 1000);
}
export function recordProviderFailure(provider: string, reason: string, context?: MetricsContext): void {
    const labels = normalizeMetricsContext(context);
    aiRequestsTotal.inc({
        provider,
        status: 'failed',
        preset: labels.preset,
        response_mode: labels.responseMode,
    });
    providerFailuresTotal.inc({
        provider,
        reason,
        preset: labels.preset,
        response_mode: labels.responseMode,
    });
}
export function recordCacheHit(status: 'fresh' | 'stale', context?: MetricsContext): void {
    const labels = normalizeMetricsContext(context);
    cacheHitsTotal.inc({
        status,
        preset: labels.preset,
        response_mode: labels.responseMode,
    });
}
export function recordCacheMiss(context?: MetricsContext): void {
    const labels = normalizeMetricsContext(context);
    cacheMissesTotal.inc({
        preset: labels.preset,
        response_mode: labels.responseMode,
    });
}
export function recordJobProcessed(): void {
    jobsProcessedTotal.inc({ status: 'success' });
}
export function recordJobFailed(): void {
    jobsProcessedTotal.inc({ status: 'failed' });
}
/**

Get metrics in Prometheus format
*/
export async function getMetrics(): Promise<string> {
    return register.metrics();
}
