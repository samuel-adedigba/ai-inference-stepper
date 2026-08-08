# Stepper API Feedback & Improvement Plan

Author: Opportunity Radar integration review
Date: 2026-08-06
Scope: Applied feedback from integrating the `ai-inference-stepper` HTTP service
as the AI enrichment provider in the Opportunity Radar backend. Written so each
item is useful to *any* consumer, using this project only as the concrete example.

> Implementation note: this is a public integration record, not a CommitDiary-only
> contract. Stepper is intended for arbitrary inference workflows. See the
> [developer implementation guide](./DEVELOPER_IMPLEMENTATION_GUIDE.md) for the
> current request and response contract.

---

## 1. Purpose

This document is feedback for the **ai-inference-stepper** package/API: what works,
what gets in the way of a clean integration, and precisely how to improve it. The
package's stated goal is to be a generic, safe "inference stepper" that works with
any build or flow. Every recommendation below is framed that way — each change
should serve *arbitrary* consumers, not just this app. The Opportunity Radar
project is the first real reference consumer, so its evidence is called out
explicitly so you can reproduce and prioritize.

### 1.1 How the stepper is used here

- The backend exposes one internal seam: `InferenceGateway.organize(...)`
  (`backend/src/opportunity_engine/integrations/ai_inference.py`, `StepperHttpAdapter`).
- On every radar refresh the backend discovers posts, then enriches **one record at a
  time**: `POST {base}/v1/generate` → `202 {status: queued, jobId, statusUrl}` →
  `GET {base}{statusUrl}` polled every `4s` up to `120s` → job `completed` →
  the returned JSON is validated into `AiOrganizerResult`; any failure returns
  `None` and the deterministic record **always survives**.
- The service is reached behind a static `x-api-key` header.

### 1.2 What already works well (keep it)

- Clean submit-then-poll job model with a stable `jobId` + `statusUrl`.
- `status` values are consistent (`queued` / `active` / `completed` / `failed`).
- Completed-with-error responses are structured:
  `data.result.error = "GENERATION_FAILED"`, `retryable: true`,
  `usedProvider: "fallback"`, and a `providersAttempted[]` array with per-provider
  `error` + `errorCode` + `retryAfterSeconds`.
- Cached-result fast path (a `POST` can return `status: completed` immediately).
- A `GET /v1/providers` health endpoint.
- Server-side validation via an `outputSchema` (`http-json` DSL) is a strong idea —
  consumers can constrain the model output. Keep and extend this.

### 1.3 Feedback source and how to use this document

This review comes from the Opportunity Radar integration, not from a synthetic
example. The evidence was collected from:

1. the live Opportunity Radar adapter at
   `backend/src/opportunity_engine/integrations/ai_inference.py`;
2. an end-to-end request using a valid `x-api-key` on 2026-08-06; and
3. the Stepper HTTP contract, queue, cache, provider, and validation code.

The integration sends one enrichment request, polls the returned job, and keeps
the source record when enrichment fails. That makes latency, provider cooldowns,
schema drift, retry semantics, and result alignment important to more than this
one application.

Use the document in this order:

- read the evidence to understand the observed failure or integration pressure;
- read the matching improvement section for the general design recommendation;
- check the implementation status at the end before planning work; and
- use the developer implementation guide for the current request, response, and
  deployment procedure.

The Opportunity Radar code is the source of the concrete examples. The proposed
interfaces and implementation status are Stepper package decisions intended to
help any consumer building an asynchronous inference workflow.

---

## 2. Evidence from live integration

A real end-to-end probe (with a valid `x-api-key`) produced:

```text
POST /v1/generate                  -> 202 {"status":"queued","jobId":"...","statusUrl":"/v1/jobs/..."}
GET  /v1/jobs/<id> poll 0..N       -> 200 {"status":"active","progress":0}
GET  /v1/jobs/<id> ~51s            -> 200 {"status":"completed","progress":100,"data":{...}}

data.result = {
  "error": "GENERATION_FAILED",
  "message": "Generation could not be completed because all configured providers failed.",
  "retryable": true,
  "usedProvider": "fallback",
  "providersAttempted": [
    {"provider":"nvidia-llama",   "error":"Timed out after 30000ms", "errorCode":"UNKNOWN"},
    {"provider":"nvidia-dracarys", "error":"Unexpected error",        "errorCode":"UNKNOWN"},
    {"provider":"gemini",   "error":"HTTP 429: Too Many Requests", "errorCode":"RATE_LIMIT","retryAfterSeconds":7200},
    {"provider":"cohere",   "error":"Timed out after 20000ms",     "errorCode":"UNKNOWN"},
    {"provider":"openai",   "error":"...",                          "errorCode":"RATE_LIMIT"}
  ]
}
```

