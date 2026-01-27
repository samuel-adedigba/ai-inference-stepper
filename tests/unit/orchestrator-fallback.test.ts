import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateReportNow, initializeProviders, registerCallbacks } from '../../src/stepper/orchestrator.js';
import { PromptInput, StepperCallbacks } from '../../src/types.js';
import { ProviderUnavailableError } from '../../src/providers/provider.interface.js';

const mockProviderCall = vi.fn();

vi.mock('../../src/providers/hfSpace.adapter.js', () => ({
    HuggingFaceSpaceAdapter: class {
        name = 'hf-space';
        async call(input: PromptInput) {
            return mockProviderCall(input);
        }
    },
}));

describe('Orchestrator Fallback', () => {
    const testInput: PromptInput = {
        userId: 'test-user',
        commitSha: 'abc123',
        repo: 'test/repo',
        message: 'Test commit message',
        files: ['src/app.ts', 'src/utils.ts'],
        components: ['app', 'utils'],
        diffSummary: '+ added new feature\n- removed old code',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        initializeProviders([
            {
                name: 'hf-space',
                enabled: true,
                baseUrl: 'http://test.local',
                rateLimitRPS: 10,
                concurrency: 1,
                timeout: 5000,
            },
        ]);
    });

    it('should use template fallback when all providers fail', async () => {
        mockProviderCall.mockRejectedValue(new ProviderUnavailableError('Service down'));

        const result = await generateReportNow(testInput, 'fallback-test');

        expect(result.fallback).toBe(true);
        expect(result.usedProvider).toBe('fallback');
        expect(result.result).toBeDefined();
        expect(result.result.title).toContain('Test commit message');
        expect(result.result.summary).toBeTruthy();
        expect(result.providersAttempted).toHaveLength(1);
        expect(result.providersAttempted[0].provider).toBe('hf-space');
        expect(result.providersAttempted[0].error).toBeTruthy();
    });

    it('should invoke onFallback callback', async () => {
        const onFallback = vi.fn();
        const callbacks: StepperCallbacks = { onFallback };

        registerCallbacks(callbacks);
        mockProviderCall.mockRejectedValue(new Error('All down'));

        const result = await generateReportNow(testInput, 'fallback-test');

        expect(onFallback).toHaveBeenCalledWith(
            'fallback-test',
            result.result,
            expect.objectContaining({
                providersAttempted: expect.any(Array),
            })
        );
    });

    it('should generate valid fallback report structure', async () => {
        mockProviderCall.mockRejectedValue(new Error('Fail'));

        const result = await generateReportNow(testInput, 'fallback-test');

        // Verify fallback report has all required fields
        expect(result.result).toHaveProperty('title');
        expect(result.result).toHaveProperty('summary');
        expect(result.result).toHaveProperty('changes');
        expect(result.result).toHaveProperty('rationale');
        expect(result.result).toHaveProperty('impact_and_tests');
        expect(result.result).toHaveProperty('next_steps');
        expect(result.result).toHaveProperty('tags');

        expect(Array.isArray(result.result.changes)).toBe(true);
        expect(Array.isArray(result.result.next_steps)).toBe(true);
    });
});