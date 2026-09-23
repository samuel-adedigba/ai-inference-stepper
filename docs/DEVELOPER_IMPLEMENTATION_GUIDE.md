# Stepper developer implementation guide

> Navigation: [Documentation home](./README.md) · [Architecture](../ARCHITECTURE.md) · [Testing](../TESTING_GUIDE.md) ·
> [API feedback](./STEPPER_API_FEEDBACK.md)

## Quick start

Install the package with pnpm:

```bash
pnpm add ai-inference-stepper
```

For a local HTTP service, start Redis, configure at least one provider, and run the Stepper server:

```bash
docker run --name stepper-redis --detach --publish 6379:6379 redis:alpine
export REDIS_URL=redis://localhost:6379
export API_KEY_ENABLED=true
export STEPPER_API_KEY=replace-with-a-long-random-value
export QUEUE_NAME=stepper-single
export BATCH_QUEUE_NAME=stepper-batch
export QUEUE_CONCURRENCY=5
export BATCH_QUEUE_CONCURRENCY=2
export BATCH_MAX_CONCURRENCY=5
export BATCH_MAX_ITEMS=100
export OPENAI_ENABLED=true
export OPENAI_API_KEY=replace-with-your-provider-key
npx stepper
```

Qorebit can be enabled as two server-side model lanes. Qwen3 Coder Flash is the
fast coding-focused primary for structured CommitDiary reports, while DeepSeek V3
is a stronger fallback for harder generations:

```bash
export QOREBIT_API_KEY=qb_live_replace-with-your-provider-key
export QOREBIT_QWEN_ENABLED=true
export QOREBIT_DEEPSEEK_ENABLED=true
npx stepper
```

Both lanes use the OpenAI-compatible Qorebit Chat Completions endpoint. Keep
`QOREBIT_API_KEY` in Stepper's server environment; consumers should select
`preferredProviders: ["qorebit-qwen", "qorebit-deepseek"]` only by lane name.
Do not send provider credentials or arbitrary model IDs in HTTP requests.

Qorebit currently offers a free 5-credit trial and then meters model usage by
tokens. The free trial is not an unlimited/free inference tier; open-weight
models still consume credits. Configure Qorebit dashboard credit caps before
enabling it in a shared or production environment.

In production, provide secrets through the hosting platform's environment configuration. Do not commit them or place
them in request payloads.

Stepper is a provider-agnostic inference reliability layer for Node.js and TypeScript applications. It accepts a
request, validates the generated output, runs providers with retry and failover rules, stores results in Redis, and
exposes a queue-backed job API.

It is designed for any workflow that turns input into AI output. Examples include classification, structured
extraction, summarization, moderation, record enrichment, indexing, translation, and content transformation.

Commit reports are a compatibility preset. They are not the boundary of the package.

## Choose an integration mode

Use the library API when Stepper runs in the same Node.js process as your application. Use the HTTP API when the
consumer and Stepper are separate services, runtimes, or deployment units.

## HTTP contract

`POST /v1/generate` accepts a generic prompt and optional payload. Provider credentials remain server-side.

```json
{
  "tenantId": "catalog",
  "requestId": "product-123",
  "prompt": "Extract the product name and price as JSON.",
  "payload": { "text": "Coffee beans — $18" },
  "responseMode": "json",
  "contractVersion": "1",
  "cacheControl": "default",
  "preferredProviders": ["openai", "gemini"],
  "excludeProviders": ["nvidia-llama"],
  "outputSchema": {
    "kind": "http-json",
    "requiredKeys": ["product", "price"],
    "properties": {
      "product": { "type": "string" },
      "price": { "type": "number" },
      "claims": {
        "type": "array",
        "items": {
          "type": "object",
          "requiredKeys": ["field", "value"],
          "properties": {
            "field": { "type": "string" },
            "value": { "type": "string" }
          },
          "allowAdditionalKeys": false
        },
        "minItems": 0,
        "maxItems": 20
      }
    },
    "allowAdditionalKeys": false
  }
}
```

The schema supports scalar values, nested objects, arrays of typed items, required keys, additional-key rejection,
and array length limits. Use `responseMode: "text"` for plain text. Do not send `outputSchema` with text mode.

## Batch generation

Use `POST /v1/generate/batch` when several independent items should be processed under one job. Every item has a
required unique `id`, and the final result keeps both the `id` and original `index`, so concurrent execution cannot
place one user's result into another item's slot.

```json
{
  "tenantId": "catalog",
  "requestId": "catalog-refresh-2026-08-08",
  "concurrency": 5,
  "items": [
    {
      "id": "product-101",
      "request": {
        "requestId": "product-101",
        "prompt": "Extract the product name and price as JSON.",
        "payload": { "text": "Coffee beans — $18" },
        "responseMode": "json"
      }
    },
    {
      "id": "product-102",
      "request": {
        "requestId": "product-102",
        "prompt": "Extract the product name and price as JSON.",
        "payload": { "text": "Tea leaves — $12" },
        "responseMode": "json"
      }
    }
  ]
}
```

The response is one queued job. Poll its normal `statusUrl`. Progress is reported as `{ "done": 1, "total": 2 }`.
The completed result is ordered by input index:

```json
{
  "status": "completed",
  "data": {
    "items": [
      { "id": "product-101", "index": 0, "status": "completed", "data": { "product": "Coffee beans" } },
      { "id": "product-102", "index": 1, "status": "failed", "failure": { "errorCode": "RATE_LIMIT", "retryable": true } }
    ],
    "total": 2,
    "completed": 1,
    "failed": 1
  }
}
```

