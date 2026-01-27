# @commitdiary/stepper - Architecture & Flow

## 📍 Entry Points

The stepper package has **TWO main entry points** depending on how you use it:

### 1. **As a Standalone HTTP Service** (Current Mode)

**Entry Point:** `src/server/app.ts`

```bash
# Development
pnpm dev  # Runs: tsx watch src/server/app.ts

# Production
pnpm start  # Runs: node dist/server/app.js
```

### 2. **As a Library (In-Process)**

**Entry Point:** `src/index.ts` (exported as `dist/index.js`)

```typescript
import { enqueueReport, generateReport } from "@commitdiary/stepper";
```

---

## 🏗️ Architecture Overview

![Stepper Architecture](./docs/assets/architecture.png)

```
┌─────────────────────────────────────────────────────────────────┐
│                      HTTP SERVER (Express)                       │
│                    src/server/app.ts                             │
│  Endpoints: POST /v1/reports, GET /v1/reports/:id, /health      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PUBLIC API LAYER                              │
│                    src/index.ts                                  │
│  Functions: enqueueReport(), generateReport(), getJob()         │
└────────┬────────────────────────────┬───────────────────────────┘
         │                            │
         │ (async)                    │ (sync)
         ▼                            ▼
┌──────────────────┐         ┌──────────────────┐
│  CACHE LAYER     │         │  ORCHESTRATOR    │
│  Redis Cache     │         │  AI Selection    │
│  Check/Store     │         │  src/stepper     │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         │ (miss)                     │ (calls factory)
         ▼                            ▼
┌──────────────────┐         ┌────────────────────────┐
│  QUEUE LAYER     │         │    PROVIDER FACTORY    │
│  BullMQ          │         │    src/providers/      │
│  Job Enqueue     │         │    (Unified/Special)   │
└────────┬─────────┘         └────────┬───────────────┘
         │                            │
         ▼                            ▼
┌──────────────────┐         ┌────────────────────────┐
│  WORKER LAYER    │         │     PROMPT BUILDER     │
│  BullMQ Worker   │         │    (Comprehensive/     │
│  Process Jobs    │         │     Simple Prompt)     │
└──────────────────┘         └────────────────────────┘
```

---

## 🔄 Complete Request Flow

### **Flow 1: Async Request (POST /v1/reports)**

```
1. HTTP Request arrives at Express server
   └─> src/server/app.ts (line 35)

2. Request routed to enqueueReport()
   └─> src/index.ts (line 74)

3. Build cache key from userId + commitSha + templateHash
   └─> src/index.ts (line 80-81)

4. Check Redis cache
   └─> src/cache/redisCache.ts:getReportCache() (line 43)

   ┌─ CACHE HIT (Fresh) ──────────────────────────┐
   │ Return immediately with status 200           │
   │ Response: { status: 200, data: report }      │
   └──────────────────────────────────────────────┘

   ┌─ CACHE HIT (Stale) ──────────────────────────┐
   │ Return stale data with status 200            │
   │ Schedule background refresh job (priority 10)│
   │ Response: { status: 200, data: report,       │
   │            stale: true }                      │
   └──────────────────────────────────────────────┘

   ┌─ CACHE MISS ─────────────────────────────────┐
   │ 5. Create dehydrated cache entry             │
   │    └─> setDehydrated(cacheKey, jobId)        │
   │                                               │
   │ 6. Enqueue job to BullMQ                     │
   │    └─> src/queue/producer.ts (line 31)       │
   │    └─> queue.add('generate-report', jobData) │
   │                                               │
   │ 7. Return job ID with status 202             │
   │    Response: { status: 202, jobId: "uuid",   │
   │               statusUrl: "/v1/reports/uuid" }│
   └──────────────────────────────────────────────┘

8. BullMQ Worker picks up job
   └─> src/queue/worker.ts:processReportJob() (line 16)

9. Worker calls orchestrator
   └─> src/stepper/orchestrator.ts:generateReportNow() (line 181)

10. Orchestrator tries providers in order
    └─> For each provider:
        ├─> Check circuit breaker (line 198)
        ├─> Apply rate limiting (Bottleneck) (line 222)
        ├─> Use Prompt Builder to construct instructions (Comprehensive vs Simple)
        ├─> Call provider via Unified or Specialized Adapter
        │   └─> src/providers/unified.adapter.ts
        │   └─> src/providers/hfSpace.adapter.ts
        └─> On success: return result
        └─> On failure: try next provider

11. If all providers fail → Fallback template
    └─> src/fallback/templateFallback.ts

12. Store result in Redis cache (hydrated)
    └─> src/cache/redisCache.ts:setHydrated() (line 85)

13. Invoke success/fallback callbacks
    └─> src/stepper/orchestrator.ts (line 237 or 273)

14. Update job status in BullMQ
    └─> job.updateProgress(100)
```

