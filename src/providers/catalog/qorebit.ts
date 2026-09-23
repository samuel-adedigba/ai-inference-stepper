import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

const QOREBIT_BASE_URL = 'https://api.qorebit.ai';
const QOREBIT_API_KEY_ENV_VAR = 'QOREBIT_API_KEY';

function createQorebitProviderSpec(name: string, defaultModel: string): ProviderSpec {
  return {
    name,
    baseUrl: QOREBIT_BASE_URL,
    endpoint: '/v1/chat/completions',
    apiKeyEnvVar: QOREBIT_API_KEY_ENV_VAR,
    defaultModel,
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (apiKey || ''),
    }),
    buildBody: (prompt, model) => ({
      model: model || defaultModel,
      messages: [
        { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
    parseResponse: (data) =>
      requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid Qorebit response structure'),
  };
}

/** Fast coding-focused Qorebit lane for the normal CommitDiary report path. */
export const qorebitQwenProviderSpec = createQorebitProviderSpec(
  'qorebit-qwen',
  'alibaba/qwen3-coder-flash'
);

/** Higher-capability Qorebit fallback lane for harder report generations. */
export const qorebitDeepseekProviderSpec = createQorebitProviderSpec(
  'qorebit-deepseek',
  'deepseek/deepseek-v3'
);
