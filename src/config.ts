import { StepperConfig, ProviderConfig } from './types.js';

/**
 * Load configuration from environment variables with sensible defaults.
 * This is the central brain for all timing, retry, and safety-switch logic.
 */

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
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  // Provider configurations: Rules for how we talk to each AI
  const providers: ProviderConfig[] = [
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
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1',
      modelName: process.env.GEMINI_MODEL || 'gemini-pro',
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
      name: process.env.QUEUE_NAME || 'report-generation',
      // How many total background jobs we run across all providers
      concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5', 10),
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
          : ['*'], // Default allows all; in production, specify your domains
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
        enabled: process.env.API_KEY_ENABLED === 'true', // Disabled by default; opt-in
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

function mergeConfig(base: StepperConfig, overrides: Partial<StepperConfig>): StepperConfig {
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
  };
}

export function createConfig(overrides?: Partial<StepperConfig>): StepperConfig {
  const base = loadConfig();
  if (!overrides) {
    return base;
  }
  return mergeConfig(base, overrides);
}

export let config = loadConfig();

export function applyConfigOverrides(overrides?: Partial<StepperConfig>): StepperConfig {
  if (!overrides) {
    return config;
  }
  config = mergeConfig(loadConfig(), overrides);
  return config;
}