This first batch implementation uses independent provider calls with bounded
concurrency. It does not combine prompts into one large model prompt, so one
item's context cannot bleed into another item. Provider-native batching can be
added later for providers that advertise `supportsBatch: true`, while retaining
the same item IDs and result alignment contract.

Batch concurrency is bounded by `BATCH_MAX_CONCURRENCY` (default `5`) and item count by `BATCH_MAX_ITEMS` (default
`100`). Batch jobs run on a separate BullMQ queue with `BATCH_QUEUE_CONCURRENCY` (default `2`), so a large batch
cannot consume all single-request worker slots. `QUEUE_CONCURRENCY` controls normal jobs, and each provider's own
limiter remains the final upstream capacity boundary. Progress writes are deliberately bounded instead of issuing
one Redis write per item. Item failures do not fail successful siblings; retry the failed item IDs using their returned
failure metadata.

For production deployments, run at least one worker process with the same Redis configuration as the API process.
Scale API and worker processes independently, keep `BATCH_QUEUE_NAME` distinct from `QUEUE_NAME`, and tune both queue
concurrency values against provider quotas and observed latency. Redis availability is required for queue durability,
cache state, and status polling; monitor Redis errors, queue age, active jobs, provider rate limits, and failed-item
counts before increasing concurrency.

Each item is an independent request. Its schema, cache key, provider preferences, callbacks, and tenant identity remain
isolated. If several users submit batches at the same time, queue concurrency and provider limiters provide the shared
capacity boundary. Do not use array position as identity in your application; use the returned item `id`.

Models remain configured per provider on the Stepper server. A batch does not silently force one model across different
providers. To select a model family, configure the provider lane and use `preferredProviders` or `excludeProviders` on
the individual item. Per-item arbitrary model selection is intentionally not enabled until provider model allowlists
and cost controls are available.

## Job lifecycle

The submit response is either a queued job:

```json
{
  "status": "queued",
  "jobId": "job-id",
  "statusUrl": "/v1/jobs/job-id"
}
```

or an immediate cached result with `status: "completed"`.

`GET /v1/jobs/:jobId` exposes these stable public statuses:

- `queued`: waiting, delayed, or prioritized in the queue;
- `active`: a worker is processing the request;
- `completed`: validated output is available in `data`; and
- `failed`: processing ended without a result.

The response also includes `rawStatus` for diagnostics. Consumers should branch on `status`, not on BullMQ state names.

Failed jobs include a stable machine-readable failure contract:

```json
{
  "status": "failed",
  "failure": {
    "errorCode": "RATE_LIMIT",
    "message": "All providers are currently rate-limited.",
    "retryable": true,
    "retryAfterSeconds": 7200
  }
}
```

Use `failure.retryable` and `failure.retryAfterSeconds` when scheduling retries. Do not parse human-readable error
strings.

The current HTTP contract version is `1`. An unsupported version returns HTTP `400` with
`errorCode: "SCHEMA_VERSION_MISMATCH"` and `supportedVersion`. Use `cacheControl: "no-cache"` to bypass reads while
still writing the new result, or `cacheControl: "refresh"` to regenerate and replace the cached result.

## Provider routing and health

`preferredProviders` changes the order of configured provider names. `excludeProviders` removes named providers for
that request. Unknown names do not create providers, and configured credentials remain server-side.

For HTTP consumers, do not send the legacy `providers` configuration array. Configure providers on the Stepper
server and use the two name-based routing fields above.

`GET /v1/providers` reports circuit-breaker state, cooldown hints, last-check time, and current capability fields such
as `supportsBatch` and `maxTokens`. It is not a guaranteed live call to each upstream provider. `GET /health` reports
overall Stepper readiness. Treat these as operational signals, not proof that a specific prompt will succeed.

## Caching and callbacks

Use stable `tenantId` and `requestId` values for repeatable request identity. Set `cacheKey` when your domain has its
own canonical identity. Cached results may be returned immediately; the current HTTP API does not provide a force-refresh
or no-cache switch.

The library API supports typed callbacks. HTTP callback delivery is subject to the configured callback URL allowlist
and server-side webhook secret.

## Library API

```ts
import { enqueueRequest, initStepper } from 'ai-inference-stepper';

initStepper({
  config: { redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' } },
});

const result = await enqueueRequest({
  tenantId: 'catalog',
  requestId: 'product-123',
  prompt: 'Extract the product name and price as JSON.',
  payload: { text: 'Coffee beans — $18' },
  responseMode: 'json',
  preferredProviders: ['openai', 'gemini'],
  excludeProviders: ['nvidia-llama'],
});
```

## Deployment requirements

Provide Redis through `REDIS_URL`, at least one enabled provider, a worker process, and `STEPPER_API_KEY` in
production. Keep `QUEUE_NAME` and `BATCH_QUEUE_NAME` different. All API replicas and workers must use the same
protected Redis instance because it stores queues, cache state, job status, and distributed rate-limit counters.
Browser clients also need an explicit `CORS_ALLOWED_ORIGINS` list. Tune queue and provider concurrency from measured
provider quotas and latency; do not treat the defaults as a capacity guarantee.

Run `pnpm build`, `pnpm typecheck`, and `pnpm test` before publishing or deploying.

## Help wanted

Useful contributions include provider readiness probes, long polling, quota/usage reporting, warm-provider sessions,
and HTTP integration tests against Redis and BullMQ. Include tests with changes. Never include API keys,
authorization headers, or private prompts in issues or pull requests.
