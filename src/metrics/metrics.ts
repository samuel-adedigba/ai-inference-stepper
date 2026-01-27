

// packages/stepper/src/metrics/metrics.ts

import { Registry, Counter, Histogram, Gauge } from 'prom-client';

// Create registry
export const register = new Registry();

// Metrics
export const aiRequestsTotal = new Counter({
    name: 'ai_requests_total',
    help: 'Total number of AI provider requests',
    labelNames: ['provider', 'status'],
    registers: [register],
});

export const aiRequestDuration = new Histogram({
    name: 'ai_request_duration_seconds',
    help: 'Duration of AI provider requests in seconds',
    labelNames: ['provider'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
});

export const cacheHitsTotal = new Counter({
    name: 'cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['status'],
    registers: [register],
});
export const cacheMissesTotal = new Counter({
    name: 'cache_misses_total',
    help: 'Total number of cache misses',
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
    labelNames: ['provider', 'reason'],
    registers: [register],
});
export const jobsProcessedTotal = new Counter({
    name: 'jobs_processed_total',
    help: 'Total number of jobs processed',
    labelNames: ['status'],
    registers: [register],
});
// Helper functions
export function recordProviderAttempt(provider: string): void {
    aiRequestsTotal.inc({ provider, status: 'attempted' });
}
export function recordProviderSuccess(provider: string, durationMs: number): void {
    aiRequestsTotal.inc({ provider, status: 'success' });
    aiRequestDuration.observe({ provider }, durationMs / 1000);
}
export function recordProviderFailure(provider: string, reason: string): void {
    aiRequestsTotal.inc({ provider, status: 'failed' });
    providerFailuresTotal.inc({ provider, reason });
}
export function recordCacheHit(status: 'fresh' | 'stale'): void {
    cacheHitsTotal.inc({ status });
}
export function recordCacheMiss(): void {
    cacheMissesTotal.inc();
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