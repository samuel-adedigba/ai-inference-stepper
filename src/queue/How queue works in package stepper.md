# Queue Processing in Stepper

Stepper uses BullMQ as the asynchronous execution layer.

## Goal

- keep request API responsive
- move model inference to background workers
- centralize retries/backoff for transient provider failures

## Components

1. Producer (`producer.ts`)
   - creates job payload (`StepperJobData`)
   - enqueues `generate` jobs
   - exposes job status lookups

2. Worker (`worker.ts`)
   - consumes queued jobs
   - executes orchestration pipeline
   - writes cache terminal states (hydrated/failed)

## Retry model

- queue retries are configured with exponential backoff
- orchestrator handles per-provider retries/fallback
- all-providers-rate-limited case bubbles as retryable path for queue recovery

## Job result surface

- `getJobStatus(jobId)` reports:
  - waiting/active/completed/failed
  - optional return data/error details

## Compatibility boundary

- legacy `enqueueReportJob(...)` wrapper is still exported for CommitDiary migration safety
- primary path is `enqueueRequestJob(...)` with `StepperRequest` payload

## TODO

- TODO: refactor: remove legacy wrapper once API/dashboard/cron flows no longer depend on report-specific enqueue paths.
