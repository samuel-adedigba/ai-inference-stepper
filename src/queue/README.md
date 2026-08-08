# Async Job Queue

Stepper uses BullMQ + Redis to run generation jobs asynchronously.

## Purpose

- Return fast enqueue response while generation runs in background
- Retry transient provider failures via queue backoff
- Control concurrency and protect provider budgets

## Components

- `producer.ts`
  - Enqueues `StepperJobData` with job name `generate`
  - Exposes `enqueueRequestJob(...)`
  - Exposes compatibility wrapper `enqueueReportJob(...)`
- `worker.ts`
  - Consumes queue jobs and calls orchestrator path
  - Persists success/failure state to cache

Single-request jobs and batch jobs use separate BullMQ queues and worker pools.
`QUEUE_CONCURRENCY` protects normal request latency, while
`BATCH_QUEUE_CONCURRENCY` caps the number of active batch jobs. A batch job also
has its own bounded item concurrency, so provider limiters remain the final
upstream capacity boundary.

## Core APIs

- `enqueueRequestJob(request, cacheKey, options)`
- `enqueueBatchJob(batch)`
- `getJobStatus(jobId)`
- Worker process loop in `startWorker()`

Batch jobs contain independently identified requests. The worker runs up to the
configured item concurrency, updates `{ done, total }` progress at a bounded
cadence, and returns per-item results in input order. An item failure does not
fail successful sibling items or retry the whole batch. Transient failures keep
their stable error code and provider-attempt metadata so callers can retry only
the affected item IDs.

## Compatibility note

CommitDiary-specific queue behavior remains available through compatibility wrappers and `presets/commit-report/*` mapping while generic queue execution rollout completes.
