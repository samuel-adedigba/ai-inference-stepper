import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const geminiProviderSpec: ProviderSpec = {
  name: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  endpoint: '/v1beta/models/{model}:generateContent',
  apiKeyEnvVar: 'GEMINI_API_KEY',
  defaultModel: 'gemini-2.5-flash',
  buildHeaders: () => ({
    'Content-Type': 'application/json',
  }),
  buildBody: (prompt) => ({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      // Gemini performs poorly if this is too low for structured analysis.
      temperature: 1.0,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
    },
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['candidates', 0, 'content', 'parts', 0, 'text'], 'Invalid Gemini response structure'),
};
