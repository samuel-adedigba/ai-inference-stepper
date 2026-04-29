import { ProviderConfig } from '../types.js';
import { ProviderAdapter } from './provider.interface.js';
import { getProviderAdapter } from './registry.js';
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
        const adapter = getProviderAdapter(config);
        if (!adapter) {
            logger.error({ provider: config.name }, 'Unknown provider type');
            return null;
        }

        return adapter;
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