---

### **Flow 2: Sync Request (POST /v1/reports/immediate)**

```
1. HTTP Request arrives
   └─> src/server/app.ts (line 71)

2. Request routed to generateReport()
   └─> src/index.ts (line 145)

3. Directly call orchestrator (no cache, no queue)
   └─> src/stepper/orchestrator.ts:generateReportNow()

4. Orchestrator tries providers → Returns result
   └─> Same provider flow as async (steps 10-11 above)

5. Return result immediately with status 200
   Response: { status: 200, data: report,
              metadata: { provider, timings } }
```

---

## 📦 Module Breakdown

### **1. Server Layer** (`src/server/app.ts`)

- **Purpose:** HTTP API endpoints
- **Key Functions:**
  - `POST /v1/reports` → Async report generation
  - `POST /v1/reports/immediate` → Sync report generation
  - `GET /v1/reports/:jobId` → Job status polling
  - `GET /health` → Health check
  - `GET /metrics` → Prometheus metrics
- **Lifecycle:**
  - Starts Express server on port 3001
  - Starts BullMQ worker (line 196)
  - Handles graceful shutdown (SIGTERM/SIGINT)

---

### **2. Public API Layer** (`src/index.ts`)

- **Purpose:** Main library interface
- **Exported Functions:**

#### `enqueueReport(input: PromptInput)`

- **Returns:** `{ status: 200, data }` OR `{ status: 202, jobId }`
- **Flow:**
  1. Compute cache key
  2. Check Redis cache
  3. If fresh → return immediately
  4. If stale → return + schedule refresh
  5. If miss → enqueue job + return jobId

#### `generateReport(input: PromptInput)`

- **Returns:** `ProviderResult` (blocking)
- **Flow:**
  1. Call orchestrator directly
  2. Wait for result
  3. Return report

#### `getJob(jobId: string)`

- **Returns:** Job status from BullMQ
- **Flow:**
  1. Query BullMQ queue
  2. Return job state + result

#### `registerCallbacks(callbacks: StepperCallbacks)`

- **Purpose:** Register lifecycle hooks
- **Callbacks:**
  - `onStart(jobId, input)`
  - `onProviderAttempt(jobId, provider, attempt)`
  - `onSuccess(jobId, provider, result, meta)`
  - `onFallback(jobId, result, meta)`
  - `onFailure(jobId, errors)`

---

### **3. Orchestrator Layer** (`src/stepper/orchestrator.ts`)

- **Purpose:** AI provider selection and fallback logic
- **Key Functions:**

#### `initializeProviders(configs: ProviderConfig[])`

- **Called:** On module load (line 20 in index.ts)
- **Flow:**
  1. Filter enabled providers from config
  2. Use **Provider Factory** (`src/providers/factory.ts`) to create suitable adapters
  3. Factory chooses between `UnifiedProviderAdapter` (using specs) and specialized ones like `HuggingFaceSpaceAdapter`
  4. Wrap with Bottleneck rate limiter
  5. Wrap with Opossum circuit breaker
  6. Store in `providers[]` array

#### `generateReportNow(input: PromptInput, jobId: string)`

- **Flow:**
  1. Invoke `onStart` callback
  2. Loop through providers in priority order
  3. For each provider:
     - Check circuit breaker state
     - If open → skip provider
     - If closed → attempt provider
     - Apply rate limiting (Bottleneck)
     - Call with retries (exponential backoff)
     - On success → return result
     - On failure → try next provider
  4. If all fail → generate fallback template
  5. Invoke `onSuccess` or `onFallback` callback

#### `callWithRetries(provider, input, jobId)`

- **Flow:**
  1. Try up to `maxAttempts` times (default: 3)
  2. Use circuit breaker to call provider
  3. On failure:
     - If AuthError → stop retries
     - If RateLimitError → respect Retry-After header
     - If retryable → exponential backoff + retry
  4. Return result or throw error

---

### **4. Cache Layer** (`src/cache/redisCache.ts`)

- **Purpose:** Redis-backed caching with stale-while-revalidate
- **Key Functions:**

#### `getRedisClient()`

