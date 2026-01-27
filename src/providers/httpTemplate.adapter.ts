// packages/stepper/src/providers/httpTemplate.adapter.ts

import { ProviderAdapter, ProviderError, InvalidResponseError, TimeoutError, RateLimitError, AuthError, ProviderUnavailableError } from './provider.interface.js';
import { PromptInput, ReportOutput } from '../types.js';
import { safeRequest, isAuthError, isRateLimitError, RequestError } from '../utils/safeRequest.js';
import { parseAndValidateReport } from '../validation/report.schema.js';
// import { redactSecrets } from '../utils/redaction.js';
import { logger } from '../logging.js';
import { buildComprehensivePrompt, buildSimplePrompt } from './promptBuilder.js';

/**
 * Generic HTTP provider adapter template
 * Can be used for Gemini, Cohere, DeepAI, etc.
 * 
 * Usage:
 *   const gemini = new HttpTemplateAdapter({
 *     name: 'gemini',
 *     baseUrl: 'https://generativelanguage.googleapis.com/v1',
 *     apiKeyEnvVar: 'GEMINI_API_KEY',
 *     buildRequest: (prompt, apiKey) => ({ ... }),
 *     parseResponse: (data) => ({ ... })
 *   });
 */

interface HttpTemplateConfig {
    name: string;
    baseUrl: string;
    apiKeyEnvVar?: string;
    timeout?: number;
    useSimplePrompt?: boolean; // Use lightweight prompt for faster models
    buildRequest: (prompt: string, apiKey?: string) => {
        endpoint: string;
        headers: Record<string, string>;
        body: unknown;
    };
    parseResponse: (data: unknown) => string;
}
export class HttpTemplateAdapter implements ProviderAdapter {
    readonly name: string;
    private baseUrl: string;
    private apiKey?: string;
    private timeout: number;
    private useSimplePrompt: boolean;
    private buildRequest: HttpTemplateConfig['buildRequest'];
    private parseResponse: HttpTemplateConfig['parseResponse'];

    constructor(config: HttpTemplateConfig) {
        this.name = config.name;
        this.baseUrl = config.baseUrl;
        this.timeout = config.timeout || 15000;
        this.useSimplePrompt = config.useSimplePrompt || false;
        this.buildRequest = config.buildRequest;
        this.parseResponse = config.parseResponse;

        if (config.apiKeyEnvVar) {
            this.apiKey = process.env[config.apiKeyEnvVar];
            if (!this.apiKey) {
                logger.warn({ provider: this.name, envVar: config.apiKeyEnvVar }, 'API key not found in environment');
            }
        }
    }

    async call(input: PromptInput): Promise<ReportOutput> {
        const prompt = this.useSimplePrompt
            ? buildSimplePrompt(input)
            : buildComprehensivePrompt(input);
        const { endpoint, headers, body } = this.buildRequest(prompt, this.apiKey);
        const url = `${this.baseUrl}${endpoint}`;

        try {
            const result = await safeRequest(url, {
                method: 'POST',
                headers,
                data: body,
                timeout: this.timeout,
            });

            const responseText = this.parseResponse(result.data);
            if (!responseText) {
                throw new InvalidResponseError('Provider response missing expected content');
            }

            // Parse and validate
            const validation = parseAndValidateReport(responseText);
            if (!validation.valid) {
                logger.warn({
                    provider: this.name, error: validation.error, responsePreview: responseText.slice(0, 200)
                }, 'Provider returned invalid report');
                throw new InvalidResponseError(`Validation failed: ${validation.error}`);
            }
            return validation.result!;
        } catch (error) {
            throw this.mapError(error);
        }
    }

    // private buildPrompt(input: PromptInput): string {
    //     let prompt = `Generate a structured commit report in JSON format.\n\n`;
    //     prompt += `Repository: ${input.repo}\n`;
    //     prompt += `Commit SHA: ${input.commitSha}\n`;
    //     prompt += `Commit message: ${input.message}\n\n`;
    //     prompt += `Files changed: ${input.files.join(', ')}\n`;
    //     prompt += `Components: ${input.components.join(', ')}\n\n`;
    //     prompt += `Diff summary:\n${input.diffSummary.slice(0, 1500)}\n\n`;
    //     prompt += `Return a JSON object with: title (string, max 120 chars), summary (string), changes (array of strings), rationale (string), impact_and_tests (string), next_steps (array of strings), tags (string).`;

    //     if (config.security.redactBeforeSend) {
    //         prompt = redactSecrets(prompt);
    //     }

    //     return prompt;
    // }

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