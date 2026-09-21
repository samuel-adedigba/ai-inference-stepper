import { StepperConfig, StepperConfigOverrides, ProviderConfig } from './types.js';

/**
 * Load configuration from environment variables with sensible defaults.
 * This is the central brain for all timing, retry, and safety-switch logic.
 */

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function allowsInsecureLocalRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === 'test'
    || (environment.NODE_ENV === 'development' && environment.ALLOW_INSECURE_DEV === 'true');
}

/**
 * Load provider configurations from environment
 */
function loadProviderConfigs(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // Helper to add provider config
  const addProvider = (name: string, envPrefix: string) => {
    const enabled = process.env[`${envPrefix}_ENABLED`] === 'true';
    if (enabled) {
      providers.push({
        name,
        apiKey: process.env[`${envPrefix}_API_KEY`],
        baseUrl: process.env[`${envPrefix}_BASE_URL`],
        modelName: process.env[`${envPrefix}_MODEL`],
        timeout: parseInt(process.env[`${envPrefix}_TIMEOUT`] || '15000', 10),
        rateLimitRPS: parseInt(process.env[`${envPrefix}_RPS`] || '5', 10),
        concurrency: parseInt(process.env[`${envPrefix}_CONCURRENCY`] || '2', 10),
        enabled: true,
      });
    }
  };

  // Special case: HuggingFace Space
  if (process.env.HF_SPACE_ENABLED === 'true') {
    providers.push({
      name: 'hf-space',
      baseUrl: process.env.HF_SPACE_URL,
      apiKey: process.env.HF_SPACE_API_KEY,
      timeout: parseInt(process.env.HF_SPACE_TIMEOUT || '30000', 10),
      rateLimitRPS: parseInt(process.env.HF_SPACE_RPS || '3', 10),
      concurrency: parseInt(process.env.HF_SPACE_CONCURRENCY || '1', 10),
      enabled: true,
    });
  }

  // Add all other providers
  addProvider('gemini', 'GEMINI');
  addProvider('openai', 'OPENAI');
  addProvider('anthropic', 'ANTHROPIC');
  addProvider('cohere', 'COHERE');
  addProvider('deepseek', 'DEEPSEEK');
  addProvider('groq', 'GROQ');
  addProvider('openrouter', 'OPENROUTER');
  addProvider('mistral', 'MISTRAL');
  addProvider('perplexity', 'PERPLEXITY');
  addProvider('together', 'TOGETHER');

  return providers;
}
export function loadConfig(): StepperConfig {
  const allowInsecureLocalRuntime = allowsInsecureLocalRuntime();
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const queueName = process.env.QUEUE_NAME || 'report-generation';
  const batchQueueName = process.env.BATCH_QUEUE_NAME || 'inference-batch-generation';

  if (queueName === batchQueueName) {
    throw new Error('QUEUE_NAME and BATCH_QUEUE_NAME must be different to preserve single/batch isolation');
  }

  // Provider configurations: Rules for how we talk to each AI
  const providers: ProviderConfig[] = [
    {
      name: 'nvidia-llama',
      enabled: process.env.NVIDIA_LLAMA_ENABLED === 'true',
      baseUrl: process.env.NVIDIA_LLAMA_BASE_URL || process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      modelName: process.env.NVIDIA_LLAMA_MODEL || 'meta/llama-3.3-70b-instruct',
      apiKeyEnvVar: 'NVIDIA_API_KEY',
      rateLimitRPM: parseInt(process.env.NVIDIA_LLAMA_RPM || process.env.NVIDIA_RPM || '5', 10),
      concurrency: parseInt(process.env.NVIDIA_LLAMA_CONCURRENCY || process.env.NVIDIA_CONCURRENCY || '2', 10),
      timeout: parseInt(process.env.NVIDIA_LLAMA_TIMEOUT || process.env.NVIDIA_TIMEOUT || '30000', 10),
    },
    {
      name: 'nvidia-dracarys',
      enabled: process.env.NVIDIA_DRACARYS_ENABLED === 'true',
      baseUrl: process.env.NVIDIA_DRACARYS_BASE_URL || process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      modelName: process.env.NVIDIA_DRACARYS_MODEL || 'abacusai/dracarys-llama-3.1-70b-instruct',
      apiKeyEnvVar: 'NVIDIA_API_KEY',
      rateLimitRPM: parseInt(process.env.NVIDIA_DRACARYS_RPM || process.env.NVIDIA_RPM || '5', 10),
      concurrency: parseInt(process.env.NVIDIA_DRACARYS_CONCURRENCY || process.env.NVIDIA_CONCURRENCY || '2', 10),
      timeout: parseInt(process.env.NVIDIA_DRACARYS_TIMEOUT || process.env.NVIDIA_TIMEOUT || '30000', 10),
    },
    {
      name: 'nvidia',
      // Preserve the legacy single-model setting only when the explicit model
      // lanes are not configured, preventing an unintended third NVIDIA lane.
      enabled: process.env.NVIDIA_ENABLED === 'true'
        && process.env.NVIDIA_LLAMA_ENABLED !== 'true'
        && process.env.NVIDIA_DRACARYS_ENABLED !== 'true',
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      modelName: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
      apiKeyEnvVar: 'NVIDIA_API_KEY',
      rateLimitRPM: parseInt(process.env.NVIDIA_RPM || '5', 10),
      concurrency: parseInt(process.env.NVIDIA_CONCURRENCY || '2', 10),
      timeout: parseInt(process.env.NVIDIA_TIMEOUT || '30000', 10),
    },
    {
      name: 'hf-space',
      enabled: process.env.HF_SPACE_ENABLED === 'true',
      baseUrl: process.env.HF_SPACE_URL || 'https://your-space.hf.space',
      apiKeyEnvVar: 'HF_SPACE_API_KEY',
      // RPM (Requests Per Minute): We allow 5 requests every 60 seconds (one every 12 seconds)
      // high RPM leads to "429 Too Many Requests" errors.
      rateLimitRPM: parseInt(process.env.HF_SPACE_RPM || '5', 10),
      // Concurrency: Max 2 active conversations at once. Prevents overloading the AI slot.
      concurrency: parseInt(process.env.HF_SPACE_CONCURRENCY || '2', 10),
      // Timeout: Give the AI 1 minute to think before we give up and try another provider.
      timeout: parseInt(process.env.HF_SPACE_TIMEOUT || '60000', 10),
    },
    {
      name: 'gemini',
      enabled: process.env.GEMINI_ENABLED === 'true',
      // The catalog endpoint already includes /v1beta; keep the base URL unversioned.
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      apiKeyEnvVar: 'GEMINI_API_KEY',
      rateLimitRPM: parseInt(process.env.GEMINI_RPM || '5', 10),
      concurrency: parseInt(process.env.GEMINI_CONCURRENCY || '2', 10),
      timeout: parseInt(process.env.GEMINI_TIMEOUT || '60000', 10),
    },
    {
      name: 'cohere',
      enabled: process.env.COHERE_ENABLED === 'true',
      baseUrl: process.env.COHERE_BASE_URL || 'https://api.cohere.ai/v1',
      modelName: process.env.COHERE_MODEL || 'command',
      apiKeyEnvVar: 'COHERE_API_KEY',
      rateLimitRPM: parseInt(process.env.COHERE_RPM || '5', 10),
      concurrency: parseInt(process.env.COHERE_CONCURRENCY || '2', 10),
      timeout: parseInt(process.env.COHERE_TIMEOUT || '60000', 10),
    },
  ];

  // Filter enabled providers and enforce order
  const staticProviders = providers.filter((p) => p.enabled);
  const dynamicProviders = loadProviderConfigs();

  // Combine, preferring static if name conflicts
  const allProviders = [...staticProviders];
  for (const dp of dynamicProviders) {
    if (!allProviders.some(sp => sp.name === dp.name)) {
      allProviders.push(dp);
    }
  }

  return {
    providers: allProviders,
    fallback: {
      enabled: process.env.FALLBACK_ENABLED !== 'false',
    },
    redis: {
      url: redisUrl,
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'stepper:',
    },
    cache: {
      // TTL: How long the report stays in the database (Default: 2 days)
      ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '172800', 10),
      // Stale Threshold: After 24 hours (or effectively never if TTL < 24h), we consider the data "old"
      staleThresholdSeconds: parseInt(process.env.CACHE_STALE_THRESHOLD || '86400', 10),
      enableStaleWhileRevalidate: process.env.CACHE_STALE_WHILE_REVALIDATE !== 'false',
    },
    queue: {
      name: queueName,
      // How many total background jobs we run across all providers
      concurrency: positiveInteger(process.env.QUEUE_CONCURRENCY, 5),
    },
    batch: {
      queueName: batchQueueName,
      queueConcurrency: positiveInteger(process.env.BATCH_QUEUE_CONCURRENCY, 2),
      maxItems: positiveInteger(process.env.BATCH_MAX_ITEMS, 100),
      maxConcurrency: positiveInteger(process.env.BATCH_MAX_CONCURRENCY, 5),
    },
    webhook: {
      enabled: process.env.WEBHOOK_ENABLED !== 'false', // Enabled by default
      secret: process.env.WEBHOOK_SECRET || '',
      maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
      retryDelayMs: parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || '5000', 10),
    },
    retry: {
      // Max Attempts: Try a single provider 3 times before moving to the next one.
      maxAttemptsPerProvider: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
      // Base Delay: After a simple error (like network), wait 40 seconds before retrying.
      baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '40000', 10),
      // Jitter: Random +/- 10 seconds to prevent multiple retries hitting at once.
      maxJitterMs: parseInt(process.env.RETRY_MAX_JITTER_MS || '10000', 10),
      // Rate Limit Fallback: If AI says "Busy" but doesn't say for how long, wait ~2 hours (extreme safety).
      // Note: User set this to 5400 in .env which is ~90mins.
      rateLimitFallbackSeconds: parseInt(process.env.RETRY_RATE_LIMIT_FALLBACK || '7200', 10),
      // fallback (default): do not block provider chain on a single provider rate limit.
      // wait: preserve legacy inline wait behavior on rate limits.
      rateLimitStrategy: process.env.RETRY_RATE_LIMIT_STRATEGY === 'wait' ? 'wait' : 'fallback',
    },
    circuit: {
      // Failure Threshold: Kill the provider if 5 requests in a row fail.
      failureThreshold: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD || '5', 10),
      // Window: Only look at failures from the last 5 minutes.
      windowSeconds: parseInt(process.env.CIRCUIT_WINDOW_SECONDS || '300', 10),
      // Cooldown: After killing a provider, wait 5 minutes before trying it again.
      cooldownSeconds: parseInt(process.env.CIRCUIT_COOLDOWN_SECONDS || '300', 10),
    },
    security: {
      redactBeforeSend: process.env.REDACT_BEFORE_SEND !== 'false',
      // CORS: Control which domains can access your API
      cors: {
        enabled: process.env.CORS_ENABLED !== 'false', // Enabled by default
        allowedOrigins: process.env.CORS_ALLOWED_ORIGINS
          ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim())
          : allowInsecureLocalRuntime ? ['*'] : [],
        allowCredentials: process.env.CORS_ALLOW_CREDENTIALS === 'true',
      },
      // Rate Limiting: Prevent abuse and DDoS
      rateLimit: {
        enabled: process.env.RATE_LIMIT_ENABLED !== 'false', // Enabled by default
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes default
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10), // 100 per window per IP
        maxRequestsPerUser: parseInt(process.env.RATE_LIMIT_MAX_PER_USER || '50', 10), // 50 per window per userId
        skipHealthEndpoints: process.env.RATE_LIMIT_SKIP_HEALTH !== 'false', // Skip /health & /metrics by default
      },
      // Helmet: Security headers (XSS, clickjacking, etc.)
      helmet: {
        enabled: process.env.HELMET_ENABLED !== 'false', // Enabled by default
      },
      // API Key: Simple authentication for API access
      apiKey: {
        // Production must fail closed if the deployment forgets the opt-in flag.
        enabled: !allowInsecureLocalRuntime || process.env.API_KEY_ENABLED === 'true',
        headerName: process.env.API_KEY_HEADER || 'x-api-key',
        skipHealthEndpoints: process.env.API_KEY_SKIP_HEALTH !== 'false', // Skip auth for health/metrics
      },
    },
    server: {
      port: parseInt(process.env.PORT || '3001', 10),
      metricsPort: process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT, 10) : undefined,
    },
  };
}

