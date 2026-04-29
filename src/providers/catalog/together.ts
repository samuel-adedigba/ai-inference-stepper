import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const togetherProviderSpec: ProviderSpec = {
  name: 'together',
  baseUrl: 'https://api.together.xyz',
  endpoint: '/v1/chat/completions',
  apiKeyEnvVar: 'TOGETHER_API_KEY',
  defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    messages: [
      { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid Together AI response structure'),
};
