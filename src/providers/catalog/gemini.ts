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
      temperature: 0.3,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          summary: { type: 'STRING' },
          changes: { type: 'ARRAY', items: { type: 'STRING' } },
          rationale: { type: 'STRING' },
          impact_and_tests: { type: 'STRING' },
          next_steps: { type: 'ARRAY', items: { type: 'STRING' } },
          tags: { type: 'STRING' },
        },
        required: [
          'title',
          'summary',
          'changes',
          'rationale',
          'impact_and_tests',
          'next_steps',
          'tags',
        ],
      },
    },
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['candidates', 0, 'content', 'parts', 0, 'text'], 'Invalid Gemini response structure'),
};
