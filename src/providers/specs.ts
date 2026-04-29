import type { ProviderSpec } from './unified.adapter.js';
import {
  providerSpecsByName,
} from './catalog/index.js';

// Re-export named provider specs so existing imports remain stable during refactor.
export { anthropicProviderSpec } from './catalog/anthropic.js';
export { cohereProviderSpec } from './catalog/cohere.js';
export { deepseekProviderSpec } from './catalog/deepseek.js';
export { geminiProviderSpec } from './catalog/gemini.js';
export { groqProviderSpec } from './catalog/groq.js';
export { mistralProviderSpec } from './catalog/mistral.js';
export { openaiProviderSpec } from './catalog/openai.js';
export { openrouterProviderSpec } from './catalog/openrouter.js';
export { perplexityProviderSpec } from './catalog/perplexity.js';
export { togetherProviderSpec } from './catalog/together.js';

/**
 * Legacy aggregate map kept for backwards compatibility while the package
 * migrates to switch-case provider routing in `registry.ts`.
 */
export const PROVIDER_SPECS: Record<string, ProviderSpec> = providerSpecsByName;

/**
 * Get provider spec by name.
 *
 * TODO: refactor — remove once no internal/external call sites rely on map lookup.
 */
export function getProviderSpec(name: string): ProviderSpec | undefined {
  return PROVIDER_SPECS[name.toLowerCase()];
}

export function getAvailableProviders(): string[] {
  return Object.keys(PROVIDER_SPECS);
}
