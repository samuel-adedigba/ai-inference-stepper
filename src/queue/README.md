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

## Core APIs

- `enqueueRequestJob(request, cacheKey, options)`
- `getJobStatus(jobId)`
- Worker process loop in `startWorker()`

## Compatibility note

CommitDiary-specific queue behavior remains available through compatibility wrappers and `presets/commit-report/*` mapping while generic queue execution rollout completes.
