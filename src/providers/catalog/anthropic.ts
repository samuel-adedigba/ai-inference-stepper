import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const anthropicProviderSpec: ProviderSpec = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  endpoint: '/v1/messages',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  defaultModel: 'claude-3-5-sonnet-20241022',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'x-api-key': apiKey || '',
    'anthropic-version': '2023-06-01',
  }),
  buildBody: (prompt, model) => ({
    model: model || 'claude-3-5-sonnet-20241022',
    max_tokens: 2048,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['content', 0, 'text'], 'Invalid Anthropic response structure'),
};
