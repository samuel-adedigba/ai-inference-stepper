import { describe, expect, it } from 'vitest';
import type { ProviderSpec } from '../../../src/providers/unified.adapter.js';
import { providerSpecsByName } from '../../../src/providers/catalog/index.js';

type ProviderFixture = {
  name: string;
  spec: ProviderSpec;
  sampleResponse: unknown;
};

const fixtures: ProviderFixture[] = [
  {
    name: 'gemini',
    spec: providerSpecsByName.gemini,
    sampleResponse: { candidates: [{ content: { parts: [{ text: 'gemini-response' }] } }] },
  },
  {
    name: 'openai',
    spec: providerSpecsByName.openai,
    sampleResponse: { choices: [{ message: { content: 'openai-response' } }] },
  },
  {
    name: 'anthropic',
    spec: providerSpecsByName.anthropic,
    sampleResponse: { content: [{ text: 'anthropic-response' }] },
  },
  {
    name: 'cohere',
    spec: providerSpecsByName.cohere,
    sampleResponse: { text: 'cohere-response' },
  },
  {
    name: 'deepseek',
    spec: providerSpecsByName.deepseek,
    sampleResponse: { choices: [{ message: { content: 'deepseek-response' } }] },
  },
  {
    name: 'groq',
    spec: providerSpecsByName.groq,
    sampleResponse: { choices: [{ message: { content: 'groq-response' } }] },
  },
  {
    name: 'openrouter',
    spec: providerSpecsByName.openrouter,
    sampleResponse: { choices: [{ message: { content: 'openrouter-response' } }] },
  },
  {
    name: 'mistral',
    spec: providerSpecsByName.mistral,
    sampleResponse: { choices: [{ message: { content: 'mistral-response' } }] },
  },
  {
    name: 'perplexity',
    spec: providerSpecsByName.perplexity,
    sampleResponse: { choices: [{ message: { content: 'perplexity-response' } }] },
  },
  {
    name: 'together',
    spec: providerSpecsByName.together,
    sampleResponse: { choices: [{ message: { content: 'together-response' } }] },
  },
];

describe('Provider Catalog Specs', () => {
  fixtures.forEach(({ name, spec, sampleResponse }) => {
    it(`should build ${name} headers, url, body, and parse response`, () => {
      const apiKey = 'test-key';
      const prompt = 'Test prompt';
      const model = 'test-model';

      const headers = spec.buildHeaders(apiKey);
      const body = spec.buildBody(prompt, model) as Record<string, unknown>;

      // URL construction is endpoint-template driven. This assertion ensures
      // per-provider file exports the full route needed by the adapter.
      const resolvedEndpoint = spec.endpoint.replace('{model}', model);
      const url = `${spec.baseUrl}${resolvedEndpoint}`;

      expect(url.startsWith('https://')).toBe(true);
      expect(headers['Content-Type']).toBe('application/json');
      expect(body).toBeTypeOf('object');
      expect(spec.parseResponse(sampleResponse)).toContain('response');

      if (name === 'gemini') {
        // Gemini auth is query-param based, so header auth is intentionally absent.
        expect(headers.Authorization).toBeUndefined();
        const generationConfig = body.generationConfig as Record<string, unknown>;
        expect(generationConfig.responseMimeType).toBe('application/json');
        expect(generationConfig.responseSchema).toMatchObject({
          type: 'OBJECT',
          required: expect.arrayContaining(['title', 'changes', 'impact_and_tests']),
        });
      } else {
        expect(Object.values(headers).some((value) => String(value).includes(apiKey))).toBe(true);
      }
    });
  });
});
