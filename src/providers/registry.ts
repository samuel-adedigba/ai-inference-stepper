import { logger } from '../logging.js';
import { ProviderConfig } from '../types.js';
import { HuggingFaceSpaceAdapter } from './hfSpace.adapter.js';
import { ProviderAdapter } from './provider.interface.js';
import { UnifiedProviderAdapter } from './unified.adapter.js';
import {
  anthropicProviderSpec,
  cohereProviderSpec,
  deepseekProviderSpec,
  geminiProviderSpec,
  groqProviderSpec,
  mistralProviderSpec,
  nvidiaDracarysProviderSpec,
  nvidiaLlamaProviderSpec,
  nvidiaProviderSpec,
  openaiProviderSpec,
  openrouterProviderSpec,
  perplexityProviderSpec,
  togetherProviderSpec,
} from './specs.js';

function createUnifiedProviderAdapter(config: ProviderConfig, providerSpec: typeof geminiProviderSpec): ProviderAdapter {
  return new UnifiedProviderAdapter(providerSpec, {
    apiKey: config.apiKey,
    model: config.modelName,
    timeout: config.timeout,
    baseUrl: config.baseUrl,
  });
}

export interface ProviderConfigValidationResult {
  valid: boolean;
  reason?: string;
}

function hasNonEmptyValue(value?: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveApiKey(config: ProviderConfig, defaultEnvVar?: string): string | undefined {
  if (hasNonEmptyValue(config.apiKey)) {
    return config.apiKey;
  }

  if (hasNonEmptyValue(config.apiKeyEnvVar)) {
    return process.env[config.apiKeyEnvVar!];
  }

  if (hasNonEmptyValue(defaultEnvVar)) {
    return process.env[defaultEnvVar!];
  }

  return undefined;
}

/**
 * Validate whether a provider config is usable for runtime initialization.
 *
 * This is intentionally startup-focused validation:
 * - catches missing required auth/base URL early
 * - prevents server boot with providers that will certainly fail at request-time
 */
export function validateProviderConfig(config: ProviderConfig): ProviderConfigValidationResult {
  const providerName = config.name.toLowerCase();

  switch (providerName) {
    case 'hf-space':
      if (!hasNonEmptyValue(config.baseUrl)) {
        return { valid: false, reason: 'hf-space requires baseUrl' };
      }
      return { valid: true };
    case 'gemini': {
      const apiKey = resolveApiKey(config, geminiProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'gemini requires apiKey (or GEMINI_API_KEY env)' };
    }
    case 'openai': {
      const apiKey = resolveApiKey(config, openaiProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'openai requires apiKey (or OPENAI_API_KEY env)' };
    }
    case 'anthropic': {
      const apiKey = resolveApiKey(config, anthropicProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'anthropic requires apiKey (or ANTHROPIC_API_KEY env)' };
    }
    case 'cohere': {
      const apiKey = resolveApiKey(config, cohereProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'cohere requires apiKey (or COHERE_API_KEY env)' };
    }
    case 'deepseek': {
      const apiKey = resolveApiKey(config, deepseekProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'deepseek requires apiKey (or DEEPSEEK_API_KEY env)' };
    }
    case 'groq': {
      const apiKey = resolveApiKey(config, groqProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'groq requires apiKey (or GROQ_API_KEY env)' };
    }
    case 'openrouter': {
      const apiKey = resolveApiKey(config, openrouterProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'openrouter requires apiKey (or OPENROUTER_API_KEY env)' };
    }
    case 'mistral': {
      const apiKey = resolveApiKey(config, mistralProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'mistral requires apiKey (or MISTRAL_API_KEY env)' };
    }
    case 'nvidia': {
      const apiKey = resolveApiKey(config, nvidiaProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'nvidia requires apiKey (or NVIDIA_API_KEY env)' };
    }
    case 'nvidia-llama':
    case 'nvidia-dracarys': {
      const apiKey = resolveApiKey(config, nvidiaLlamaProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: `${providerName} requires apiKey (or NVIDIA_API_KEY env)` };
    }
    case 'perplexity': {
      const apiKey = resolveApiKey(config, perplexityProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'perplexity requires apiKey (or PERPLEXITY_API_KEY env)' };
    }
    case 'together': {
      const apiKey = resolveApiKey(config, togetherProviderSpec.apiKeyEnvVar);
      return apiKey ? { valid: true } : { valid: false, reason: 'together requires apiKey (or TOGETHER_API_KEY env)' };
    }
    default:
      return { valid: false, reason: `unsupported provider '${config.name}'` };
  }
}

/**
 * Resolve runtime provider adapter using explicit switch-case routing.
 *
 * Centralizing this routing avoids hidden dynamic lookups and makes it
 * straightforward for contributors to trace provider behavior by name.
 */
export function getProviderAdapter(config: ProviderConfig): ProviderAdapter | null {
  const providerName = config.name.toLowerCase();

  switch (providerName) {
    case 'hf-space': {
      if (!config.baseUrl) {
        logger.error('HuggingFace Space requires baseUrl');
        return null;
      }

      return new HuggingFaceSpaceAdapter({
        baseUrl: config.baseUrl,
        apiKeyEnvVar: config.apiKeyEnvVar || 'HF_SPACE_API_KEY',
        timeout: config.timeout,
      });
    }
    case 'gemini':
      return createUnifiedProviderAdapter(config, geminiProviderSpec);
    case 'openai':
      return createUnifiedProviderAdapter(config, openaiProviderSpec);
    case 'anthropic':
      return createUnifiedProviderAdapter(config, anthropicProviderSpec);
    case 'cohere':
      return createUnifiedProviderAdapter(config, cohereProviderSpec);
    case 'deepseek':
      return createUnifiedProviderAdapter(config, deepseekProviderSpec);
    case 'groq':
      return createUnifiedProviderAdapter(config, groqProviderSpec);
    case 'openrouter':
      return createUnifiedProviderAdapter(config, openrouterProviderSpec);
    case 'mistral':
      return createUnifiedProviderAdapter(config, mistralProviderSpec);
    case 'nvidia':
      return createUnifiedProviderAdapter(config, nvidiaProviderSpec);
    case 'nvidia-llama':
      return createUnifiedProviderAdapter(config, nvidiaLlamaProviderSpec);
    case 'nvidia-dracarys':
      return createUnifiedProviderAdapter(config, nvidiaDracarysProviderSpec);
    case 'perplexity':
      return createUnifiedProviderAdapter(config, perplexityProviderSpec);
    case 'together':
      return createUnifiedProviderAdapter(config, togetherProviderSpec);
    default:
      return null;
  }
}
