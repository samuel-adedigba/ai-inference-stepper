# @commitdiary/stepper

Production-grade AI inference orchestrator with multi-provider fallback, Redis-backed caching and queueing, rate limiting, circuit breakers, and comprehensive observability.

## Features

- **Multi-provider fallback**: Automatically tries providers in priority order
- **Resilient**: Circuit breakers, retries with exponential backoff, Retry-After header support
- **Cached**: Redis-backed caching with hydrated/dehydrated states and stale-while-revalidate
- **Async queueing**: BullMQ job queue with background workers
- **Rate limiting**: Per-provider Bottleneck limiters with configurable RPS and concurrency
- **Observable**: Prometheus metrics, structured logging (pino), Discord alerts
- **Secure**: CORS, rate limiting, Helmet security headers, optional API key auth, PII redaction
- **Testable**: Mocked providers in tests, comprehensive unit and integration coverage
- **Extensible**: Clean provider adapter interface, lifecycle callbacks for custom logic

## Security

The server includes comprehensive security measures, all configurable via environment variables:

### 1. CORS (Cross-Origin Resource Sharing)

Controls which origins can access your API.

```bash
CORS_ENABLED=true                    # Enable/disable CORS (default: true)
CORS_ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com  # Comma-separated
CORS_ALLOW_CREDENTIALS=false         # Allow cookies/auth headers (default: false)
```

### 2. Rate Limiting

Protects against abuse and DDoS attacks with both IP-based and user-based limits.

```bash
RATE_LIMIT_ENABLED=true              # Enable/disable rate limiting (default: true)
RATE_LIMIT_WINDOW_MS=900000          # Time window in ms (default: 15 minutes)
RATE_LIMIT_MAX_REQUESTS=100          # Max requests per window per IP (default: 100)
RATE_LIMIT_MAX_PER_USER=50           # Max requests per window per userId (default: 50)
RATE_LIMIT_SKIP_HEALTH=true          # Skip limits for /health, /metrics (default: true)
```

Rate limit responses include `RateLimit-*` headers and a 429 status:

```json
{
  "error": "Too many requests",
  "message": "You have exceeded the rate limit. Please try again later.",
  "retryAfter": 900
}
```

### 3. Security Headers (Helmet)

Adds HTTP headers to protect against common web vulnerabilities (XSS, clickjacking, etc.).

```bash
HELMET_ENABLED=true                  # Enable/disable Helmet (default: true)
```

Headers set by Helmet:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`
- And more...

### 4. API Key Authentication

Optional authentication layer for API access.

```bash
API_KEY_ENABLED=false                # Enable/disable API key (default: false - opt-in)
API_KEY_HEADER=x-api-key             # Header name for the key (default: x-api-key)
STEPPER_API_KEY=your_secret_key      # The actual API key (REQUIRED if enabled)
API_KEY_SKIP_HEALTH=true             # Skip auth for /health, /metrics (default: true)
```

When enabled, all requests must include the API key:

```bash
curl -H "x-api-key: your_secret_key" http://localhost:3001/v1/reports
```

### 5. Proxy Configuration

If running behind a reverse proxy (nginx, ELB, Cloudflare):

```bash
TRUST_PROXY=1                        # 1=single proxy, true=any, or specific IPs
```

This ensures correct IP detection for rate limiting.

## Installation

```bash
cd packages/stepper
pnpm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key environment variables:

- `REDIS_URL`: Redis connection string (required)
- `HF_SPACE_ENABLED`: Enable Hugging Face Space provider
- `HF_SPACE_URL`: Your HF Space endpoint
- `GEMINI_ENABLED`, `COHERE_ENABLED`: Enable other providers
- `DISCORD_WEBHOOK_URL`: Optional alert webhook

## Usage

### As a library (in-process)

```typescript
import {
  enqueueReport,
  registerCallbacks,
  generateReport,
} from "@commitdiary/stepper";

// Register lifecycle callbacks
registerCallbacks({
  onSuccess: (jobId, provider, result, meta) => {
    console.log(`✅ Job ${jobId} succeeded using ${provider}`);
  },
  onFallback: (jobId, result, meta) => {
    console.warn(`⚠️ Job ${jobId} used fallback template`);
  },
  onFailure: (jobId, errors) => {
    console.error(`❌ Job ${jobId} failed:`, errors);
  },
});

// Enqueue async (non-blocking, returns immediately)
const result = await enqueueReport({
  userId: "user_123",
  commitSha: "abc123def456",
  repo: "myorg/myrepo",
  message: "Fix authentication bug",
  files: ["src/auth.ts", "src/middleware/auth.ts"],
  components: ["auth", "middleware"],
  diffSummary: "+ added token refresh logic\n- removed deprecated method",
});

if (result.status === 200) {
  // Cache hit - immediate response
  console.log("Cached report:", result.data);
} else {
  // Enqueued - poll for status
  console.log("Job ID:", result.jobId);
}

// Or generate immediately (blocking)
const immediate = await generateReport({
  userId: "user_123",
  commitSha: "abc123",
  repo: "myorg/myrepo",
  message: "Refactor API",
  files: ["src/api.ts"],
  components: ["api"],
  diffSummary: "- old implementation\n+ new implementation",
});

console.log("Provider used:", immediate.usedProvider);
console.log("Report:", immediate.result);
```

### As an HTTP service

Start the server:

```bash
pnpm dev       # Development with watch mode
pnpm build     # Build TypeScript
pnpm start     # Production
```

#### API Endpoints

**POST /v1/reports** - Enqueue report generation

```bash
curl -X POST http://localhost:3001/v1/reports \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_123",
    "commitSha": "abc123",
    "repo": "myorg/myrepo",
    "message": "Fix bug",
    "files": ["src/app.ts"],
    "components": ["app"],
    "diffSummary": "+ fixed validation"
  }'
```

