import { logger, createChildLogger } from '../logging.js';
import axios from 'axios';
import { StepperCallbackPayload, WebhookCallback } from '../types.js';
import { getCallbackLogOrigin, isAllowedCallbackUrl } from '../security/callbackUrls.js';

export interface CallbackDeliveryResult {
  url: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

type CallbackDeliveryOptions = { jobId?: string; axiosImpl?: typeof axios };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverSingleCallback(
  callback: WebhookCallback,
  payload: StepperCallbackPayload<unknown>,
  options: CallbackDeliveryOptions = {}
): Promise<CallbackDeliveryResult> {
  if (!isAllowedCallbackUrl(callback.url)) {
    return {
      url: callback.url,
      success: false,
      error: 'Callback URL origin is not allowed',
    };
  }

  const maxAttempts = Math.min(Math.max(Number(callback.retry?.maxAttempts ?? 3) || 3, 1), 5);
  const backoffMs = Math.min(Math.max(Number(callback.retry?.backoffMs ?? 1000) || 0, 0), 60_000);
  const callbackOrigin = getCallbackLogOrigin(callback.url);
  const log = createChildLogger({ jobId: options.jobId, callbackOrigin });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
        const response = await (options.axiosImpl ?? axios)({
        url: callback.url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Stepper/1.0',
          'X-Stepper-Timestamp': Date.now().toString(),
          ...callback.headers,
        },
          data: payload,
          timeout: 10_000,
          maxRedirects: 0,
          validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
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
    } catch {
      if (attempt < maxAttempts) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        log.warn(
          { attempt, delay, errorCode: 'CALLBACK_REQUEST_ERROR' },
          'Callback delivery errored, retrying'
        );
        await sleep(delay);
        continue;
      }

      return {
        url: callback.url,
        success: false,
        error: 'Callback request failed',
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
  options: CallbackDeliveryOptions = {}
): Promise<CallbackDeliveryResult[]> {
  const results: CallbackDeliveryResult[] = [];

  for (const callback of callbacks) {
    const result = await deliverSingleCallback(callback, payload, options);
    results.push(result);

    if (!result.success && !callback.continueOnFailure) {
      logger.warn(
        { callbackOrigin: getCallbackLogOrigin(callback.url), jobId: options.jobId },
        'Callback failed, stopping delivery chain'
      );
      break;
    }
  }

  return results;
}
