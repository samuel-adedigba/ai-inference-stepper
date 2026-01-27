import { ProviderAdapter, ProviderError, InvalidResponseError, TimeoutError, RateLimitError, AuthError, ProviderUnavailableError } from './provider.interface.js';
import { PromptInput, ReportOutput } from '../types.js';
import { safeRequest, isAuthError, isRateLimitError, RequestError } from '../utils/safeRequest.js';
import { parseAndValidateReport } from '../validation/report.schema.js';
import { buildComprehensivePrompt, buildSimplePrompt } from './promptBuilder.js';
import { logger } from '../logging.js';

/**
 * Provider-specific configuration
 */
export interface ProviderSpec {
    name: string;
    baseUrl: string;
    endpoint: string;
    apiKeyEnvVar?: string;
    buildHeaders: (apiKey?: string) => Record<string, string>;
    buildBody: (prompt: string, model?: string) => unknown;
    parseResponse: (data: any) => string;
    defaultModel?: string;
    useSimplePrompt?: boolean;
}

/**
 * Unified AI Provider Adapter
 * Handles multiple AI providers with a single implementation
 */
export class UnifiedProviderAdapter implements ProviderAdapter {
    readonly name: string;
    private spec: ProviderSpec;
    private apiKey?: string;
    private baseUrl?: string;
    private model?: string;
    private timeout: number;

    constructor(spec: ProviderSpec, options?: { apiKey?: string; model?: string; timeout?: number; baseUrl?: string }) {
        this.name = spec.name;
        this.spec = spec;
        this.timeout = options?.timeout || 15000;
        this.model = options?.model || spec.defaultModel;
        this.baseUrl = options?.baseUrl || spec.baseUrl;

        // Get API key from options or environment
        if (options?.apiKey) {
            this.apiKey = options.apiKey;
        } else if (spec.apiKeyEnvVar) {
            this.apiKey = process.env[spec.apiKeyEnvVar];
            if (!this.apiKey) {
                logger.warn({ provider: this.name, envVar: spec.apiKeyEnvVar }, 'API key not found in environment');
            }
        }
    }

    async call(input: PromptInput): Promise<ReportOutput> {
        // Build prompt based on provider preference
        const prompt = this.spec.useSimplePrompt
            ? buildSimplePrompt(input)
            : buildComprehensivePrompt(input);

        // Replace {model} placeholder in endpoint if it exists
        const actualEndpoint = this.spec.endpoint.replace('{model}', this.model || '');
        const url = `${this.baseUrl}${actualEndpoint}`;
        const headers = this.spec.buildHeaders(this.apiKey);
        const body = this.spec.buildBody(prompt, this.model);

        try {
            const result = await safeRequest(url, {
                method: 'POST',
                headers,
                data: body,
                timeout: this.timeout,
            });

            const responseText = this.spec.parseResponse(result.data);
            if (!responseText) {
                throw new InvalidResponseError('Provider response missing expected content');
            }

            // Parse and validate
            const validation = parseAndValidateReport(responseText);
            if (!validation.valid) {
                logger.warn({
                    provider: this.name,
                    error: validation.error,
                    responsePreview: responseText.slice(0, 200)
                }, 'Provider returned invalid report');
                throw new InvalidResponseError(`Validation failed: ${validation.error}`);
            }

            return validation.result!;
        } catch (error) {
            throw this.mapError(error);
        }
    }

    private mapError(error: unknown): ProviderError {
        if (error instanceof ProviderError) {
            return error;
        }

        if (error instanceof RequestError) {
            if (isAuthError(error)) {
                return new AuthError(error.message, error.status);
            }
            if (isRateLimitError(error)) {
                return new RateLimitError(error.message, error.retryAfter);
            }
            if (error.code === 'TIMEOUT') {
                return new TimeoutError(error.message);
            }
            if (error.status && error.status >= 500) {
                return new ProviderUnavailableError(error.message, error.status);
            }
        }

        logger.error({ provider: this.name, error }, 'Unexpected provider error');
        return new ProviderError('Unexpected error', 'UNKNOWN' as any);
    }
}