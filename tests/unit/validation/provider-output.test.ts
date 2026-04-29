import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseProviderOutput } from '../../../src/validation/providerOutput.js';
import { PromptInput, StepperRequest } from '../../../src/types.js';
import { createCommitReportRequest } from '../../../src/presets/commit-report/request.js';

const validCommitReportJson = JSON.stringify({
  title: 'Auth: Implement token rotation handling',
  summary: 'This commit updates authentication token handling to support safer rotation and prevent stale token usage across API calls. It also improves failure handling when refresh requests fail under transient network conditions.',
  changes: [
    'Added token rotation guard in auth middleware',
    'Updated refresh-token branch to invalidate stale sessions',
  ],
  rationale: 'Token reuse from stale sessions caused intermittent authorization failures and elevated support incidents. Rotation logic was added to enforce consistent token freshness and reduce auth drift.',
  impact_and_tests: 'Authentication middleware and session refresh flow are affected. Unit tests should verify stale-token invalidation and refresh retries; integration tests should confirm session continuity after rotation.',
  next_steps: [
    'Add integration test for token refresh race conditions',
    'Document auth token lifecycle in engineering handbook',
  ],
  tags: 'auth, security, backend, bugfix',
});

describe('parseProviderOutput', () => {
  it('uses commit-report validator for commit preset requests', () => {
    const commitInput: PromptInput = {
      userId: 'user-1',
      commitSha: 'abc123',
      repo: 'org/repo',
      message: 'fix: auth drift',
      files: ['src/auth.ts'],
      components: ['auth'],
      diffSummary: '+ token rotation checks',
    };

    const request = createCommitReportRequest(commitInput) as StepperRequest<PromptInput, unknown>;

    const result = parseProviderOutput(request, validCommitReportJson);
    expect(result.valid).toBe(true);
    expect((result.result as { tags: string }).tags).toContain('auth');
  });

  it('routes non-preset requests to text parser when responseMode is text', () => {
    const request: StepperRequest<{ body: string }, unknown> = {
      prompt: 'Summarize payload in one sentence.',
      payload: { body: 'alpha beta' },
      responseMode: 'text',
    };

    const result = parseProviderOutput(request, 'plain text output');
    expect(result.valid).toBe(true);
    expect(result.result).toBe('plain text output');
  });

  it('routes non-preset requests to json parser with optional schema validation', () => {
    const request: StepperRequest<unknown, { status: string }> = {
      prompt: 'Return status JSON',
      responseMode: 'json',
      outputSchema: {
        kind: 'zod',
        schema: z.object({
          status: z.string(),
        }),
      },
    };

    const result = parseProviderOutput(request, '{"status":"ok"}');
    expect(result.valid).toBe(true);
    expect(result.result).toEqual({ status: 'ok' });
  });
});
