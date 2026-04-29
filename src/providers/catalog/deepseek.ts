import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const deepseekProviderSpec: ProviderSpec = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  endpoint: '/v1/chat/completions',
  apiKeyEnvVar: 'DEEPSEEK_API_KEY',
  defaultModel: 'deepseek-chat',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid DeepSeek response structure'),
};
