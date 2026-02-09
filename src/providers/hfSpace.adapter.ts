import { ProviderErrorType } from '../types.js';
import { ProviderAdapter, ProviderError, InvalidResponseError, TimeoutError, RateLimitError, AuthError, ProviderUnavailableError } from './provider.interface.js';
import { PromptInput, ReportOutput } from '../types.js';
import { safeRequest, isAuthError, isRateLimitError, RequestError } from '../utils/safeRequest.js';
import { parseAndValidateReport } from '../validation/report.schema.js';
// import { redactSecrets } from '../utils/redaction.js';
// import { config } from '../config.js';
import { logger } from '../logging.js';
import { buildComprehensivePrompt } from './promptBuilder.js';

/**
 * Hugging Face Space adapter
 * Calls a deployed HF Space at POST /api/infer endpoint
 */
export class HuggingFaceSpaceAdapter implements ProviderAdapter {
    readonly name = 'hf-space';
    private baseUrl: string;    
    private apiKey?: string;
    private timeout: number;

    constructor(providerConfig: { baseUrl: string; apiKeyEnvVar?: string; timeout?: number }) {
        this.baseUrl = providerConfig.baseUrl;
        this.timeout = providerConfig.timeout || 30000;

        if (providerConfig.apiKeyEnvVar) {
            this.apiKey = process.env[providerConfig.apiKeyEnvVar];
            if (!this.apiKey) {
                logger.warn({ envVar: providerConfig.apiKeyEnvVar }, 'HF Space API key not found in environment');
            }
        }
    }

    async call(input: PromptInput): Promise<ReportOutput> {
      //  const prompt = this.buildPrompt(input);
        const prompt = buildComprehensivePrompt(input);
        const url = `${this.baseUrl}/api/infer`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        try {
            const result = await safeRequest<{ report?: string; output?: string }>(url, {
                method: 'POST',
                headers,
                data: { prompt },
                timeout: this.timeout,
            });

            // HF Space returns { report: "JSON string" } or { output: "JSON string" }
            const responseText = result.data.report || result.data.output;
            if (!responseText) {
                throw new InvalidResponseError('HF Space response missing report/output field');
            }
            // Parse and validate
            const validation = parseAndValidateReport(responseText);
            if (!validation.valid) {
                logger.warn({ error: validation.error, response: responseText.slice(0, 200) }, 'HF Space returned invalid report');
                throw new InvalidResponseError(`Validation failed: ${validation.error}`);
            }

            return validation.result!;
        } catch (error) {
            throw this.mapError(error);
        }
    }
    // This is like a "ping" to check if the Hugging Face Space is alive and responding.
    async healthCheck(): Promise<boolean> {
        try {
            const url = `${this.baseUrl}/health`;
            await safeRequest(url, { method: 'GET', timeout: 5000 });
            return true;
        } catch {
            return false;
        }
    }
    // private buildPrompt(input: PromptInput): string {
    //     let prompt = `Generate a structured commit report for the following changes: \n\n`;
    //     prompt += `Repository: ${input.repo} \n`;
    //     prompt += `Commit: ${input.commitSha} \n`;
    //     prompt += `Message: ${input.message} \n\n`;
    //     prompt += `Files changed(${input.files.length}): \n${input.files.slice(0, 20).join('\n')} \n\n`;
    //     prompt += `Components affected: ${input.components.join(', ')} \n\n`;
    //     prompt += `Diff summary: \n${input.diffSummary.slice(0, 2000)} \n\n`;
    //     prompt += `Return ONLY a valid JSON object with these exact fields: title, summary, changes(array), rationale, impact_and_tests, next_steps(array), tags. No markdown, no backticks, just JSON.`;
    //     // Redact if configured
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

        logger.error({ error }, 'Unexpected HF Space error');
        return new ProviderError('Unexpected error', ProviderErrorType.Unknown);
    }
}