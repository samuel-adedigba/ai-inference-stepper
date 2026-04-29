import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const perplexityProviderSpec: ProviderSpec = {
  name: 'perplexity',
  baseUrl: 'https://api.perplexity.ai',
  endpoint: '/chat/completions',
  apiKeyEnvVar: 'PERPLEXITY_API_KEY',
  defaultModel: 'llama-3.1-sonar-large-128k-online',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'llama-3.1-sonar-large-128k-online',
    messages: [
      { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid Perplexity response structure'),
};