- **Returns:** Singleton Redis client
- **Config:** `maxRetriesPerRequest: null` (required by BullMQ)

#### `getReportCache(key: string)`

- **Returns:** `CacheEntry | null`
- **Entry Types:**
  - `dehydrated` - Job enqueued, not yet processed
  - `hydrated` - Report generated and cached
  - `failed` - Generation failed

#### `setHydrated(key, result, providers, fallback, ttl)`

- **Purpose:** Store generated report in cache
- **TTL:** Default 7 days (604800 seconds)

#### `isHydratedFresh(entry: CacheEntry)`

- **Returns:** `true` if age < staleThreshold (24 hours)

#### `isStaleButUsable(entry: CacheEntry)`

- **Returns:** `true` if stale but usable for stale-while-revalidate

---

### **5. Queue Layer** (`src/queue/`)

#### **Producer** (`src/queue/producer.ts`)

- **Purpose:** Enqueue jobs to BullMQ

##### `enqueueReportJob(input, cacheKey, options)`

- **Flow:**
  1. Generate unique jobId (UUID)
  2. Create job data object
  3. Add to BullMQ queue
  4. Return jobId

##### `getJobStatus(jobId: string)`

- **Flow:**
  1. Query BullMQ for job
  2. Get job state (waiting, active, completed, failed)
  3. Return status + result

#### **Worker** (`src/queue/worker.ts`)

- **Purpose:** Process jobs from BullMQ queue

##### `startWorker()`

- **Called:** When server starts (line 196 in app.ts)
- **Flow:**
  1. Get Redis client
  2. Create BullMQ Worker
  3. Set concurrency (default: 5)
  4. Register event handlers (completed, failed, error)

##### `processReportJob(job: Job<ReportJobData>)`

- **Flow:**
  1. Extract jobId, input, cacheKey from job data
  2. Check cache again (avoid race condition)
  3. If already hydrated → skip
  4. Call `generateReportNow()` from orchestrator
  5. Store result in cache with `setHydrated()`
  6. Update job progress to 100%
  7. On error → mark cache as failed

---

### **6. Provider Layer** (`src/providers/`)

#### **Provider Factory** (`factory.ts`)

- **Purpose**: Centralized instantiation of AI adapters.
- **Logic**:
  - Uses `hfSpace.adapter.ts` for HuggingFace specific needs.
  - Uses `UnifiedProviderAdapter` with `specs.ts` for standard APIs (Gemini, OpenAI, Cohere, etc.).

#### **Unified Adapter System**

- **`unified.adapter.ts`**: A generic adapter that talks to any AI following standard request/response patterns.
- **`specs.ts`**: Contains the "vocabulary" for each provider (URLs, header structures, response parsing rules).
- **Benefits**: Adding a new AI provider only requires adding a config spec, not new code.

#### **Prompt Builder** (`promptBuilder.ts`)

- **Purpose**: Ensures high-quality AI outputs by following senior engineer personas and strict JSON formatting instructions.
- **Options**:
  - `buildComprehensivePrompt()`: Detailed, multi-paragraph instructions for high-reasoning models.
  - `buildSimplePrompt()`: Concise instructions for faster/smaller models.
  - `redactSecrets()`: Integrated security pass to ensure PII/keys don't leak to AI providers.

#### **Specialized Adapters**

- **`hfSpace.adapter.ts`**: Handles HuggingFace-specific logic like health checks and wake-up signals.

---

### **7. Fallback Layer** (`src/fallback/templateFallback.ts`)

- **Purpose:** Generate report when all providers fail
- **Flow:**
  1. Extract commit info from input
  2. Generate basic report structure
  3. Return `ReportOutput` with template data

---

### **8. Metrics Layer** (`src/metrics/metrics.ts`)

- **Purpose:** Prometheus metrics collection
- **Metrics:**
  - `ai_requests_total{provider, status}`
  - `ai_request_duration_seconds{provider}`
  - `cache_hits_total{status}`
  - `cache_misses_total`
  - `provider_failures_total{provider, reason}`
  - `jobs_processed_total{status}`

---

## 🔧 Configuration (`src/config.ts`)

All configuration loaded from environment variables:

```typescript
{
  server: { port: 3001 },
  redis: { url, keyPrefix },
  cache: { ttlSeconds, staleThreshold, enableStaleWhileRevalidate },
  queue: { name, concurrency },
  retry: { maxAttempts, baseDelayMs, maxJitterMs },
  circuit: { failureThreshold, windowSeconds, cooldownSeconds },
  security: { redactBeforeSend },
  providers: [
    { name: 'hf-space', enabled, baseUrl, apiKey, rps, concurrency, timeout },
    { name: 'gemini', enabled, ... },
    { name: 'cohere', enabled, ... }
  ]
}
```

