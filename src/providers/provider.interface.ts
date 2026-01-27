import { PromptInput, ReportOutput, ProviderErrorType } from '../types.js';

/**
 * Base provider error class
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public type: ProviderErrorType,
    public status?: number,
    public retryAfter?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends ProviderError {
  constructor(message: string, retryAfter?: number) {
    super(message, ProviderErrorType.RateLimit, 429, retryAfter);
    this.name = 'RateLimitError';
  }
}

export class AuthError extends ProviderError {
  constructor(message: string, status: number = 401) {
    super(message, ProviderErrorType.Auth, status);
    this.name = 'AuthError';
  }
}

export class TimeoutError extends ProviderError {
  constructor(message: string) {
    super(message, ProviderErrorType.Timeout, 408);
    this.name = 'TimeoutError';
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(message: string, status: number = 503) {
    super(message, ProviderErrorType.Unavailable, status);
    this.name = 'ProviderUnavailableError';
  }
}

export class InvalidResponseError extends ProviderError {
  constructor(message: string) {
    super(message, ProviderErrorType.InvalidResponse);
    this.name = 'InvalidResponseError';
  }
}

/**
 * Provider adapter interface
 * All AI provider implementations must conform to this interface
 */
export interface ProviderAdapter {
  /**
   * Provider name (used for logging and metrics)
   */
  readonly name: string;

  /**
   * Call the provider to generate a report
   * @throws ProviderError on failure
   */
  call(input: PromptInput): Promise<ReportOutput>;

  /**
   * Optional health check
   */
  healthCheck?(): Promise<boolean>;
}