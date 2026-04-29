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
});
