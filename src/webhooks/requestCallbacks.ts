import { logger, createChildLogger } from '../logging.js';
import { StepperCallbackPayload, WebhookCallback } from '../types.js';

export interface CallbackDeliveryResult {
  url: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverSingleCallback(
  callback: WebhookCallback,
  payload: StepperCallbackPayload<unknown>,
  jobId?: string
): Promise<CallbackDeliveryResult> {
  const maxAttempts = callback.retry?.maxAttempts ?? 3;
  const backoffMs = callback.retry?.backoffMs ?? 1000;
  const log = createChildLogger({ jobId, callbackUrl: callback.url });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(callback.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Stepper/1.0',
          'X-Stepper-Timestamp': Date.now().toString(),
          ...callback.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        log.info({ attempt, statusCode: response.status }, 'Callback delivered');
        return { url: callback.url, success: true, statusCode: response.status };
      }

      if ((response.status >= 500 || response.status === 429) && attempt < maxAttempts) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        log.warn({ attempt, statusCode: response.status, delay }, 'Retrying callback delivery');
        await sleep(delay);
        continue;
      }

      log.warn({ attempt, statusCode: response.status }, 'Callback delivery failed with non-OK response');
      return { url: callback.url, success: false, statusCode: response.status };
    } catch (error) {
      if (attempt < maxAttempts) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        log.warn(
          { attempt, delay, error: error instanceof Error ? error.message : String(error) },
          'Callback delivery errored, retrying'
        );
        await sleep(delay);
        continue;
      }

      return {
        url: callback.url,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { url: callback.url, success: false, error: 'Max attempts exceeded' };
}

/**
 * Deliver request callbacks in-order with per-callback retry support.
 *
 * Why in-order:
 * - preserves deterministic behavior for integrations that chain callback side effects.
 * - respects `continueOnFailure` contract exactly.
 */
export async function deliverRequestCallbacks(
  callbacks: WebhookCallback[],
  payload: StepperCallbackPayload<unknown>,
  options: { jobId?: string } = {}
): Promise<CallbackDeliveryResult[]> {
  const results: CallbackDeliveryResult[] = [];

  for (const callback of callbacks) {
    const result = await deliverSingleCallback(callback, payload, options.jobId);
    results.push(result);

    if (!result.success && !callback.continueOnFailure) {
      logger.warn({ callbackUrl: callback.url, jobId: options.jobId }, 'Callback failed, stopping delivery chain');
      break;
    }
  }

  return results;
}
