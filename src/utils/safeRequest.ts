import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from '../logging.js';

export interface SafeRequestOptions extends AxiosRequestConfig {
  timeout?: number;
  retryAfterHeader?: boolean;
}

export interface SafeRequestResult<T = unknown> {
  data: T;
  status: number;
  headers: Record<string, string>;
  retryAfter?: number;
}

export class RequestError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public retryAfter?: number
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * Make an HTTP request with timeout and retry-after header parsing
 */
export async function safeRequest<T = unknown>(
  url: string,
  options: SafeRequestOptions = {}
): Promise<SafeRequestResult<T>> {
  const timeout = options.timeout || 15000;

  try {
    const response: AxiosResponse<T> = await axios({
      ...options,
      url,
      timeout,
      validateStatus: (status) => status < 600, // Don't throw on any status
    });

    // Parse Retry-After header if present
    let retryAfter: number | undefined;
    const retryAfterHeader = response.headers['retry-after'];
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      retryAfter = isNaN(parsed) ? undefined : parsed;
    }

    // Throw on error statuses
    if (response.status >= 400) {
      throw new RequestError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        `HTTP_${response.status}`,
        retryAfter
      );
    }

    return {
      data: response.data,
      status: response.status,
      headers: response.headers as Record<string, string>,
      retryAfter,
    };
  } catch (error) {
    if (error instanceof RequestError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      // Timeout
      if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
        throw new RequestError('Request timeout', 408, 'TIMEOUT');
      }

      // Network errors
      if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
        throw new RequestError('Network error', 503, 'NETWORK_ERROR');
      }

      // Parse response error
      const status = axiosError.response?.status;
      const retryAfter = axiosError.response?.headers['retry-after']
        ? parseInt(axiosError.response.headers['retry-after'], 10)
        : undefined;

      throw new RequestError(
        axiosError.message,
        status,
        status ? `HTTP_${status}` : 'UNKNOWN',
        retryAfter
      );
    }

    logger.error({ error }, 'Unexpected request error');
    throw new RequestError('Unexpected error', undefined, 'UNKNOWN');
  }
}

/**
 * Parse error and extract retry-after information
 */
export function parseRetryAfter(error: unknown): number | undefined {
  if (error instanceof RequestError && error.retryAfter) {
    return error.retryAfter;
  }
  return undefined;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof RequestError)) return false;

  const retryableCodes = [408, 429, 500, 502, 503, 504];
  return error.status ? retryableCodes.includes(error.status) : false;
}

/**
 * Check if error is auth-related
 */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof RequestError)) return false;
  return error.status === 401 || error.status === 403;
}

/**
 * Check if error is rate limit
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof RequestError)) return false;
  return error.status === 429;
}