/** Fail before listening when production cannot authenticate or deliver jobs. */
export function assertProductionConfig(config: StepperConfig): void {
  if (allowsInsecureLocalRuntime()) return;
  const required = ['STEPPER_API_KEY', 'REDIS_URL'];
  if (config.webhook.enabled) required.push('WEBHOOK_SECRET');
  const missing = required.filter((name) => !String(process.env[name] || '').trim());
  if (config.security.cors.enabled && config.security.cors.allowedOrigins.includes('*')) {
    throw new Error('CORS_ALLOWED_ORIGINS must be explicit unless ALLOW_INSECURE_DEV=true in development');
  }
  for (const provider of config.providers.filter((item) => item.enabled)) {
    if (provider.apiKeyEnvVar && !String(process.env[provider.apiKeyEnvVar] || '').trim()) {
      missing.push(provider.apiKeyEnvVar);
    }
  }
  if (missing.length) throw new Error(`Missing required production configuration: ${[...new Set(missing)].join(', ')}`);
}

/** Reject unsafe numeric overrides before they reach queues, retries, or providers. */
export function assertRuntimeConfig(config: StepperConfig): void {
  const isBoundedInteger = (value: unknown, min: number, max: number): boolean =>
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

  if (!isBoundedInteger(config.queue.concurrency, 1, 100)
    || !isBoundedInteger(config.batch.queueConcurrency, 1, 100)
    || !isBoundedInteger(config.batch.maxItems, 1, 1000)
    || !isBoundedInteger(config.batch.maxConcurrency, 1, 100)
    || !isBoundedInteger(config.webhook.maxRetries, 1, 5)
    || !isBoundedInteger(config.webhook.retryDelayMs, 0, 60_000)
    || !isBoundedInteger(config.retry.maxAttemptsPerProvider, 1, 10)
    || !isBoundedInteger(config.retry.baseDelayMs, 0, 600_000)
    || !isBoundedInteger(config.retry.maxJitterMs, 0, 600_000)
    || !isBoundedInteger(config.retry.rateLimitFallbackSeconds, 1, 86_400)
    || !isBoundedInteger(config.security.rateLimit.windowMs, 1_000, 86_400_000)
    || !isBoundedInteger(config.security.rateLimit.maxRequests, 1, 1_000_000)
    || !isBoundedInteger(config.security.rateLimit.maxRequestsPerUser, 1, 1_000_000)) {
    throw new Error('Invalid Stepper runtime limits; refusing to start');
  }

  let redisProtocol = '';
  try {
    redisProtocol = new URL(config.redis.url).protocol;
  } catch {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL');
  }
  if (!['redis:', 'rediss:'].includes(redisProtocol)
    || (process.env.NODE_ENV === 'production'
      && redisProtocol !== 'rediss:'
      && process.env.REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK !== 'true')) {
    throw new Error(
      'Redis TLS is required in production unless REDIS_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true is explicitly set'
    );
  }
  if (config.security.cors.allowCredentials && config.security.cors.allowedOrigins.includes('*')) {
    throw new Error('Credentialed CORS cannot use a wildcard origin');
  }

  for (const provider of config.providers.filter((item) => item.enabled)) {
    if (!isBoundedInteger(provider.concurrency, 1, 100)
      || !isBoundedInteger(provider.timeout, 100, 300_000)
      || !isBoundedInteger(provider.rateLimitRPM ?? provider.rateLimitRPS, 1, 1_000_000)) {
      throw new Error(`Invalid runtime limits for provider '${provider.name}'`);
    }
  }
}