Also observed: the first request after idleness took ~40s+ (framework cold start),
i.e. a free-tier deployment sleeps between calls. All 5 providers were down in that
window (nvidia timeouts, shared-key gemini `429` with a 2-hour retry window). The
contract held end-to-end; the service simply could not produce output at that moment.

These two facts — *"the service slept and every provider failed"* — drive most of the
recommendations below.

---

## 3. Improvement priorities (quick table)

| # | Area | Change | Why (fits any flow) |
|---|------|--------|---------------------|
| 1 | Schema | Nested / typed array-of-object validation | Server can't verify our nested `claims[]`; invalid output silently degrades |
| 2 | Contract | Publish a **schema/contract version** in requests & responses | Consumers fail fast instead of guessing the DSL changed |
| 3 | Failure | Uniform `errorCode` + job-level `retryAfterSeconds`/`retryable` | Clients can tell a blip from a 2-hour outage and back off correctly |
| 4 | Failure | Standardize on a static set of error codes (`RATE_LIMIT`, `TIMEOUT`, `BAD_REQUEST`, `UNKNOWN`) | Cross-provider comparisons become reliable |
| 5 | Routing | `preferredProviders` / `excludeProviders` / `maxDurationSeconds` per request | Let consumers avoid a known-bad provider (nvidia timed out for us) |
| 6 | Providers | `GET /v1/providers` include per-provider `retryAfterSeconds` + warm/last-checked + `supportsBatch` | Clients pick a working provider *before* enqueuing |
| 7 | Batch | `POST /v1/generate/batch` (array in, single jobId, array out) | This app enriches N records per run; batch cuts latency by ~N |
| 8 | Polling | Support long-poll `?wait=` or webhooks (SSE/callback) | Fixed-interval polling is chatty and blind |
| 9 | Cache | `force`/`refresh` + payload-hash idempotency + cache TTL | Re-runs of the same URL hit cache instead of re-charging |
| 10 | Rate/quotas | `X-RateLimit-*` headers or `/v1/usage` per API key | Consumers warn before a shared key goes 429 for 2 hours |
| 11 | Cold start | `GET /v1/health` warm-up ping + documented provider warm-up | Kills the ~40s first-request latency |
| 12 | Semantics | Accept `maxOutputTokens` budget + echo `validated: true` | Consumers can reject unvalidated output instead of trusting blindly |

The next sections detail each. Sections 4–5 are **correctness & contract**, 6–8 are
**reliability**, 9–10 are **performance for this app's batch pattern**, 11–13 are
**ops**. Section 14 gives the implementation priority.

---

## 4. Schema validation — let consumers constrain nested output

**Problem (evidence).**
The `http-json` outputSchema DSL is **flat only** (top-level scalar properties,
`allowAdditionalKeys`). Our record is nested:

```json
{
  "classification": "SPONSORSHIP",
  "summary": "...",
  "claims": [ {"field": "...", "value": "...", "source_url": "...", "confidence": "high"} ]
}
```

Because the DSL cannot describe the items of `claims`, the integration had to send
`"claims": {"type": "array"}` with **no item schema** and `allowAdditionalKeys: true`.
So the server cannot reject a malformed item, and invalid output surfaces only as
`None` on the consumer side — the worst failure mode (silent).

**Improvement.**
- Support `{"type": "array", "items": { ...nested property schema... }}` for one-ish
  level-dive nested objects (`claims[]`, `reasons[]`, `flags[]`).
- Support `additionalProperties: false` at each nested level so structure drift is a
  hard job `failed`, not silent corruption.
- Add a `minItems` / `maxItems` optionally.

**Any-flow benefit.**
Most real model outputs are nested. Giving consumers a real schema language turns
"trust but guess" into "validate or fail loudly", for every integration.

---

## 5. Contract versioning + validated echo

**Problem.** We adapted to the DSL by probing it. If it changes between
deployments there is no signal — a broken `outputSchema` would be accepted silently
or rejected opaquely.

**Improvement.**
- Accept an optional `contractVersion` in the request body (the shape of
  `outputSchema` / request top-level keys).
- When it mismatches the running server's supported version, return a structured
  `400` with `errorCode: SCHEMA_VERSION_MISMATCH`, `supportedVersion`, and the
  offending keys — not a generic error.
- Echo `validated: true` and the applied `schemaVersion` on every `completed`
  response. If, for any reason, the server returns data it could not validate, mark
  it `validated: false`.
