import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const groqProviderSpec: ProviderSpec = {
  name: 'groq',
  baseUrl: 'https://api.groq.com/openai',
  endpoint: '/v1/chat/completions',
  apiKeyEnvVar: 'GROQ_API_KEY',
  defaultModel: 'mixtral-8x7b-32768',
  useSimplePrompt: true,
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || 'mixtral-8x7b-32768',
    messages: [
      { role: 'system', content: 'Return valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid Groq response structure'),
};
