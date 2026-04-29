import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const mistralProviderSpec: ProviderSpec = {
  name: 'mistral',
  baseUrl: 'https://api.mistral.ai',
  endpoint: '/v1/chat/completions',
  apiKeyEnvVar: 'MISTRAL_API_KEY',
  defaultModel: 'mistral-large-latest',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'mistral-large-latest',
    messages: [
      { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid Mistral response structure'),
};
