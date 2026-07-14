import type { ProviderSpec } from '../unified.adapter.js';
import { requireStringAtPath } from '../responsePath.js';

/** Build an NVIDIA NIM OpenAI-compatible provider spec for one model lane. */
function createNvidiaProviderSpec(name: string, defaultModel: string): ProviderSpec {
  return {
    name,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  endpoint: '/chat/completions',
  apiKeyEnvVar: 'NVIDIA_API_KEY',
  defaultModel,
  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey || ''}`,
  }),
  buildBody: (prompt, model) => ({
    model: model || defaultModel,
    messages: [
      { role: 'system', content: 'You are an expert code analyst. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    top_p: 0.7,
    max_tokens: 1024,
    stream: false,
  }),
  parseResponse: (data) =>
    requireStringAtPath(data, ['choices', 0, 'message', 'content'], 'Invalid NVIDIA response structure'),
  };
}

/** Primary NVIDIA report-generation lane. */
export const nvidiaLlamaProviderSpec = createNvidiaProviderSpec(
  'nvidia-llama',
  'meta/llama-3.3-70b-instruct',
);

/** NVIDIA fallback report-generation lane. */
export const nvidiaDracarysProviderSpec = createNvidiaProviderSpec(
  'nvidia-dracarys',
  'abacusai/dracarys-llama-3.1-70b-instruct',
);

/** Legacy single-model NVIDIA entry retained for existing NVIDIA_ENABLED deployments. */
export const nvidiaProviderSpec = nvidiaLlamaProviderSpec;
