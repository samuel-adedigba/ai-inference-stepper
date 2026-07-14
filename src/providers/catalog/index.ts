import type { ProviderSpec } from '../unified.adapter.js';
import { anthropicProviderSpec } from './anthropic.js';
import { cohereProviderSpec } from './cohere.js';
import { deepseekProviderSpec } from './deepseek.js';
import { geminiProviderSpec } from './gemini.js';
import { groqProviderSpec } from './groq.js';
import { mistralProviderSpec } from './mistral.js';
import {
  nvidiaDracarysProviderSpec,
  nvidiaLlamaProviderSpec,
  nvidiaProviderSpec,
} from './nvidia.js';
import { openaiProviderSpec } from './openai.js';
import { openrouterProviderSpec } from './openrouter.js';
import { perplexityProviderSpec } from './perplexity.js';
import { togetherProviderSpec } from './together.js';

export const providerSpecsByName: Record<string, ProviderSpec> = {
  gemini: geminiProviderSpec,
  openai: openaiProviderSpec,
  anthropic: anthropicProviderSpec,
  cohere: cohereProviderSpec,
  deepseek: deepseekProviderSpec,
  groq: groqProviderSpec,
  openrouter: openrouterProviderSpec,
  mistral: mistralProviderSpec,
  nvidia: nvidiaProviderSpec,
  'nvidia-llama': nvidiaLlamaProviderSpec,
  'nvidia-dracarys': nvidiaDracarysProviderSpec,
  perplexity: perplexityProviderSpec,
  together: togetherProviderSpec,
};
