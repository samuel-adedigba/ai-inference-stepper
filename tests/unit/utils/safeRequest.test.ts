import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestError, isRetryableError, isAuthError, isRateLimitError, parseRetryAfter } from '../../../src/utils/safeRequest.js';

// Note: We don't mock safeRequest itself - we test the helper functions directly
// Testing safeRequest would require more complex axios mocking

describe('SafeRequest Utils', () => {
    describe('RequestError', () => {
        it('should create error with all properties', () => {
            const error = new RequestError('Test error', 500, 'TEST_ERROR', 120);

            expect(error.message).toBe('Test error');
            expect(error.status).toBe(500);
            expect(error.code).toBe('TEST_ERROR');
            expect(error.retryAfter).toBe(120);
            expect(error.name).toBe('RequestError');
        });

        it('should create error with minimal properties', () => {
            const error = new RequestError('Minimal error');

            expect(error.message).toBe('Minimal error');
            expect(error.status).toBeUndefined();
            expect(error.code).toBeUndefined();
            expect(error.retryAfter).toBeUndefined();
        });
    });

    describe('isRetryableError', () => {
        it('should return true for 408 Request Timeout', () => {
            const error = new RequestError('Timeout', 408, 'HTTP_408');
            expect(isRetryableError(error)).toBe(true);
        });

        it('should return true for 429 Too Many Requests', () => {
            const error = new RequestError('Rate limited', 429, 'HTTP_429');
            expect(isRetryableError(error)).toBe(true);
        });

        it('should return true for 500 Internal Server Error', () => {
            const error = new RequestError('Server error', 500, 'HTTP_500');
            expect(isRetryableError(error)).toBe(true);
        });

        it('should return true for 502 Bad Gateway', () => {
            const error = new RequestError('Bad gateway', 502, 'HTTP_502');
            expect(isRetryableError(error)).toBe(true);
        });

        it('should return true for 503 Service Unavailable', () => {
            const error = new RequestError('Unavailable', 503, 'HTTP_503');
            expect(isRetryableError(error)).toBe(true);
        });

        it('should return true for 504 Gateway Timeout', () => {
            const error = new RequestError('Gateway timeout', 504, 'HTTP_504');
            expect(isRetryableError(error)).toBe(true);
        });

        it('should return false for 400 Bad Request', () => {
            const error = new RequestError('Bad request', 400, 'HTTP_400');
            expect(isRetryableError(error)).toBe(false);
        });

        it('should return false for 401 Unauthorized', () => {
            const error = new RequestError('Unauthorized', 401, 'HTTP_401');
            expect(isRetryableError(error)).toBe(false);
        });

        it('should return false for 404 Not Found', () => {
            const error = new RequestError('Not found', 404, 'HTTP_404');
            expect(isRetryableError(error)).toBe(false);
        });

        it('should return false for non-RequestError', () => {
            const error = new Error('Regular error');
            expect(isRetryableError(error)).toBe(false);
        });

        it('should return false for error without status', () => {
            const error = new RequestError('No status');
            expect(isRetryableError(error)).toBe(false);
        });
    });

    describe('isAuthError', () => {
        it('should return true for 401 Unauthorized', () => {
            const error = new RequestError('Unauthorized', 401);
            expect(isAuthError(error)).toBe(true);
        });

        it('should return true for 403 Forbidden', () => {
            const error = new RequestError('Forbidden', 403);
            expect(isAuthError(error)).toBe(true);
        });

        it('should return false for 400 Bad Request', () => {
            const error = new RequestError('Bad request', 400);
            expect(isAuthError(error)).toBe(false);
        });

        it('should return false for 404 Not Found', () => {
            const error = new RequestError('Not found', 404);
            expect(isAuthError(error)).toBe(false);
        });

        it('should return false for 500 Server Error', () => {
            const error = new RequestError('Server error', 500);
            expect(isAuthError(error)).toBe(false);
        });

        it('should return false for non-RequestError', () => {
            const error = new Error('Regular error');
            expect(isAuthError(error)).toBe(false);
        });
    });

    describe('isRateLimitError', () => {
        it('should return true for 429 status', () => {
            const error = new RequestError('Rate limited', 429);
            expect(isRateLimitError(error)).toBe(true);
        });

        it('should return false for 401 status', () => {
            const error = new RequestError('Unauthorized', 401);
            expect(isRateLimitError(error)).toBe(false);
        });

        it('should return false for 500 status', () => {
            const error = new RequestError('Server error', 500);
            expect(isRateLimitError(error)).toBe(false);
        });

        it('should return false for non-RequestError', () => {
            const error = new Error('Regular error');
            expect(isRateLimitError(error)).toBe(false);
        });
    });

    describe('parseRetryAfter', () => {
        it('should return retryAfter from RequestError', () => {
            const error = new RequestError('Rate limited', 429, 'HTTP_429', 120);
            expect(parseRetryAfter(error)).toBe(120);
        });

        it('should return undefined for error without retryAfter', () => {
            const error = new RequestError('Error', 500);
            expect(parseRetryAfter(error)).toBeUndefined();
        });

        it('should return undefined for non-RequestError', () => {
            const error = new Error('Regular error');
            expect(parseRetryAfter(error)).toBeUndefined();
        });

        it('should return undefined for null', () => {
            expect(parseRetryAfter(null)).toBeUndefined();
        });

        it('should return undefined for undefined', () => {
            expect(parseRetryAfter(undefined)).toBeUndefined();
        });
    });
});
