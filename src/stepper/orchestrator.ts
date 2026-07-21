import Bottleneck from 'bottleneck';
import CircuitBreaker from 'opossum';
import { ProviderAdapter, ProviderError, AuthError, RateLimitError } from '../providers/provider.interface.js';
import { createProviderAdapter } from '../providers/factory.js';
import { validateProviderConfig } from '../providers/registry.js';
import {
  PromptInput,
  ReportOutput,
  ProviderResult,
  ProviderAttemptMeta,
  StepperCallbackMetadata,
  StepperCallbackPayload,
  StepperCallbacks,
  ProviderConfig,
  ProviderErrorType,
  StepperRequest,
  StepperProviderResult,
} from '../types.js';
import { config } from '../config.js';
import { logger, createChildLogger } from '../logging.js';
import { generateCommitReportFallback } from '../presets/commit-report/fallback.js';
import {
  createCommitReportRequest,
  isCommitReportRequest,
  toCommitReportInput,
} from '../presets/commit-report/request.js';
import { generateGenericFallback } from '../fallback/templateFallback.js';
import { recordProviderAttempt, recordProviderSuccess, recordProviderFailure } from '../metrics/metrics.js';
import { isRetryableError } from '../utils/safeRequest.js';
import { alertProviderFailure, alertCircuitOpen } from '../alerts/discord.js';
import { deliverRequestCallbacks } from '../webhooks/requestCallbacks.js';

interface ProviderWithLimiter {
  adapter: ProviderAdapter;
  limiter: Bottleneck;
  circuit: CircuitBreaker;
  config: ProviderConfig;
  consecutiveErrors: number;
}

let providers: ProviderWithLimiter[] = [];
let callbacks: StepperCallbacks = {};

interface MetricsContext {
  preset: 'commit-report' | 'generic';
  responseMode: 'json' | 'text';
}

export class StepperProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepperProviderConfigurationError';
  }
}

/**
 * Thrown when every provider attempt in a chain fails due to rate limiting.
 * This allows queue workers to retry later instead of emitting fallback content
 * for purely transient capacity throttling.
 */
export class AllProvidersRateLimitedError extends Error {
  constructor(
    public retryAfterSeconds: number,
    public providers: string[]
  ) {
    super(`All providers are currently rate-limited. Retry after ${retryAfterSeconds} second(s).`);
    this.name = 'AllProvidersRateLimitedError';
  }
}

/**
 * Initialize providers with rate limiters and circuit breakers.
 */
export function initializeProviders(providerConfigs: ProviderConfig[] = config.providers): void {
  const enabledProviders = providerConfigs.filter((pc) => pc.enabled);
  const validProviders = enabledProviders.filter((pc) => {
    const validation = validateProviderConfig(pc);
    if (!validation.valid) {
      logger.warn({ provider: pc.name, reason: validation.reason }, 'Skipping unusable provider configuration');
      return false;
    }
    return true;
  });

  providers = validProviders
    .map((pc) => {
      const adapter = createProviderAdapter(pc);
      if (!adapter) {
        throw new Error(`Failed to create adapter for provider ${pc.name}`);
      }

      const minTime = pc.rateLimitRPS
        ? 1000 / pc.rateLimitRPS
        : 60000 / (pc.rateLimitRPM || 5);

      const limiter = new Bottleneck({
        maxConcurrent: pc.concurrency,
        minTime: Math.ceil(minTime),
      });

      // Keep circuit breaker transport-focused with request-first provider contracts.
      const circuit = new CircuitBreaker(
        async (request: StepperRequest<unknown, unknown>) => adapter.call(request),
        {
          timeout: pc.timeout || 15000,
          errorThresholdPercentage: 50,
          resetTimeout: config.circuit.cooldownSeconds * 1000,
          volumeThreshold: config.circuit.failureThreshold,
          rollingCountTimeout: config.circuit.windowSeconds * 1000,
        }
      );

      circuit.on('open', () => {
        logger.warn({ provider: pc.name }, 'Circuit breaker opened');
        void alertCircuitOpen(pc.name);
      });

      circuit.on('halfOpen', () => {
        logger.info({ provider: pc.name }, 'Circuit breaker half-open, trying probe');
      });

      circuit.on('close', () => {
        logger.info({ provider: pc.name }, 'Circuit breaker closed');
      });

      return { adapter, limiter, circuit, config: pc, consecutiveErrors: 0 };
    });

  if (providers.length === 0) {
    // TODO: needs review: if free/anonymous providers are introduced later,
    // update validateProviderConfig(...) so they can pass startup checks safely.
    throw new StepperProviderConfigurationError(
      `No usable providers configured. Enabled providers: ${enabledProviders.length}. ` +
      'Configure at least one valid provider with required credentials/base URL.'
    );
  }

  logger.info({ providerCount: providers.length, names: providers.map((p) => p.config.name) }, 'Providers initialized');
}