Response (cached):

```json
{
  "status": "completed",
  "cached": true,
  "data": { "title": "...", "summary": "...", ... }
}
```

Response (enqueued):

```json
{
  "status": "queued",
  "jobId": "uuid-here",
  "statusUrl": "/v1/reports/uuid-here"
}
```

**GET /v1/reports/:jobId** - Get job status

```bash
curl http://localhost:3001/v1/reports/uuid-here
```

**GET /health** - Health check

```bash
curl http://localhost:3001/health
```

**GET /metrics** - Prometheus metrics

```bash
curl http://localhost:3001/metrics
```

## Provider Setup

### Hugging Face Space

1. Deploy your model to HF Space with a `/api/infer` endpoint:

```python
# app.py in HF Space
from fastapi import FastAPI
import json

app = FastAPI()

@app.post("/api/infer")
async def infer(request: dict):
    prompt = request["prompt"]
    # Your model inference here
    report = generate_report(prompt)
    return {"report": json.dumps(report)}
```

2. Configure stepper:

```bash
HF_SPACE_ENABLED=true
HF_SPACE_URL=https://your-username-your-space.hf.space
HF_SPACE_API_KEY=hf_your_key_here  # Optional
```

### Adding Custom Providers

Implement the `ProviderAdapter` interface:

```typescript
import { ProviderAdapter } from "./providers/provider.interface.js";
import { PromptInput, ReportOutput } from "./types.js";

export class MyCustomAdapter implements ProviderAdapter {
  readonly name = "my-provider";

  async call(input: PromptInput): Promise<ReportOutput> {
    // Call your provider API
    // Parse response
    // Validate with zod
    // Return ReportOutput
  }
}
```

Register in config.ts:

```typescript
{
  name: 'my-provider',
  enabled: process.env.MY_PROVIDER_ENABLED === 'true',
  baseUrl: process.env.MY_PROVIDER_URL,
  // ...
}
```

## Testing

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
```

Tests use mocked providers and ioredis-mock. No real API calls.

## Deployment

### Docker

```bash
pnpm docker:build
pnpm docker:run
```

Or:

```bash
docker build -t commitdiary-stepper .
docker run -p 3001:3001 --env-file .env commitdiary-stepper
```

### Railway / Render

1. Connect GitHub repo
2. Set environment variables from `.env.example`
3. Deploy

### GitHub Actions CI

CI runs automatically on push. See `.github/workflows/ci.yml`.

## Monitoring

### Prometheus Metrics

Exposed at `/metrics`:

- `ai_requests_total{provider, status}`
- `ai_request_duration_seconds{provider}`
- `cache_hits_total{status}`
- `cache_misses_total`
- `provider_failures_total{provider, reason}`
- `jobs_processed_total{status}`

### Grafana Dashboard

Import metrics into Grafana:

1. Add Prometheus data source pointing to stepper `/metrics`
2. Create panels for provider success rate, latency, cache hit ratio, queue size
3. Set up alerts for circuit breaker opens and error rates

### Discord Alerts

Set `DISCORD_WEBHOOK_URL` in `.env`. Critical errors and circuit breaker events will post to Discord.

## Integration with CommitDiary

### From `packages/api`

In-process import:

````typescript
import { enqueueReport, registerCallbacks } from '@commitdiary/stepper';

// In your commit webhook handler
const result = await enqueueReport({
  userId: req.user.id,
  commitSha: commit.sha,
  repo: commit.repo,
  message: commit.message,
  files: commit.files,
  components: extractComponents(commit),
  diffSummary: commit.diff,
});

if (result.status === 200) {
    // Send to Slack/Discord immediately
await sendToChannel(result.data);
} else {
// Worker will handle async and callback will notify
}

Register callbacks to send notifications:
```typescript
registerCallbacks({
  onSuccess: async (jobId, provider, result) => {
    await sendSlackMessage({
      text: `✅ Report generated for commit ${jobId}`,
      blocks: formatReport(result),
    });
  },
});
````

### As a separate service

Deploy stepper as its own service and call via HTTP:

```typescript
const response = await fetch("https://stepper.commitdiary.com/v1/reports", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId,
    commitSha,
    repo,
    message,
    files,
    components,
    diffSummary,
  }),
});

const data = await response.json();
```

## Architecture

![Stepper Architecture](./docs/assets/architecture.png)

Client Request
│
├─> Check Redis Cache
│ ├─> Fresh Hit → Return immediately
│ ├─> Stale Hit → Return + background refresh
│ └─> Miss → Enqueue job
│
└─> BullMQ Queue
│
└─> Worker picks job
│
└─> Orchestrator
├─> Try Provider 1 (Bottleneck + Circuit Breaker)
├─> Try Provider 2 (on failure)
├─> Try Provider 3 (on failure)
└─> Fallback Template (all failed)
│
└─> Store in Cache + Invoke Callbacks

## Troubleshooting

**Redis connection fails**:

- Check `REDIS_URL` is correct
- Ensure Redis is running: `redis-cli ping`

**Provider timeouts**:

- Increase `*_TIMEOUT` env vars
- Check provider API quotas and rate limits
- Review circuit breaker states: `GET /health`

**All providers fail**:

- Check API keys are set correctly
- Review logs for auth errors
- Ensure providers are enabled (`*_ENABLED=true`)

**Tests fail**:

- Ensure no Redis required (tests use ioredis-mock)
- Run `pnpm install` to get devDependencies

## License

MIT

## Contributing

1. Add tests for new features
2. Run `pnpm lint` before committing
3. Update README for API changes