---

## 🎯 Key Design Patterns

### **1. Stale-While-Revalidate**

- Return stale cached data immediately
- Schedule background refresh asynchronously
- User gets fast response, cache stays fresh

### **2. Circuit Breaker Pattern**

- Prevent cascading failures
- Skip failing providers automatically
- Auto-recovery after cooldown period

### **3. Rate Limiting**

- Bottleneck ensures RPS limits per provider
- Prevents API quota exhaustion
- Queues requests when limit reached

### **4. Retry with Exponential Backoff**

- Retry transient failures
- Exponential delay: 500ms, 1s, 2s, 4s...
- Respect Retry-After headers

### **5. Provider Fallback Chain**

- Try providers in priority order
- Skip providers with open circuit breakers
- Fall back to template if all fail

### **6. Async Job Processing**

- Non-blocking API responses
- BullMQ handles job distribution
- Workers process jobs in background

---

## 📊 Data Flow Example

### **Example: First-time request for a commit**

```
User → POST /v1/reports
  ↓
enqueueReport({ userId: "u1", commitSha: "abc123", ... })
  ↓
buildCacheKey("u1", "abc123", "default")
  → "stepper:report:u1:abc123:default"
  ↓
getReportCache("stepper:report:u1:abc123:default")
  → null (cache miss)
  ↓
setDehydrated("stepper:report:u1:abc123:default", "job-uuid")
  → Redis: { status: "dehydrated", jobId: "job-uuid" }
  ↓
enqueueReportJob(input, cacheKey)
  → BullMQ: Add job "job-uuid" to queue
  ↓
Response: { status: 202, jobId: "job-uuid" }

--- Background Worker ---
Worker picks up job "job-uuid"
  ↓
processReportJob(job)
  ↓
generateReportNow(input, "job-uuid")
  ↓
Try HF Space provider
  ↓ (rate limited by Bottleneck)
  ↓ (protected by circuit breaker)
  ↓
HuggingFaceSpaceAdapter.call(input)
  → POST https://hf-space.hf.space/api/infer
  → Response: { report: "{...}" }
  ↓
parseAndValidateReport(response)
  → Valid ReportOutput
  ↓
setHydrated("stepper:report:u1:abc123:default", result)
  → Redis: { status: "hydrated", result: {...}, ttl: 604800 }
  ↓
job.updateProgress(100)
  ↓
Invoke onSuccess callback
```

### **Example: Subsequent request (cache hit)**

```
User → POST /v1/reports (same commit)
  ↓
enqueueReport({ userId: "u1", commitSha: "abc123", ... })
  ↓
getReportCache("stepper:report:u1:abc123:default")
  → { status: "hydrated", result: {...}, timestamps: {...} }
  ↓
isHydratedFresh(cached)
  → true (age < 24 hours)
  ↓
Response: { status: 200, data: {...}, cached: true }
  (no job enqueued, instant response!)
```

---

## 🚀 Startup Sequence

When you run `pnpm dev`:

1. **Load environment** (`.env` file)
2. **Import `src/server/app.ts`**
3. **Import `src/index.ts`** (module load)
   - Calls `initializeProviders()` (line 20)
   - Loads provider configs
   - Creates adapters, limiters, circuit breakers
4. **Start Express server** on port 3001
5. **Start BullMQ worker** (line 196)
   - Connects to Redis
   - Starts processing jobs
6. **Server ready** ✅

---

## 🔍 Debugging Tips

### **Check what's running:**

```bash
# Redis
redis-cli ping  # Should return PONG

# Server logs
pnpm dev  # Watch for "Server started" and "Worker started"
```

### **Monitor queue:**

```bash
# In Redis CLI
redis-cli
> KEYS stepper:*
> GET stepper:report:user:commit:hash
```

### **Test endpoints:**

```bash
# Health check
curl http://localhost:3001/health

# Metrics
curl http://localhost:3001/metrics

# Generate report (async)
curl -X POST http://localhost:3001/v1/reports \
  -H "Content-Type: application/json" \
  -d '{"userId":"test","commitSha":"abc","repo":"test/repo","message":"test"}'
```

---

**Last Updated:** 2026-01-24  
**Version:** 1.0.0
