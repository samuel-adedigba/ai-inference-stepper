import {
  CommitReportInput,
  CommitReportOutput,
  PromptBuilderInput,
  StepperRequest,
} from '../../types.js';
import { z } from 'zod';
import { isAllowedCallbackUrl } from '../../security/callbackUrls.js';

const COMMIT_REPORT_PRESET = 'commit-report';

const CallbackSchema = z.object({
  url: z.string().url().max(2_048).refine(
    isAllowedCallbackUrl,
    'Callback URL origin is not allowed'
  ),
  headers: z.record(z.string().max(2_048)).optional().refine(
    (headers) => !headers || Object.keys(headers).length <= 20,
    'Callback headers must not exceed 20 entries'
  ),
  continueOnFailure: z.boolean().optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(5),
    backoffMs: z.number().int().min(100).max(60_000),
  }).optional(),
});

export const CommitReportInputSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  commitSha: z.string().trim().min(1).max(64),
  repo: z.string().trim().min(1).max(255),
  message: z.string().trim().min(1).max(10_000),
  files: z.array(z.string().max(2_048)).max(2_000),
  components: z.array(z.string().max(256)).max(200),
  diffSummary: z.string().max(32_000),
  template: z.string().max(10_000).optional(),
  callbackUrl: z.string().url().max(2_048).refine(
    isAllowedCallbackUrl,
    'Callback URL origin is not allowed'
  ).optional(),
  callbacks: z.array(CallbackSchema).max(5).optional(),
});

export function validateCommitReportInput(input: unknown): {
  valid: true;
  input: CommitReportInput;
} | {
  valid: false;
  error: string;
} {
  const result = CommitReportInputSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.') || 'request';
    return { valid: false, error: `${field}: ${issue.message}` };
  }

  return { valid: true, input: result.data as CommitReportInput };
}

/**
 * Build a generic Stepper request from legacy CommitDiary-shaped input.
 *
 * Phase 1 compatibility notes:
 * - Prompt rendering is still handled by legacy prompt builders.
 * - We store the original commit payload so existing provider/orchestrator flow remains intact.
 */
export function createCommitReportRequest(
  input: CommitReportInput
): StepperRequest<CommitReportInput, CommitReportOutput> {
  const validation = validateCommitReportInput(input);
  if (!validation.valid) {
    throw new Error(`Invalid commit report input: ${validation.error}`);
  }
  const validatedInput = validation.input;
  const prompt: PromptBuilderInput<CommitReportInput> = {
    preset: COMMIT_REPORT_PRESET,
    template: validatedInput.template,
    payload: validatedInput,
  };

  return {
    requestId: `${validatedInput.userId}:${validatedInput.commitSha}`,
    prompt,
    payload: validatedInput,
    responseMode: 'json',
    callbacks: validatedInput.callbacks,
    metadata: {
      userId: validatedInput.userId,
      commitSha: validatedInput.commitSha,
      repo: validatedInput.repo,
    },
  };
}

/**
 * Type guard for generic requests that are carrying the commit-report preset.
 */
export function isCommitReportRequest(
  request: StepperRequest<unknown, unknown>
): request is StepperRequest<CommitReportInput, CommitReportOutput> {
  if (!request || typeof request !== 'object') {
    return false;
  }

  if (typeof request.prompt === 'object' && request.prompt !== null) {
    return request.prompt.preset === COMMIT_REPORT_PRESET;
  }

  return false;
}

/**
 * Compatibility extractor to feed existing PromptInput-based internals.
 */
export function toCommitReportInput(
  request: StepperRequest<unknown, unknown>
): CommitReportInput | null {
  if (!isCommitReportRequest(request)) {
    return null;
  }

  if (!request.payload || typeof request.payload !== 'object') {
    return null;
  }

  const validation = validateCommitReportInput(request.payload);
  return validation.valid ? validation.input : null;
}

export { COMMIT_REPORT_PRESET };
