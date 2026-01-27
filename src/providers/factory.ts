import { ProviderConfig } from '../types.js';
import { ProviderAdapter } from './provider.interface.js';
import { HuggingFaceSpaceAdapter } from './hfSpace.adapter.js';
import { UnifiedProviderAdapter } from './unified.adapter.js';
import { getProviderSpec } from './specs.js';
import { logger } from '../logging.js';

/**
 * Create a provider adapter based on configuration
 */
export function createProviderAdapter(config: ProviderConfig): ProviderAdapter | null {
    if (config.enabled === false) {
        logger.debug({ provider: config.name }, 'Provider disabled in configuration');
        return null;
    }

    try {
        // Special case: HuggingFace Space (custom adapter)
        if (config.name === 'hf-space') {
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

        // All other providers use unified adapter
        const spec = getProviderSpec(config.name);
        if (!spec) {
            logger.error({ provider: config.name }, 'Unknown provider type');
            return null;
        }

        return new UnifiedProviderAdapter(spec, {
            apiKey: config.apiKey,
            model: config.modelName,
            timeout: config.timeout,
            baseUrl: config.baseUrl,
        });
    } catch (error) {
        logger.error({ provider: config.name, error }, 'Failed to create provider adapter');
        return null;
    }
}

/**
 * Create multiple provider adapters from array of configs
 */
export function createProviderAdapters(configs: ProviderConfig[]): ProviderAdapter[] {
    return configs
        .map(createProviderAdapter)
        .filter((adapter): adapter is ProviderAdapter => adapter !== null);
}