- Accept an optional `maxOutputTokens` per job so consumers can cap cost and keep
  responses within the schema's intent; the job fails with a `TIMEOUT`-style code if
  a provider hits the cap mid-generation.

**Any-flow benefit.** Consumers can build a tune-time check that fails fast at the
endpoint instead of at runtime, and can never mistake an unvalidated response for an
authoritative one.

---

## 6. Uniform failure contract & retry semantics

**Problem.** Failure info is structured but inconsistent:
- `errorCode` mix of `RATE_LIMIT` and `UNKNOWN`; two nvidia providers both timed out
    but their path was `UNKNOWN` (a `TIMEOUT` is more actionable).
- `retryAfterSeconds` appears **per provider**, not on the job. A client that wants
    to decide "should I retry, and how long must I wait?" can't answer from the job
    response.
- `retryable: true` exists but there is no guidance on *how long* to wait.

**Improvement.**
- Define a small, documented error-code enum, e.g.:
  `RATE_LIMIT`, `TIMEOUT`, `BAD_REQUEST`, `INVALID_SCHEMA`, `AUTH`, `UPSTREAM_UNAVAILABLE`, `UNKNOWN`.
  Every `providersAttempted[i]`, every `data.result.error` failure, and every
  HTTP problem status maps to exactly one of these.
- On final/provider failures, surface a **job-level** `retryable: bool`
  and `retryAfterSeconds: number` computed as the min wait across candidate
  providers (or the gate itself decides).
- Return standard `Retry-After` on 429/503 at the HTTP layer too.

**Any-flow benefit.** Every scheduler/queue can implement correct exponential backoff
and dead-lettering without the stepping package-specific logic.

---

## 7. Per-request provider routing (prefer / exclude) & deadlines

**Problem.** In our probe, `nvidia-llama` and `nvidia-dracarys` timed out and the
shared `gemini` was `429` for 2 hours. The client had **no way** to steer around a
known-bad provider or cap total time — it could only re-enqueue.

**Improvement.**
When creating a job, accept optional fields:
- `preferredProviders: ["gemini"]` — try in this order, useful when a consumer knows
  which model family it wants.
- `excludeProviders: ["nvidia-llama"]` — skip known-bad providers entirely.
- `plan: "cheapest-first" | "fastest-first" | "best-quality-first"` (the stepper
  picks for you) or `manual` (you list the order).
- `maxDurationSeconds` — a server-side hard deadline; if the provider budget is
  exhausted, return `data.result.error = GENERATION_FAILED` immediately with
  `retryable: false` instead of burning the limit.

**Any-flow benefit.** Cost, latency, and availability become per-consumer knobs.
This is the difference between "stepper guesses" and "stepper is configurable".

---

## 8. Make provider health usable *before* enqueuing

**Problem.** `GET /v1/providers` returns healthy flags only:

```json
{"status":"healthy","providers":[{"name":"nvidia-llama","healthy":true}, ...] ,"timestamp":"..."}
```

"Healthy" was true while every provider then failed the job — because a provider can
be TCP-up but rate-limited (its `429` retryAfter is the real signal).

