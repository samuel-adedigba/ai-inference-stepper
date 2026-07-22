import { describe, expect, it } from 'vitest';
import { isAllowedCallbackUrl } from '../../../src/security/callbackUrls.js';

describe('callback URL policy', () => {
  it('allows only configured origins in production', () => {
    const environment = {
      NODE_ENV: 'production',
      API_URL: 'https://api.commitdiary.dev',
      CALLBACK_ALLOWED_ORIGINS: 'https://hooks.example.com',
    };

    expect(isAllowedCallbackUrl('https://api.commitdiary.dev/v1/report', environment)).toBe(true);
    expect(isAllowedCallbackUrl('https://hooks.example.com/report', environment)).toBe(true);
    expect(isAllowedCallbackUrl('http://127.0.0.1/admin', environment)).toBe(false);
    expect(isAllowedCallbackUrl('https://untrusted.example/report', environment)).toBe(false);
  });

  it('fails closed when production origins are not configured', () => {
    expect(isAllowedCallbackUrl('https://example.com/report', { NODE_ENV: 'production' })).toBe(false);
  });
});
