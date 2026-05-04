// types.ts - Stepper Type Definitions

import type { ZodType } from 'zod';

/**
 * Generic webhook callback configuration
 * Stepper sends raw results to these URLs - callers handle transformation
 */
export interface WebhookCallback {
  /** Callback URL to send results */
  url: string;
  /** Custom headers (auth tokens, content-type, etc.) */
  headers?: Record<string, string>;
  /** Continue to next callback even if this one fails */
  continueOnFailure?: boolean;
  /** Retry configuration */
  retry?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

/**
 * Generic response mode for non-preset Stepper requests.
 */
export type StepperResponseMode = 'json' | 'text';

/**
 * Generic prompt builder input.
 *
 * Phase 1 note:
 * - `preset` enables callers to identify a reusable package preset (for example `commit-report`).
 * - core prompt rendering remains provider-specific for now and will be generalized in a later phase.
 */
export interface PromptBuilderInput<TPayload = unknown> {
  preset?: string;
  template?: string;
  instructions?: string;
  payload?: TPayload;
  variables?: Record<string, unknown>;
}

/**
 * Generic prompt contract accepted by Stepper.
 */
export type StepperPrompt<TPayload = unknown> =
  | string
  | PromptBuilderInput<TPayload>;

/**
 * Optional output schema contract for generic callers.
 */
export type StepperOutputSchema<TOutput = unknown> =
  | {
    kind: 'zod';
    schema: ZodType<TOutput>;
  }
  | {
    kind: 'custom';
    parse: (value: unknown) => TOutput;
  };

/**
 * Generic output parser signature used by runtime validation modules.
 */
export type OutputParser<TOutput = unknown> = (
  rawOutput: string,
  schema?: StepperOutputSchema<TOutput>
) => {
  valid: boolean;
  result?: TOutput;
  error?: string;
};

/**
 * Generic request shape for Stepper orchestration.
 */
export interface StepperRequest<TPayload = unknown, TOutput = unknown> {
  tenantId?: string;
  requestId?: string;
  cacheKey?: string;
  prompt: StepperPrompt<TPayload>;
  payload?: TPayload;
  outputSchema?: StepperOutputSchema<TOutput>;
  responseMode?: StepperResponseMode;
  providers?: ProviderConfig[];
  callbacks?: WebhookCallback[];
  metadata?: Record<string, unknown>;
}

/**
 * Input to generate a commit report (legacy/public compatibility contract).
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
  callbackUrl?: string;

  /**
   * Multiple webhook callbacks for resilience
   * Stepper will call each in order, sending the raw result
   * Use continueOnFailure: true to ensure all callbacks are attempted
   */
  callbacks?: WebhookCallback[];
}

/**
 * Alias used by the new preset-based API.
 */
export type CommitReportInput = PromptInput;

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
 * Alias used by the new preset-based API.
 */
export type CommitReportOutput = ReportOutput;

/**
 * Generic provider attempt result.
 */
export interface StepperProviderResult<TOutput = unknown> {
  result: TOutput;
  usedProvider: string;
  providersAttempted: ProviderAttemptMeta[];
  fallback: boolean;
  timings: {
    totalMs: number;
    providerMs?: number;
  };
}

/**
 * Provider attempt result (legacy/public compatibility contract).
 */
export type ProviderResult = StepperProviderResult<ReportOutput>;

/**
 * Metadata for each provider attempt
 */
export interface ProviderAttemptMeta {
  provider: string;
  attemptNumber: number;
  error?: string;
  errorCode?: string;
  durationMs?: number;
  /**
   * Retry hint in seconds when provider responded with a rate limit signal.
   * This is recorded for observability and for queue-level retry decisions.
   */
  retryAfterSeconds?: number;
  skipped?: string;
}

/**
 * Cache entry structure
 */
export interface CacheEntry {
  status: 'hydrated' | 'dehydrated' | 'failed';
  /**
   * Generic cached result payload.
   *
   * CommitDiary compatibility:
   * - legacy report endpoints still read/write ReportOutput here.
   * - generic requests can now persist non-report outputs without schema mismatch.
   */
  result?: unknown;
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
 * Generic job data for queue payloads.
 */
export interface StepperJobData<TPayload = unknown, TOutput = unknown> {
  jobId: string;
  request: StepperRequest<TPayload, TOutput>;
  cacheKey: string;
  priority?: number;
  callbackUrl?: string;
}

/**
 * Job data for BullMQ (legacy/public compatibility contract).
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
  onEnqueue?: (jobId: string, meta: { input: PromptInput | StepperRequest<unknown, unknown>; cacheKey: string }) => void | Promise<void>;
  onStart?: (jobId: string, input: PromptInput | StepperRequest<unknown, unknown>) => void | Promise<void>;
  onProviderAttempt?: (
    jobId: string,
    providerName: string,
    attemptNumber: number,
    meta: ProviderAttemptMeta
  ) => void | Promise<void>;
  onSuccess?: (
    jobId: string,
    providerName: string,
    result: unknown,
    meta: { timings: { totalMs: number; providerMs?: number } }
  ) => void | Promise<void>;
  onFallback?: (
    jobId: string,
    result: unknown,
    meta: { providersAttempted: ProviderAttemptMeta[] }
  ) => void | Promise<void>;
  onFailure?: (
    jobId: string,
    errors: ProviderAttemptMeta[],
    meta: { lastError?: string }
  ) => void | Promise<void>;
}

/**
 * Standard callback metadata shape sent to webhook callback consumers.
 *
 * CommitDiary compatibility:
 * - commit fields remain optional and are included only for commit-report preset requests.
 */
export interface StepperCallbackMetadata {
  jobId: string;
  requestId?: string;
  tenantId?: string;
  provider?: string;
  generationTimeMs?: number;
  timestamp: string;
  requestMetadata?: Record<string, unknown>;
  userId?: string;
  commitSha?: string;
  repo?: string;
}

/**
 * Standard callback payload contract for success/failure delivery.
 */
export interface StepperCallbackPayload<TOutput = unknown> {
  success: boolean;
  result?: TOutput;
  error?: string;
  metadata: StepperCallbackMetadata;
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
 * Runtime provider config alias used by generic request contracts.
 */
export type ProviderRuntimeConfig = ProviderConfig;

/**
 * Stepper configuration
 */
export interface StepperConfig {
  providers: ProviderConfig[];
  providerConfigs?: ProviderConfig[];
  fallback: {
    enabled: boolean;
  };
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
  webhook: {
    enabled: boolean;
    secret: string;
    maxRetries: number;
    retryDelayMs: number;
  };
  retry: {
    maxAttemptsPerProvider: number;
    baseDelayMs: number;
    maxJitterMs: number;
    rateLimitFallbackSeconds: number;
    /**
     * fallback: fail the current rate-limited provider immediately and continue
     * to the next provider. wait: respect provider retry-after inline.
     */
    rateLimitStrategy: 'fallback' | 'wait';
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
