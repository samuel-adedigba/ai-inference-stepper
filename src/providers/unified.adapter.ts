import { ProviderAdapter, ProviderError, InvalidResponseError, TimeoutError, RateLimitError, AuthError, ProviderUnavailableError } from './provider.interface.js';
import { PromptInput, ReportOutput } from '../types.js';
import { safeRequest, isAuthError, isRateLimitError, RequestError } from '../utils/safeRequest.js';
import { parseAndValidateReport } from '../validation/report.schema.js';
import { buildComprehensivePrompt, buildSimplePrompt, buildGeminiPrompt } from './promptBuilder.js';
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
        /**
         * Build prompt based on provider-specific requirements
         * 
         * GEMINI-SPECIFIC: Uses XML-structured prompt with <role>, <instructions>, <constraints>, etc.
         * Google Gemini 3 performs better with XML markup than traditional markdown prompts.
         * Reference: https://ai.google.dev/gemini-api/docs/prompting-strategies#use-xml-tags
         */
        let prompt: string;
        if (this.spec.name === 'gemini') {
            prompt = buildGeminiPrompt(input);
        } else if (this.spec.useSimplePrompt) {
            prompt = buildSimplePrompt(input);
        } else {
            prompt = buildComprehensivePrompt(input);
        }

        // Replace {model} placeholder in endpoint
        let actualEndpoint = this.spec.endpoint.replace('{model}', this.model || '');
        
        /**
         * GEMINI-SPECIFIC: Authentication via query parameter
         * 
         * Google Gemini requires API key in the URL query string (?key=YOUR_API_KEY)
         * instead of the Authorization header used by most other LLM providers.
         * Reference: https://ai.google.dev/gemini-api/docs/api-key
         */
        if (this.spec.name === 'gemini' && this.apiKey) {
            actualEndpoint = `${actualEndpoint}?key=${this.apiKey}`;
        }
        
        const url = `${this.baseUrl}${actualEndpoint}`;
        const headers = this.spec.buildHeaders(this.apiKey);
        const body = this.spec.buildBody(prompt, this.model);

        logger.info({
            provider: this.name,
            model: this.model,
            endpoint: actualEndpoint,
            promptLength: prompt.length,
            timestamp: new Date().toISOString()
        }, `🤖 [${this.name}] Starting AI processing...`);

        const startTime = Date.now();

        try {
            const result = await safeRequest(url, {
                method: 'POST',
                headers,
                data: body,
                timeout: this.timeout,
            });

            const processingTime = Date.now() - startTime;
            const responseText = this.spec.parseResponse(result.data);
            
            logger.info({
                provider: this.name,
                processingTimeMs: processingTime,
                responseLength: responseText?.length || 0
            }, `✅ [${this.name}] AI response received in ${processingTime}ms`);

            logger.debug({
                provider: this.name,
                rawResponse: responseText?.slice(0, 500) + (responseText?.length > 500 ? '...' : '')
            }, `📄 [${this.name}] Raw AI response (first 500 chars)`);

            if (!responseText) {
                throw new InvalidResponseError('Provider response missing expected content');
            }

            // Parse and validate
            logger.info({ provider: this.name }, `🔍 [${this.name}] Validating AI response...`);
            
            const validation = parseAndValidateReport(responseText);
            if (!validation.valid) {
                logger.warn({
                    provider: this.name,
                    error: validation.error,
                    responsePreview: responseText.slice(0, 200)
                }, `❌ [${this.name}] Validation failed: ${validation.error}`);
                throw new InvalidResponseError(`Validation failed: ${validation.error}`);
            }

            logger.info({
                provider: this.name,
                totalTimeMs: Date.now() - startTime,
                reportTitle: validation.result?.title?.slice(0, 80)
            }, `✨ [${this.name}] Report generated successfully!`);

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