import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverRequestCallbacks } from '../../../src/webhooks/requestCallbacks.js';
import { StepperCallbackPayload, WebhookCallback } from '../../../src/types.js';

describe('deliverRequestCallbacks', () => {
  const payload: StepperCallbackPayload<unknown> = {
    success: true,
    result: { ok: true },
    metadata: {
      jobId: 'job-1',
      timestamp: new Date().toISOString(),
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers callbacks in order and stops on first failure when continueOnFailure is false', async () => {
    const axiosMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, data: null });

    const callbacks: WebhookCallback[] = [
      { url: 'https://cb-1.test', retry: { maxAttempts: 1, backoffMs: 1 } },
      { url: 'https://cb-2.test' },
    ];

    const results = await deliverRequestCallbacks(callbacks, payload, { jobId: 'job-1', axiosImpl: axiosMock });

    expect(axiosMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ url: 'https://cb-1.test', success: false }));
  });

  it('continues callback chain when continueOnFailure is true', async () => {
    const axiosMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 400, data: null })
      .mockResolvedValueOnce({ status: 200, data: null });

    const callbacks: WebhookCallback[] = [
      { url: 'https://cb-1.test', continueOnFailure: true, retry: { maxAttempts: 1, backoffMs: 1 } },
      { url: 'https://cb-2.test' },
    ];

    const results = await deliverRequestCallbacks(callbacks, payload, { jobId: 'job-1', axiosImpl: axiosMock });

    expect(axiosMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1]).toEqual(expect.objectContaining({ url: 'https://cb-2.test', success: true }));
  });
});
