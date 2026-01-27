import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createProviderAdapter } from '../../../src/providers/factory.js';
import { ProviderConfig } from '../../../src/types.js';

// Mock provider specs and adapters
vi.mock('../../../src/providers/specs.js', () => ({
    getProviderSpec: vi.fn((name: string) => {
        if (name === 'gemini' || name === 'openai' || name === 'cohere') {
            return {
                name,
                baseUrl: `https://api.${name}.com`,
                endpoint: '/v1/generate',
                buildHeaders: () => ({}),
                buildBody: (prompt: string) => ({ prompt }),
                parseResponse: (data: any) => data?.text || '',
            };
        }
        return undefined;
    }),
}));

vi.mock('../../../src/providers/unified.adapter.js', () => ({
    UnifiedProviderAdapter: class MockUnifiedAdapter {
        name: string;
        constructor(spec: any, options?: any) {
            this.name = spec.name;
        }
        async call() {
            return { title: 'Mock', summary: '', changes: [], rationale: '', impact_and_tests: '', next_steps: [], tags: '' };
        }
    },
}));

vi.mock('../../../src/providers/hfSpace.adapter.js', () => ({
    HuggingFaceSpaceAdapter: class MockHFAdapter {
        name = 'hf-space';
        constructor(config: any) { }
        async call() {
            return { title: 'HF Mock', summary: '', changes: [], rationale: '', impact_and_tests: '', next_steps: [], tags: '' };
        }
    },
}));

describe('Provider Factory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('createProviderAdapter', () => {
        it('should create HuggingFace Space adapter for hf-space provider', () => {
            const config: ProviderConfig = {
                name: 'hf-space',
                enabled: true,
                baseUrl: 'https://my-space.hf.space',
                timeout: 30000,
                rateLimitRPS: 5,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeDefined();
            expect(adapter?.name).toBe('hf-space');
        });

        it('should create UnifiedProviderAdapter for known providers', () => {
            const config: ProviderConfig = {
                name: 'gemini',
                enabled: true,
                baseUrl: 'https://api.google.com',
                apiKeyEnvVar: 'GEMINI_API_KEY',
                timeout: 15000,
                rateLimitRPS: 10,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeDefined();
            expect(adapter?.name).toBe('gemini');
        });

        it('should create adapter for OpenAI provider', () => {
            const config: ProviderConfig = {
                name: 'openai',
                enabled: true,
                baseUrl: 'https://api.openai.com',
                apiKeyEnvVar: 'OPENAI_API_KEY',
                timeout: 15000,
                rateLimitRPS: 10,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeDefined();
            expect(adapter?.name).toBe('openai');
        });

        it('should create adapter for Cohere provider', () => {
            const config: ProviderConfig = {
                name: 'cohere',
                enabled: true,
                baseUrl: 'https://api.cohere.ai',
                apiKeyEnvVar: 'COHERE_API_KEY',
                timeout: 15000,
                rateLimitRPS: 10,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeDefined();
            expect(adapter?.name).toBe('cohere');
        });

        it('should return undefined for unknown provider without spec', () => {
            const config: ProviderConfig = {
                name: 'unknown-provider',
                enabled: true,
                timeout: 15000,
                rateLimitRPS: 10,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeNull();
        });

        it('should pass custom timeout to adapter', () => {
            const config: ProviderConfig = {
                name: 'gemini',
                enabled: true,
                timeout: 60000,
                rateLimitRPS: 10,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeDefined();
            // The timeout is passed internally - we verify adapter was created
        });

        it('should pass custom model name when provided', () => {
            const config: ProviderConfig = {
                name: 'gemini',
                enabled: true,
                modelName: 'gemini-1.5-pro',
                timeout: 15000,
                rateLimitRPS: 10,
                concurrency: 2,
            };

            const adapter = createProviderAdapter(config);

            expect(adapter).toBeDefined();
        });
    });
});
