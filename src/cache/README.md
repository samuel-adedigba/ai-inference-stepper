# Cache System

Stepper cache is Redis-backed and request-centric.

## Purpose

- Reuse recent generation output
- Track queued jobs (dehydrated state)
- Return stale cached results while refreshing in background
- Reduce provider cost and repeated traffic

## Cache entry states

- `dehydrated`: job is queued/running, contains `jobId`
- `hydrated`: completed result available (`result: unknown`)
- `failed`: generation failed, includes error metadata

## Key building

- Generic: `buildRequestCacheKey(request)`
  - uses `request.cacheKey` when provided
  - otherwise deterministic hash from request identity/prompt/payload/schema hints
- Commit compatibility: preset helper in `presets/commit-report/cacheKey.ts`

## Core APIs

- `getReportCache(key)`
- `setDehydrated(key, jobId)`
- `setHydrated(key, result, providersAttempted, fallback, ttl?)`
- `markFailed(key, errorMessage, providersAttempted)`
- `isHydratedFresh(entry)`
- `isStaleButUsable(entry)`

## Compatibility note

Legacy commit cache identity remains supported through preset helpers during migration. Generic callers should prefer explicit `request.cacheKey` for stable cache semantics.
