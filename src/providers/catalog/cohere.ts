import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const cohereProviderSpec: ProviderSpec = {
  name: 'cohere',
  baseUrl: 'https://api.cohere.ai',
  endpoint: '/v1/chat',
  apiKeyEnvVar: 'COHERE_API_KEY',
  defaultModel: 'command-r-plus',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'command-r-plus',
    message: prompt,
    temperature: 0.3,
    max_tokens: 2048,
    preamble: 'You are an expert software engineer. Respond with valid JSON only.',
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['text'], 'Invalid Cohere response structure'),
};
