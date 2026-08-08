# Cache System

Stepper cache is Redis-backed and request-centric.

## Purpose

- Reuse recent generation output
- Track queued jobs (dehydrated state)
- Return stale cached results while refreshing in background
- Reduce provider cost and repeated traffic

## Cache entry states

- `dehydrated`: job is queued/running, contains `jobId`
- `hydrated`: completed result plus original provider/fallback/timing provenance
- `failed`: generation failed, includes error metadata

## Key building

- Generic: `buildRequestCacheKey(request)`
  - uses `request.cacheKey` when provided
  - otherwise deterministic hash from request identity/prompt/payload/schema hints
- Commit compatibility: preset helper in `presets/commit-report/cacheKey.ts`

Generic requests support `cacheControl` values of `default`, `no-cache`, and
`refresh`. These control cache reads; successful generation still stores the
latest result under the request cache key.

## Core APIs

- `getReportCache(key)`
- `setDehydrated(key, jobId)`
- `setHydrated(key, result, providersAttempted, fallback, ttl?, provenance?)`
- `markFailed(key, errorMessage, providersAttempted)`
- `isHydratedFresh(entry)`
- `isStaleButUsable(entry)`

## Compatibility note

Legacy commit cache identity remains supported through preset helpers during migration. Generic callers should prefer explicit `request.cacheKey` for stable cache semantics.
