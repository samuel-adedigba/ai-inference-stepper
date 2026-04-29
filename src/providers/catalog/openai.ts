import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const openaiProviderSpec: ProviderSpec = {
  name: 'openai',
  baseUrl: 'https://api.openai.com',
  endpoint: '/v1/chat/completions',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  defaultModel: 'gpt-4-turbo-preview',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'gpt-4-turbo-preview',
    messages: [
      { role: 'system', content: 'You are an expert software engineer analyzing code commits. Always respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid OpenAI response structure'),
};
