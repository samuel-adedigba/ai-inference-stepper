// types.ts - Stepper Type Definitions

/**
 * Input to generate a commit report
 */
export interface PromptInput {
  userId: string;
  commitSha: string;
  repo: string;
  message: string;
  files: string[];
  components: string[];
  diffSummary: string;
  template?: string;
}

/**
 * Structured report output from AI providers
 */
export interface ReportOutput {
  title: string;
  summary: string;
  changes: string[];
  rationale: string;
  impact_and_tests: string;
  next_steps: string[];
  tags: string;
}

/**
 * Provider attempt result
 */
export interface ProviderResult {
  result: ReportOutput;
  usedProvider: string;
  providersAttempted: ProviderAttemptMeta[];
  fallback: boolean;
  timings: {
    totalMs: number;
    providerMs?: number;
  };
}

/**
 * Metadata for each provider attempt
 */
export interface ProviderAttemptMeta {
  provider: string;
  attemptNumber: number;
  error?: string;
  errorCode?: string;
  durationMs?: number;
  skipped?: string;
}

/**
 * Cache entry structure
 */
export interface CacheEntry {
  status: 'hydrated' | 'dehydrated' | 'failed';
  result?: ReportOutput;
  jobId?: string;
  providersAttempted?: ProviderAttemptMeta[];
  timestamps: {
    created: string;
    updated: string;
  };
  ttl?: number;
  etag?: string;
  fallback?: boolean;
  error?: string;
}

/**
 * Job data for BullMQ
 */
export interface ReportJobData {
  jobId: string;
  input: PromptInput;
  cacheKey: string;
  priority?: number;
  callbackUrl?: string;
}

/**
 * Provider error types
 */
export enum ProviderErrorType {
  RateLimit = 'RATE_LIMIT',
  Auth = 'AUTH_ERROR',
  Timeout = 'TIMEOUT',
  Unavailable = 'UNAVAILABLE',
  InvalidResponse = 'INVALID_RESPONSE',
  Unknown = 'UNKNOWN',
}

/**
 * Lifecycle callbacks for stepper events
 */
export interface StepperCallbacks {
  onEnqueue?: (jobId: string, meta: { input: PromptInput; cacheKey: string }) => void | Promise<void>;
  onStart?: (jobId: string, input: PromptInput) => void | Promise<void>;
  onProviderAttempt?: (
    jobId: string,
    providerName: string,
    attemptNumber: number,
    meta: ProviderAttemptMeta
  ) => void | Promise<void>;
  onSuccess?: (
    jobId: string,
    providerName: string,
    result: ReportOutput,
    meta: { timings: { totalMs: number; providerMs?: number } }
  ) => void | Promise<void>;
  onFallback?: (
    jobId: string,
    result: ReportOutput,
    meta: { providersAttempted: ProviderAttemptMeta[] }
  ) => void | Promise<void>;
  onFailure?: (
    jobId: string,
    errors: ProviderAttemptMeta[],
    meta: { lastError?: string }
  ) => void | Promise<void>;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  name: string;
  enabled: boolean;
  baseUrl?: string;
  modelName?: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
  rateLimitRPM?: number; // Requests Per Minute
  rateLimitRPS?: number; // Requests Per Second
  concurrency: number;
  timeout?: number;
}

/**
 * Stepper configuration
 */
export interface StepperConfig {
  providers: ProviderConfig[];
  providerConfigs?: ProviderConfig[];
  redis: {
    url: string;
    keyPrefix: string;
  };
  cache: {
    ttlSeconds: number;
    staleThresholdSeconds: number;
    enableStaleWhileRevalidate: boolean;
  };
  queue: {
    name: string;
    concurrency: number;
  };
  retry: {
    maxAttemptsPerProvider: number;
    baseDelayMs: number;
    maxJitterMs: number;
    rateLimitFallbackSeconds: number;
  };
  circuit: {
    failureThreshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
  };
  security: {
    redactBeforeSend: boolean;
    // CORS configuration
    cors: {
      enabled: boolean;
      allowedOrigins: string[];
      allowCredentials: boolean;
    };
    // Rate limiting configuration
    rateLimit: {
      enabled: boolean;
      windowMs: number; // Time window in milliseconds
      maxRequests: number; // Max requests per window per IP
      maxRequestsPerUser: number; // Max requests per window per userId
      skipHealthEndpoints: boolean; // Skip rate limiting for /health and /metrics
    };
    // Helmet security headers
    helmet: {
      enabled: boolean;
    };
    // API Key authentication
    apiKey: {
      enabled: boolean;
      headerName: string; // e.g., 'x-api-key'
      skipHealthEndpoints: boolean; // Skip auth for /health and /metrics
    };
  };
  server: {
    port: number;
    metricsPort?: number;
  };
}