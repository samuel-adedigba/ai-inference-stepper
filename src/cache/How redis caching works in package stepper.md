# Redis Cache Lifecycle in Stepper

This document explains how Stepper uses Redis cache for asynchronous generation flows.

## Goal

- return fast responses when result already exists
- avoid regenerating identical requests
- support stale-while-revalidate for better UX/cost balance

## Cache states

1. `dehydrated`
   - request is accepted and queued
   - entry contains `jobId`
2. `hydrated`
   - completed result is available
   - entry contains `result` and provider attempt metadata
3. `failed`
   - generation failed
   - entry contains error details

## Key strategies

- generic key strategy:
  - `buildRequestCacheKey(request)`
  - priority: `request.cacheKey`
  - fallback: deterministic fingerprint hash
- preset compatibility key strategy:
  - commit-report key helpers in `presets/commit-report/cacheKey.ts`

## Request flow

1. API receives generate request.
2. Cache is checked:
   - fresh hydrated hit -> return immediately.
   - stale hydrated hit -> return stale + enqueue background refresh.
   - miss/dehydrated -> enqueue generation job.
3. Producer stores `dehydrated` placeholder.
4. Worker/orchestrator generates result.
5. Cache entry transitions to `hydrated` or `failed`.

## Why stale-while-revalidate

- users get immediate response for slightly stale data
- refresh happens asynchronously
- provider load/cost is reduced while keeping data reasonably fresh

## Compatibility note

CommitDiary preset cache identity is still preserved for legacy endpoints and migration safety.

## TODO

- TODO: verify — remove legacy `deleteReport` commit-key cleanup path when downstream callers are fully migrated to generic cache lifecycle.
