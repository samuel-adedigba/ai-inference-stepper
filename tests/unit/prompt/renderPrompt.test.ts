import { describe, expect, it } from 'vitest';
import { renderPrompt, renderProviderPrompt } from '../../../src/prompt/renderPrompt.js';
import { PromptInput, StepperRequest } from '../../../src/types.js';
import { createCommitReportRequest } from '../../../src/presets/commit-report/request.js';

describe('renderPrompt', () => {
  it('renders plain string prompts as-is', () => {
    const prompt = renderPrompt('Summarize this payload');
    expect(prompt).toBe('Summarize this payload');
  });

  it('renders generic template prompts with payload interpolation', () => {
    const request: StepperRequest<{ repo: string; sha: string }, unknown> = {
      prompt: {
        template: 'Analyze repo {{payload.repo}} at commit {{payload.sha}}.',
      },
      payload: { repo: 'org/repo', sha: 'abc123' },
    };

    const prompt = renderPrompt(request.prompt, { payload: request.payload });
    expect(prompt).toContain('org/repo');
    expect(prompt).toContain('abc123');
  });

  it('renders commit preset in gemini mode via provider prompt router', () => {
    const legacyInput: PromptInput = {
      userId: 'user-1',
      commitSha: 'abc123',
      repo: 'org/repo',
      message: 'feat: add endpoint',
      files: ['src/api.ts'],
      components: ['api'],
      diffSummary: '+ new endpoint',
    };

    const prompt = renderProviderPrompt(createCommitReportRequest(legacyInput), {
      providerName: 'gemini',
    });

    expect(prompt).toContain('<role>');
    expect(prompt).toContain('Commit SHA: abc123');
  });

  it('throws on commit preset prompt without commit payload', () => {
    const request: StepperRequest<unknown, unknown> = {
      prompt: {
        preset: 'commit-report',
      },
    };

    expect(() =>
      renderPrompt(request.prompt, { payload: request.payload })
    ).toThrow('commit-report preset requires CommitReportInput payload');
  });
});
