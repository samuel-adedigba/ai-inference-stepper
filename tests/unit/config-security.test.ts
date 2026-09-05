import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  vi.resetModules();
});

describe('secure runtime defaults', () => {
  it('requires authentication and explicit CORS when the environment is omitted', async () => {
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_INSECURE_DEV;
    delete process.env.API_KEY_ENABLED;
    delete process.env.CORS_ALLOWED_ORIGINS;
    vi.resetModules();

    const { loadConfig } = await import('../../src/config.js');
    const loaded = loadConfig();
    expect(loaded.security.apiKey.enabled).toBe(true);
    expect(loaded.security.cors.allowedOrigins).toEqual([]);
  });

  it('allows insecure defaults only through an explicit development opt-in', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_INSECURE_DEV = 'true';
    delete process.env.API_KEY_ENABLED;
    delete process.env.CORS_ALLOWED_ORIGINS;
    vi.resetModules();

    const { loadConfig } = await import('../../src/config.js');
    const loaded = loadConfig();
    expect(loaded.security.apiKey.enabled).toBe(false);
    expect(loaded.security.cors.allowedOrigins).toEqual(['*']);
  });
});