**Improvement** — return, per provider:
- `name`, `healthy` (Boolean, current),
- `retryAfterSeconds` (this provider knows it's cooldown; `0` = none),
- `lastChecked` / `inferredFrom`, and
- `supportsBatch: boolean` and `maxTokens` (so consumers can pick *any* provider that
  can actually do the job).

Also add a **`GET /v1/health`** (liveness) distinct from `providers` (readiness) so a
client's startup can warm the process and know "the gate is up" separately from "any
provider can answer today".

**Any-flow benefit.** Consumers can do smart provider selection and can avoid
enqueuing work that cannot possibly succeed this minute.

---

## 9. Batch endpoint (biggest lever for this app)

**Problem.** Every run enriches `N` posts. We pay `POST + poll(~50s)` *per record*.
For a radar that discovers 15 posts that is ~12.5 serialized minutes of wall time,
and `N` HTTP round-trips.

**Improvement.**
- `POST /v1/generate/batch`:
  ```json
  { "items": [ {prompt…}, {prompt…}, … ], "responseMode":"json", "outputSchema":{…}, "metadata":{…} }
  ```
  → returns one `jobId`; `GET /v1/jobs/:id` progress exposes `done/_total`
  and the final `data.results[]` aligns 1:1 by index with `items`.
- Batch is best-effort per item (they can be slow), with same error/retry semantics as
  single generation.

**Any-flow benefit.** Batch turns the "stepper step" into a single round-trip for
content pipelines, indexers, crawlers, and translate loops — the same role this app
plays when it enriches a discovered post set.

---

## 10. Better polling: long-poll & callbacks

**Problem.** We poll every 4s up to 120s (30 requests). Fixed-interval polling is
imprecise and wastes requests; on a sleeping deploy it also potentially wakes
the process repeatedly.

**Improvement.**
- **HTTP long-poll**: `GET /v1/jobs/:id?wait=true&timeout=30` — the request blocks up
  to `timeout` seconds and returns the latest `status`/`progress` on change or at
  timeout (with an indicator it timed out, not failed).
- **Webhook callback**: the client supplies `callbackUrl`; the server POSTs
  `{status}` on completion/failure. Works fine for background flows.
- Keep plain `GET /v1/jobs/:id` available as immutable polling for consumers that
  prefer it.

**Any-flow advantage.** Consumers get push or near-realtime; the stepper stays
compatible with both sync-proxy and async-queue callers, and avoids tight loops.

---

## 11. Idempotency, cache keys, refresh

**Problem.** A radar re-runs the same canonical URLs each refresh. Today you
*report* a cache path exists (an immediate `status: completed` on POST), but it's not
controllable. Consumers risk re-charging the same prompt repeatedly.

**Improvement.**
- Server-side **idempotency by a hashed request** (prompt + schema + model + key);
  include that hash in responses (`cacheKey`) and support `cacheKey` request override.
- `cacheControl: "default" | "no-cache" | "refresh"`:
  - `no-cache` – never hit cache (live run);
  - `refresh` – regenerate and overwrite cached.
- TTL header (`x-cache-ttl`) and a `X-Cache: HIT`/`MISS` on responses.

**Any-flow benefit.** Schedulers (that re-run domain objects) and synchronous CRUD
consumers both get cost/speed control with no change to the request contract.

---

## 12. Quotas surfaced to the API-key consumer

**Problem.** The shared key hit `429` with `retryAfterSeconds: 7200` — a 2-hour
lockout. There was no header telling the client earlier.

**Improvement.**
- Return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every
  response (per auth key).
- Add `GET /v1/usage` (key-scoped): used/quota, rollover, per-provider consumption,
  and next reset.
- Return `RATE_LIMIT` at the HTTP layer with a standard `Retry-After` header when a
  key is over quota, so any client honors the lockout correctly.

**Any-flow benefit.** Billing across providers on shared keys is common; the only safe
behavior is being able to see a lockout / budget *before* a run.

---

## 13. Cold start & warm-up

**Problem.** Free-tier deploy slept: the first `POST` after idle took ~40s+ and then
its provider set was also in cooldown. Those combine to look like "the service is
very slow".

**Improvement (very doable and general):**
- A cheap liveness `GET /health` that boots a worker *without* spinning up providers.
- A documented **warm-up** ping or a keep-alive setting that holds a provider session
  open so the first consumer request isn't paying cold start.
- Let `GET /health` double as a warm trigger and document recommended stay-alive
  intervals.

**Any-flow benefit.** Any flow on a serverless/sleepable host gets smooth low latency
rather than an occasional ~40s first request.

---

## 14. Implementation priority (do this order)

| Order | Item | Effort | Benefit here |
|------:|------|--------|--------------|
| 1 | Uniform `errorCode` enum + job-level `retryable`/`retryAfterSeconds` (sec 5) | Low | Correct retry behavior; unblocks reliable scheduling |
| 2 | `excludeProviders`/`preferredProviders`/`maxDurationSeconds` (sec 7) | Low | Routing around known-bad providers immediately |
| 3 | Nested array-of-object schema + `validated` echo (sec 4–5) | Med | Eliminates silent-invalid-output failure mode |
| 4 | Provider health include `retryAfterSeconds` + `GET /health` (sec 8, 13) | Low | Pick a healthy provider before enqueuing |
| 5 | Batch endpoint (sec 9) | Med | The single biggest latency/cost win for batch flows |
| 6 | Long-poll / callbacks / cache keys (sec 10–11) | Med | Lower chat, deterministic re-runs |
| 7 | Quota headers + usage (sec 12) | Med | Cost visibility & correct wait behavior |

Items 1–2 directly unblock the current integration; 5 is the largest scale win for
radar / heavy-batch consumers.

---

## 15. Appendix — current reference from this codebase

File: `backend/src/opportunity_engine/integrations/ai_inference.py`
- `StepperHttpAdapter` → POST `/v1/generate`; poll `GET /v1/jobs/<id>`.
- Current safety-budget: `_STEPPER_POST_TIMEOUT = 90.0`,
  `_STEPPER_POLL_ATTEMPTS = 30`, `_STEPPER_POLL_INTERVAL_SECONDS = 4.0`.
- `StepperHttpAdapter` `_poll_job` returns `None` on any failure (record survives).

Output shape validated by adapter: `AiOrganizerResult`:
`classification` (string), `summary` (string), `claims[]` ({field, value,
source_url, confidence}), optional `reasons[]`, `suggested_score`, `flags[]`.

Applying the uniform error contract (sec 6), provider routing (sec 7), provider
health (sec 8), batch (sec 9), and quotas (sec 12) would let our gate drastically
reduce the per-record ~50s and shared-key lockouts without changing our code and
without touching at all the deterministic record-survival invariant.

---

*End of reference. Update this doc before committing when the stepper package lands
each improvement.*

## 16. Implementation status and help wanted

The recommendations below are tracked against the evidence in sections 2–15.
“Done” means the package contains the implementation and tests. “Partial” means
the useful contract is available but the complete recommendation still needs
work. “Open” means the original recommendation is not implemented yet.

| Feedback source | Status | What Stepper provides now | Implementation value |
|---|---|---|---|
| Section 4: nested output schemas | Done | Nested objects, typed array items, additional-key rejection, and length limits | Consumers can reject malformed structured model output at the service boundary. |
| Sections 5–6: contract and failures | Partial | Contract version checks, validated metadata, stable provider error codes, structured job/item failures, and retry hints | Consumers can distinguish invalid requests from transient provider failures; job-level retry policy still needs broader `Retry-After` coverage. |
| Section 7: provider routing | Partial | `preferredProviders` and `excludeProviders` per request | Consumers can avoid known-bad provider lanes; plans and hard deadlines remain open. |
| Sections 8 and 13: health | Partial | Provider circuit state, cooldown hints, timestamps, capability metadata, and liveness health endpoint | Consumers can inspect service/provider state; active provider readiness probes remain open. |
| Section 9: batch generation | Done | HTTP and library batch APIs, stable item IDs, input-order alignment, bounded concurrency, partial failures, and progress | Consumers can process many independent records without mixing context or monopolizing single-request workers. |
| Sections 10–11: delivery and cache | Partial | Normal polling, callbacks, cache controls, and request-centric cache keys | Consumers have asynchronous delivery and refresh controls; long-polling and richer cache headers remain open. |
| Section 12: rate and quotas | Partial | Redis-backed IP and tenant/user limits, weighted batch charging, and fail-closed limiter behavior | Multi-instance deployments share protection; usage endpoints and full rate-limit headers remain open. |

### Batch implementation details

Batch jobs use separate single-request and batch BullMQ queues. Queue
concurrency and per-batch item concurrency are independently bounded. Progress
updates are throttled and always finish with an exact `{ done, total }` value.
Each item keeps its own request, cache key, provider preferences, tenant, and
failure metadata. A failed item does not discard successful siblings.

The library and HTTP entry points share envelope validation for item limits,
unique bounded IDs, request objects, and concurrency. Transient provider errors
retain stable error codes, retryability, and provider-attempt metadata. Worker
tests cover alignment, concurrency, progress completion, and partial failures.

### Remaining implementation help

Useful contributions include true provider readiness probes, long polling,
quota/usage reporting, warm-provider sessions, broader `Retry-After` support,
and HTTP integration tests against real Redis and BullMQ. Contributions should
include tests and must not include provider credentials, authorization headers,
or private prompts.

This is production hardening, not a blanket security certification. Production
deployments still need protected Redis, TLS and secret management, provider quota
configuration, observability, and load testing against the expected traffic
profile. All API replicas and workers must use the same Redis deployment.

## 17. Release and package distribution status

The package version is now `1.1.0`, reflecting the completed contract, batch, and
production-hardening work. The package build, type check, lint, full test suite,
and npm package dry run pass. The published package includes the README, the
documentation home, the developer implementation guide, and this feedback record.

The package repository contains an npm publish workflow at
`.github/workflows/publish.yml`. It runs for a published GitHub Release or by
manual dispatch, builds the package, and publishes it with public access and npm
provenance. The package is also marked public through `publishConfig`. The CI
workflow runs lint, type check, build, and tests with Redis before changes land.

To release `1.1.0`, create or publish the matching GitHub Release after the version
change has been reviewed. Confirm that the release workflow's npm trusted
publishing or token configuration is enabled for the package, then verify the
published tarball and documentation on npm.
