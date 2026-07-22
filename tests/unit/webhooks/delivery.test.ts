import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyWebhookSuccess } from '../../../src/webhooks/delivery.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('legacy report callback metadata', () => {
  it('delivers provider, timing, and fallback provenance with the report', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await notifyWebhookSuccess(
      'https://api.example.com/v1/webhooks/report-completed',
      'callback-secret',
      'job-1',
      { title: 'Generated report' },
      { provider: 'gemini', generationTimeMs: 912, fallback: false },
    );

    const request = fetchMock.mock.calls[0][1];
    const payload = JSON.parse(request.body);
    expect(payload.provider).toBe('gemini');
    expect(payload.generationTimeMs).toBe(912);
    expect(payload.fallback).toBe(false);
  });
});
