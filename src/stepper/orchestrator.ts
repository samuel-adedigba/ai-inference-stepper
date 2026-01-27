
//packages/stepper/src/stepper/orchestrator.ts`

import Bottleneck from 'bottleneck';
import CircuitBreaker from 'opossum';
import { ProviderAdapter, ProviderError, AuthError, RateLimitError } from '../providers/provider.interface.js';
import { createProviderAdapter } from '../providers/factory.js';
import { PromptInput, ReportOutput, ProviderResult, ProviderAttemptMeta, StepperCallbacks, ProviderConfig } from '../types.js';
import { config } from '../config.js';
import { logger, createChildLogger } from '../logging.js';
import { generateTemplateFallback } from '../fallback/templateFallback.js';
import { recordProviderAttempt, recordProviderSuccess, recordProviderFailure } from '../metrics/metrics.js';
import { isRetryableError } from '../utils/safeRequest.js';
import { alertProviderFailure, alertCircuitOpen } from '../alerts/discord.js';

interface ProviderWithLimiter {
  adapter: ProviderAdapter;
  limiter: Bottleneck;
  circuit: CircuitBreaker;
  config: ProviderConfig;
  consecutiveErrors: number;
}

let providers: ProviderWithLimiter[] = [];
let callbacks: StepperCallbacks = {};

/**
 * Initialize providers with rate limiters and circuit breakers
 */
