import { describe, expect, it } from 'vitest';
import { validateProviderConfig } from '../../../src/providers/registry.js';
import { ProviderConfig } from '../../../src/types.js';

describe('Provider registry validation', () => {
  it('marks API-key providers invalid when key is missing', () => {
    const config: ProviderConfig = {
      name: 'openai',
      enabled: true,
      concurrency: 1,
      timeout: 5000,
    };

    const validation = validateProviderConfig(config);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('requires apiKey');
  });

  it('accepts API-key providers when key is provided', () => {
    const config: ProviderConfig = {
      name: 'openai',
      enabled: true,
      apiKey: 'test-key',
      concurrency: 1,
      timeout: 5000,
    };

    const validation = validateProviderConfig(config);
    expect(validation.valid).toBe(true);
  });

  it('requires baseUrl for hf-space', () => {
    const config: ProviderConfig = {
      name: 'hf-space',
      enabled: true,
      concurrency: 1,
      timeout: 5000,
    };

    const validation = validateProviderConfig(config);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('baseUrl');
  });

  it('accepts Qorebit model lanes with the shared API key', () => {
    const validation = validateProviderConfig({
      name: 'qorebit-qwen', enabled: true, apiKey: 'qb_test_key',
      concurrency: 2, timeout: 60000, rateLimitRPM: 10,
    });

    expect(validation.valid).toBe(true);
  });

  it('rejects Qorebit model lanes when the shared API key is missing', () => {
    const validation = validateProviderConfig({
      name: 'qorebit-deepseek', enabled: true,
      concurrency: 2, timeout: 60000, rateLimitRPM: 10,
    });

    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('QOREBIT_API_KEY');
  });
});
