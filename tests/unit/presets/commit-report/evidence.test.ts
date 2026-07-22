import { describe, expect, it } from 'vitest';
import { buildCommitEvidence, selectRepresentativeFiles } from '../../../../src/presets/commit-report/evidence.js';
import { validateCommitReportInput } from '../../../../src/presets/commit-report/request.js';
import { PromptInput } from '../../../../src/types.js';
import {
  buildCommitReportComprehensivePrompt,
  buildCommitReportSimplePrompt,
} from '../../../../src/presets/commit-report/prompt.js';

function buildInput(diffSummary: string): PromptInput {
  return {
    userId: 'user-1',
    commitSha: 'abcdef1234567',
    repo: 'org/repo',
    message: 'feat: improve report evidence',
    files: ['src/a.ts'],
    components: ['reports'],
    diffSummary,
  };
}

describe('commit report evidence', () => {
  it('keeps both ends of oversized evidence within the requested budget', () => {
    const evidence = buildCommitEvidence(
      buildInput(`START\n${'middle evidence\n'.repeat(2000)}END`),
      2000,
    );

    expect(evidence.length).toBeLessThanOrEqual(2000);
    expect(evidence).toContain('START');
    expect(evidence).toContain('END');
    expect(evidence).toContain('Evidence sampled');
  });

  it('samples file paths from both ends of a large change set', () => {
    const files = Array.from({ length: 120 }, (_, index) => `src/file-${index}.ts`);
    const selected = selectRepresentativeFiles(files, 20);

    expect(selected).toHaveLength(20);
    expect(selected[0]).toBe('src/file-0.ts');
    expect(selected.at(-1)).toBe('src/file-119.ts');
  });

  it('rejects oversized report input before provider processing', () => {
    const result = validateCommitReportInput(buildInput('x'.repeat(32_001)));

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('diffSummary');
  });

  it('bounds the complete prompt when every accepted metadata field is large', () => {
    const input: PromptInput = {
      ...buildInput('diff\n'.repeat(6_400)),
      message: 'message '.repeat(1_250),
      files: Array.from({ length: 2_000 }, (_, index) => `src/${index}-${'x'.repeat(2_030)}`),
      components: Array.from({ length: 200 }, (_, index) => `component-${index}-${'y'.repeat(240)}`),
    };

    const comprehensive = buildCommitReportComprehensivePrompt(input);
    const simple = buildCommitReportSimplePrompt(input);

    expect(comprehensive.length).toBeLessThan(50_000);
    expect(simple.length).toBeLessThan(18_000);
    expect(comprehensive).toContain('Now analyze the commit');
    expect(simple).toContain('Output ONLY valid JSON');
  });
});
