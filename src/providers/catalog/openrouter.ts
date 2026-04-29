import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

export const openrouterProviderSpec: ProviderSpec = {
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api',
  endpoint: '/v1/chat/completions',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  defaultModel: 'anthropic/claude-3.5-sonnet',
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
    // Keep defaults package-neutral; integrations can override with env vars.
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://ai-inference-stepper.local',
    'X-Title': process.env.OPENROUTER_TITLE || 'AI Inference Stepper',
  }),
  buildBody: (prompt, model) => ({
    model: model || 'anthropic/claude-3.5-sonnet',
    messages: [
      { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid OpenRouter response structure'),
};
