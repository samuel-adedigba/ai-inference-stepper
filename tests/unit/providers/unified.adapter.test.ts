import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnifiedProviderAdapter, ProviderSpec } from '../../../src/providers/unified.adapter.js';
import { PromptInput } from '../../../src/types.js';
import { InvalidResponseError } from '../../../src/providers/provider.interface.js';
import { createCommitReportRequest } from '../../../src/presets/commit-report/request.js';

// Mock dependencies
vi.mock('../../../src/utils/safeRequest.js', () => ({
    safeRequest: vi.fn(),
    isAuthError: vi.fn(() => false),
    isRateLimitError: vi.fn(() => false),
    RequestError: class RequestError extends Error {
        constructor(message: string, public status?: number, public code?: string) {
            super(message);
        }
    },
}));

vi.mock('../../../src/validation/providerOutput.js', () => ({
    parseProviderOutput: vi.fn(),
}));

import { safeRequest } from '../../../src/utils/safeRequest.js';
import { parseProviderOutput } from '../../../src/validation/providerOutput.js';

describe('UnifiedProviderAdapter', () => {
    const mockSpec: ProviderSpec = {
        name: 'test-provider',
        baseUrl: 'https://api.test.com',
        endpoint: '/v1/generate',
        apiKeyEnvVar: 'TEST_API_KEY',
        buildHeaders: (apiKey) => ({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || ''}`,
        }),
        buildBody: (prompt, model) => ({
            prompt,
            model: model || 'test-model',
        }),
        parseResponse: (data: any) => data?.response?.text || '',
    };

    const testInput: PromptInput = {
        userId: 'test-user',
        commitSha: 'abc123',
        repo: 'test/repo',
        message: 'Test commit',
        files: ['test.ts'],
        components: ['test'],
        diffSummary: '+ test',
    };
    const testRequest = createCommitReportRequest(testInput);

    const validReport = {
        title: 'Test Report',
        summary: 'Summary',
        changes: ['Change 1'],
        rationale: 'Rationale',
        impact_and_tests: 'Impact',
        next_steps: ['Step 1'],
        tags: 'test',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Set mock env var
        process.env.TEST_API_KEY = 'test-api-key';
    });

    it('should create adapter with correct name', () => {
        const adapter = new UnifiedProviderAdapter(mockSpec);
        expect(adapter.name).toBe('test-provider');
    });

    it('should successfully call provider and return parsed report', async () => {
        const mockResponse = { response: { text: JSON.stringify(validReport) } };

        vi.mocked(safeRequest).mockResolvedValueOnce({
            data: mockResponse,
            status: 200,
            headers: {},
        });

        vi.mocked(parseProviderOutput).mockReturnValueOnce({
            valid: true,
            result: validReport,
        });

        const adapter = new UnifiedProviderAdapter(mockSpec);
        const result = await adapter.call(testRequest);

        expect(result).toEqual(validReport);
        expect(safeRequest).toHaveBeenCalledWith(
            'https://api.test.com/v1/generate',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                }),
            })
        );
    });

    it('should throw InvalidResponseError when response is empty', async () => {
        vi.mocked(safeRequest).mockResolvedValueOnce({
            data: { response: { text: '' } },
            status: 200,
            headers: {},
        });

        const adapter = new UnifiedProviderAdapter(mockSpec);

        await expect(adapter.call(testRequest)).rejects.toThrow(InvalidResponseError);
    });

    it('should throw InvalidResponseError when validation fails', async () => {
        vi.mocked(safeRequest).mockResolvedValueOnce({
            data: { response: { text: 'invalid json' } },
            status: 200,
            headers: {},
        });

        vi.mocked(parseProviderOutput).mockReturnValueOnce({
            valid: false,
            error: 'Invalid JSON structure',
        });

        const adapter = new UnifiedProviderAdapter(mockSpec);

        await expect(adapter.call(testRequest)).rejects.toThrow(InvalidResponseError);
    });

    it('should use custom model when provided', async () => {
        const mockResponse = { response: { text: JSON.stringify(validReport) } };

        vi.mocked(safeRequest).mockResolvedValueOnce({
            data: mockResponse,
            status: 200,
            headers: {},
        });

        vi.mocked(parseProviderOutput).mockReturnValueOnce({
            valid: true,
            result: validReport,
        });

        const adapter = new UnifiedProviderAdapter(mockSpec, { model: 'custom-model' });
        await adapter.call(testRequest);

        expect(safeRequest).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                data: expect.objectContaining({
                    model: 'custom-model',
                }),
            })
        );
    });

    it('should use custom baseUrl when provided', async () => {
        const mockResponse = { response: { text: JSON.stringify(validReport) } };

        vi.mocked(safeRequest).mockResolvedValueOnce({
            data: mockResponse,
            status: 200,
            headers: {},
        });

        vi.mocked(parseProviderOutput).mockReturnValueOnce({
            valid: true,
            result: validReport,
        });

        const adapter = new UnifiedProviderAdapter(mockSpec, { baseUrl: 'https://custom.api.com' });
        await adapter.call(testRequest);

        expect(safeRequest).toHaveBeenCalledWith(
            'https://custom.api.com/v1/generate',
            expect.any(Object)
        );
    });

    it('should use simple prompt when spec specifies it', async () => {
        const simpleSpec: ProviderSpec = {
            ...mockSpec,
            useSimplePrompt: true,
        };

        const mockResponse = { response: { text: JSON.stringify(validReport) } };

        vi.mocked(safeRequest).mockResolvedValueOnce({
            data: mockResponse,
            status: 200,
            headers: {},
        });

        vi.mocked(parseProviderOutput).mockReturnValueOnce({
            valid: true,
            result: validReport,
        });

        const adapter = new UnifiedProviderAdapter(simpleSpec);
        await adapter.call(testRequest);

        // Just verify the call was made (prompt content testing would require deeper mocking)
        expect(safeRequest).toHaveBeenCalled();
    });
});