function mergeConfig(base: StepperConfig, overrides: StepperConfigOverrides<StepperConfig>): StepperConfig {
  // `base` supplies every nested default; the assertion keeps the public
  // deep-partial override type ergonomic without weakening the runtime shape.
  return {
    ...base,
    ...overrides,
    providers: overrides.providers ?? base.providers,
    providerConfigs: overrides.providerConfigs ?? base.providerConfigs,
    redis: {
      ...base.redis,
      ...overrides.redis,
    },
    cache: {
      ...base.cache,
      ...overrides.cache,
    },
    queue: {
      ...base.queue,
      ...overrides.queue,
    },
    batch: {
      ...base.batch,
      ...overrides.batch,
    },
    webhook: {
      ...base.webhook,
      ...overrides.webhook,
    },
    retry: {
      ...base.retry,
      ...overrides.retry,
    },
    circuit: {
      ...base.circuit,
      ...overrides.circuit,
    },
    security: {
      ...base.security,
      ...overrides.security,
      cors: {
        ...base.security.cors,
        ...overrides.security?.cors,
      },
      rateLimit: {
        ...base.security.rateLimit,
        ...overrides.security?.rateLimit,
      },
      helmet: {
        ...base.security.helmet,
        ...overrides.security?.helmet,
      },
      apiKey: {
        ...base.security.apiKey,
        ...overrides.security?.apiKey,
      },
    },
    server: {
      ...base.server,
      ...overrides.server,
    },
  } as StepperConfig;
}

export function createConfig(overrides?: StepperConfigOverrides<StepperConfig>): StepperConfig {
  const base = loadConfig();
  if (!overrides) {
    return base;
  }
  return mergeConfig(base, overrides);
}

export let config = loadConfig();

export function applyConfigOverrides(overrides?: StepperConfigOverrides<StepperConfig>): StepperConfig {
  if (!overrides) {
    return config;
  }
  config = mergeConfig(loadConfig(), overrides);
  return config;
}
