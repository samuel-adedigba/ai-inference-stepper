import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyWebhookSuccess } from '../../../src/webhooks/delivery.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('legacy report callback metadata', () => {
  it('delivers provider, timing, and fallback provenance with the report', async () => {
    const axiosMock = vi.fn().mockResolvedValue({ status: 204, data: null, headers: {} });

    await notifyWebhookSuccess(
      'https://api.example.com/v1/webhooks/report-completed',
      'callback-secret',
      'job-1',
      { title: 'Generated report' },
      { provider: 'gemini', generationTimeMs: 912, fallback: false },
      axiosMock,
    );

    const request = axiosMock.mock.calls[0][0];
    const payload = JSON.parse(request.data);
    expect(payload.provider).toBe('gemini');
    expect(payload.generationTimeMs).toBe(912);
    expect(payload.fallback).toBe(false);
  });
});