export function initializeProviders(providerConfigs: ProviderConfig[] = config.providers): void {
  providers = providerConfigs
    .filter((pc) => pc.enabled)
    .map((pc) => {
      // Create adapter using factory
      const adapter = createProviderAdapter(pc);
      if (!adapter) {
        throw new Error(`Failed to create adapter for provider ${pc.name}`);
      }

      // Create Bottleneck limiter
      // Convert RPM (Requests Per Minute) to ms between requests
      // Example: 5 RPM = 60000ms / 5 = 12000ms (12 seconds) between each request
      // const minTime = 60000 / pc.rateLimitRPM;

      // Convert RPM (Requests Per Minute) or RPS (Requests Per Second) to ms between requests
      const minTime = pc.rateLimitRPS
        ? 1000 / pc.rateLimitRPS
        : 60000 / (pc.rateLimitRPM || 5);

      const limiter = new Bottleneck({
        maxConcurrent: pc.concurrency,
        minTime: Math.ceil(minTime),
      });

      // Create circuit breaker
      const circuit = new CircuitBreaker(async (input: PromptInput) => adapter.call(input), {
        timeout: pc.timeout || 15000,
        errorThresholdPercentage: 50,
        resetTimeout: config.circuit.cooldownSeconds * 1000,
        volumeThreshold: config.circuit.failureThreshold,
        rollingCountTimeout: config.circuit.windowSeconds * 1000,
      });

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

  logger.info({ providerCount: providers.length, names: providers.map((p) => p.config.name) }, 'Providers initialized');
}

/**
 * Register lifecycle callbacks
 */
export function registerCallbacks(cbs: StepperCallbacks): void {
  callbacks = { ...callbacks, ...cbs };
}

/**
 * Get backoff delay with jitter
 */
function getBackoffDelay(attempt: number): number {
  const base = config.retry.baseDelayMs;
  const jitter = Math.floor(Math.random() * config.retry.maxJitterMs);
  return base * Math.pow(2, attempt) + jitter;
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call provider with retries
 */
async function callWithRetries(
  provider: ProviderWithLimiter,
  input: PromptInput,
  jobId: string
): Promise<{ result: ReportOutput; durationMs: number }> {
  const maxAttempts = config.retry.maxAttemptsPerProvider;
  const log = createChildLogger({ provider: provider.config.name, jobId });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startTime = Date.now();

    try {
      // Use circuit breaker - the result type from Opossum is unknown, but we know
      // it returns ReportOutput since the circuit wraps adapter.call(input)
      const result = await provider.circuit.fire(input) as ReportOutput;
      const durationMs = Date.now() - startTime;

      log.debug({ attempt, durationMs }, 'Provider call succeeded');
      return { result, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.warn({ attempt, error: error instanceof Error ? error.message : String(error), durationMs }, 'Provider call failed');

      // Don't retry auth errors
      if (error instanceof AuthError) {
        log.error({ error: error.message }, 'Auth error - stopping retries');
        throw error;
      }

      // Handle rate limits with Retry-After
      if (error instanceof RateLimitError) {
        // Use the AI service's requested wait time, or fallback to config (90 minutes default)
        const retryAfter = error.retryAfter || config.retry.rateLimitFallbackSeconds;
        log.info({ retryAfterSeconds: retryAfter, attempt }, 'Rate limited, backing off');

        if (attempt < maxAttempts - 1) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw error;
      }

      // Retry on retryable errors
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

/**
 * Safe callback invocation
 */
async function invokeCallback<T extends keyof StepperCallbacks>(
  name: T,
  ...args: Parameters<NonNullable<StepperCallbacks[T]>>
): Promise<void> {
  const callback = callbacks[name];
  if (!callback) return;

  try {
    await (callback as (...args: unknown[]) => void | Promise<void>)(...args);
  } catch (error) {
    logger.error({ callback: name, error }, 'Callback threw error');
  }
}

/**
 * Generate report using provider orchestration
 */
export async function generateReportNow(input: PromptInput, jobId: string = 'immediate'): Promise<ProviderResult> {
  const log = createChildLogger({ jobId, userId: input.userId, commitSha: input.commitSha });
  const startTime = Date.now();
  const providersAttempted: ProviderAttemptMeta[] = [];

  await invokeCallback('onStart', jobId, input);

  // Ensure providers are initialized
  if (providers.length === 0) {
    initializeProviders();
  }

  // Try each provider in order
  for (const provider of providers) {
    const providerName = provider.config.name;

    // Check circuit breaker state
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

      recordProviderAttempt(providerName);

      // Schedule with rate limiter and call with retries
      const { result, durationMs } = await provider.limiter.schedule(() =>
        callWithRetries(provider, input, jobId)
      );

      // Success!
      provider.consecutiveErrors = 0;
      const totalMs = Date.now() - startTime;
      log.info({ provider: providerName, totalMs, providerMs: durationMs }, 'Report generated successfully');

      recordProviderSuccess(providerName, durationMs);
      providersAttempted.push({
        provider: providerName,
        attemptNumber,
        durationMs,
      });

      await invokeCallback('onSuccess', jobId, providerName, result, {
        timings: { totalMs, providerMs: durationMs },
      });

      return {
        result,
        usedProvider: providerName,
        providersAttempted,
        fallback: false,
        timings: { totalMs, providerMs: durationMs },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof ProviderError ? error.type : 'UNKNOWN';

      log.warn({ provider: providerName, error: errorMessage, errorCode }, 'Provider failed');

      // Update consecutive errors
      provider.consecutiveErrors = (provider.consecutiveErrors || 0) + 1;

      recordProviderFailure(providerName, errorCode);
      providersAttempted.push({
        provider: providerName,
        attemptNumber,
        error: errorMessage,
        errorCode,
      });

      // Alert on failure
      void alertProviderFailure(providerName, provider.consecutiveErrors, error);

      // Continue to next provider
      continue;
    }
  }

  // All providers failed - generate fallback
  const totalMs = Date.now() - startTime;
  log.warn({ totalMs, providersAttempted: providersAttempted.length }, 'All providers failed, using fallback');

  const fallbackResult = generateTemplateFallback(input);

  await invokeCallback('onFallback', jobId, fallbackResult, { providersAttempted });

  return {
    result: fallbackResult,
    usedProvider: 'fallback',
    providersAttempted,
    fallback: true,
    timings: { totalMs },
  };
}

/**
 * Get provider health status
 */
export function getProviderHealth(): Array<{ name: string; circuitOpen: boolean; healthy: boolean }> {
  return providers.map((p) => ({
    name: p.config.name,
    circuitOpen: p.circuit.opened,
    healthy: !p.circuit.opened,
  }));
}