/**
 * Register lifecycle callbacks.
 */
export function registerCallbacks(cbs: StepperCallbacks): void {
  callbacks = { ...callbacks, ...cbs };
}

function getBackoffDelay(attempt: number): number {
  const base = config.retry.baseDelayMs;
  const jitter = Math.floor(Math.random() * config.retry.maxJitterMs);
  return base * Math.pow(2, attempt) + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequestMetricsContext(request: StepperRequest<unknown, unknown>): MetricsContext {
  const preset = isCommitReportRequest(request) ? 'commit-report' : 'generic';
  const responseMode = request.responseMode === 'text' ? 'text' : 'json';
  return { preset, responseMode };
}

function buildCallbackMetadata(
  request: StepperRequest<unknown, unknown>,
  jobId: string,
  extras: { provider?: string; generationTimeMs?: number } = {}
): StepperCallbackMetadata {
  const commitInput = toCommitReportInput(request);
  const metadata: StepperCallbackMetadata = {
    jobId,
    requestId: request.requestId,
    tenantId: request.tenantId,
    provider: extras.provider,
    generationTimeMs: extras.generationTimeMs,
    timestamp: new Date().toISOString(),
  };

  if (request.metadata) {
    // Keep user-provided metadata nested to avoid accidental key collisions.
    metadata.requestMetadata = request.metadata;
  }

  if (commitInput) {
    metadata.userId = commitInput.userId;
    metadata.commitSha = commitInput.commitSha;
    metadata.repo = commitInput.repo;
  }

  return metadata;
}

async function callWithRetries(
  provider: ProviderWithLimiter,
  request: StepperRequest<unknown, unknown>,
  jobId: string
): Promise<{ result: unknown; durationMs: number }> {
  const maxAttempts = config.retry.maxAttemptsPerProvider;
  const log = createChildLogger({ provider: provider.config.name, jobId });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startTime = Date.now();

    try {
      const result = await provider.circuit.fire(request) as unknown;
      const durationMs = Date.now() - startTime;

      log.debug({ attempt, durationMs }, 'Provider call succeeded');
      return { result, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.warn({ attempt, error: error instanceof Error ? error.message : String(error), durationMs }, 'Provider call failed');

      if (error instanceof AuthError) {
        log.error({ error: error.message }, 'Auth error - stopping retries');
        throw error;
      }

      if (error instanceof RateLimitError) {
        const retryAfter = error.retryAfter || config.retry.rateLimitFallbackSeconds;
        log.info(
          { retryAfterSeconds: retryAfter, attempt, strategy: config.retry.rateLimitStrategy },
          'Provider returned rate limit'
        );

        if (config.retry.rateLimitStrategy === 'wait' && attempt < maxAttempts - 1) {
          await sleep(retryAfter * 1000);
          continue;
        }

        throw new RateLimitError(error.message, retryAfter);
      }

      if (isRetryableError(error) && attempt < maxAttempts - 1) {
        const delay = getBackoffDelay(attempt);
        log.debug({ delay, attempt }, 'Retrying after backoff');
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw new Error('Max retries exceeded');
}

async function invokeCallback<T extends keyof StepperCallbacks>(
  name: T,
  ...args: Parameters<NonNullable<StepperCallbacks[T]>>
): Promise<void> {
  const callback = callbacks[name];
  if (!callback) {
    return;
  }

  try {
    await (callback as (...cbArgs: unknown[]) => void | Promise<void>)(...args);
  } catch (error) {
    logger.error({ callback: name, error }, 'Callback threw error');
  }
}

/**
 * Generate from the generic StepperRequest contract.
 */
export async function generateRequestNow<TOutput = unknown>(
  request: StepperRequest<unknown, TOutput>,
  jobId: string = 'immediate'
): Promise<StepperProviderResult<TOutput>> {
  const runtimeRequest = request as StepperRequest<unknown, unknown>;
  const commitInput = toCommitReportInput(runtimeRequest);
  const log = createChildLogger({
    jobId,
    requestId: request.requestId,
    tenantId: request.tenantId,
    userId: commitInput?.userId,
    commitSha: commitInput?.commitSha,
  });

  const startTime = Date.now();
  const providersAttempted: ProviderAttemptMeta[] = [];
  const metricsContext = getRequestMetricsContext(runtimeRequest);

  await invokeCallback('onStart', jobId, request);

  if (providers.length === 0) {
    initializeProviders();
  }

  for (const provider of providers) {
    const providerName = provider.config.name;

    if (provider.circuit.opened) {
      log.info({ provider: providerName }, 'Skipping provider - circuit open');
      providersAttempted.push({
        provider: providerName,
        attemptNumber: 0,
        skipped: 'circuit_open',
      });
      continue;
    }

    let attemptNumber = 0;

    try {
      attemptNumber++;
      log.info({ provider: providerName, attempt: attemptNumber }, 'Attempting provider');

      await invokeCallback('onProviderAttempt', jobId, providerName, attemptNumber, {
        provider: providerName,
        attemptNumber,
      });

      recordProviderAttempt(providerName, metricsContext);

      const { result, durationMs } = await provider.limiter.schedule(() =>
        callWithRetries(provider, runtimeRequest, jobId)
      );

      provider.consecutiveErrors = 0;
      const totalMs = Date.now() - startTime;
      log.info({ provider: providerName, totalMs, providerMs: durationMs }, 'Generation completed successfully');

      recordProviderSuccess(providerName, durationMs, metricsContext);
      providersAttempted.push({
        provider: providerName,
        attemptNumber,
        durationMs,
      });

      await invokeCallback('onSuccess', jobId, providerName, result, {
        timings: { totalMs, providerMs: durationMs },
      });

      if (request.callbacks && request.callbacks.length > 0) {
        const callbackPayload: StepperCallbackPayload<unknown> = {
          success: true,
          result,
              metadata: buildCallbackMetadata(
            runtimeRequest,
            jobId,
            { provider: providerName, generationTimeMs: totalMs }
          ),
        };

        deliverRequestCallbacks(request.callbacks, callbackPayload, { jobId })
          .then((callbackResults) => {
            log.info({ callbackResults: callbackResults.map((r) => ({ url: r.url, success: r.success })) }, 'Callbacks executed');
          })
          .catch((err: unknown) => {
            log.error({ error: err instanceof Error ? err.message : String(err) }, 'Callbacks execution error');
          });
      }

      return {
        result: result as TOutput,
        usedProvider: providerName,
        providersAttempted,
        fallback: false,
        timings: { totalMs, providerMs: durationMs },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof ProviderError ? error.type : 'UNKNOWN';
      const retryAfterSeconds = error instanceof RateLimitError
        ? error.retryAfter || config.retry.rateLimitFallbackSeconds
        : undefined;

      log.warn({ provider: providerName, error: errorMessage, errorCode }, 'Provider failed');

      provider.consecutiveErrors = (provider.consecutiveErrors || 0) + 1;

      recordProviderFailure(providerName, errorCode, metricsContext);
      providersAttempted.push({
        provider: providerName,
        attemptNumber,
        error: errorMessage,
        errorCode,
        retryAfterSeconds,
      });

      void alertProviderFailure(providerName, provider.consecutiveErrors, error);
      continue;
    }
  }

  const totalMs = Date.now() - startTime;
  log.error({ totalMs, providersAttempted: providersAttempted.length }, 'All providers failed, job will be retried');

  const failedAttempts = providersAttempted.filter((attempt) => !attempt.skipped);
  const allRateLimited =
    failedAttempts.length > 0 &&
    failedAttempts.every((attempt) => attempt.errorCode === ProviderErrorType.RateLimit);

  if (allRateLimited) {
    const retryAfterSeconds = Math.max(
      ...failedAttempts.map((attempt) => attempt.retryAfterSeconds || config.retry.rateLimitFallbackSeconds)
    );
    const rateLimitedProviders = failedAttempts.map((attempt) => attempt.provider);

    log.warn(
      { retryAfterSeconds, providers: rateLimitedProviders },
      'All providers rate-limited; returning retryable error instead of fallback output'
    );

    // TODO: verify: include retryAfterSeconds in queue-level metadata so
    // backoff can follow provider hints more precisely.
    await invokeCallback('onFailure', jobId, failedAttempts, {
      lastError: failedAttempts[failedAttempts.length - 1]?.error,
    });
    throw new AllProvidersRateLimitedError(retryAfterSeconds, rateLimitedProviders);
  }

  if (!config.fallback.enabled) {
    await invokeCallback('onFailure', jobId, failedAttempts, {
      lastError: failedAttempts[failedAttempts.length - 1]?.error,
    });
    throw new Error(`All ${providersAttempted.length} provider(s) failed. Job will retry.`);
  }

  const fallbackResult = commitInput
    ? generateCommitReportFallback(commitInput)
    : generateGenericFallback(request.responseMode || 'json');

  await invokeCallback('onFallback', jobId, fallbackResult, { providersAttempted });

  return {
    result: fallbackResult as TOutput,
    usedProvider: 'fallback',
    providersAttempted,
    fallback: true,
    timings: { totalMs },
  };
}

/**
 * Legacy compatibility wrapper for commit-report flow.
 */
export async function generateReportNow(input: PromptInput, jobId: string = 'immediate'): Promise<ProviderResult> {
  const request = createCommitReportRequest(input);
  const result = await generateRequestNow<ReportOutput>(request, jobId);
  return result as ProviderResult;
}

/**
 * Get provider health status.
 */
export function getProviderHealth(): Array<{ name: string; circuitOpen: boolean; healthy: boolean }> {
  return providers.map((p) => ({
    name: p.config.name,
    circuitOpen: p.circuit.opened,
    healthy: !p.circuit.opened,
  }));
}
