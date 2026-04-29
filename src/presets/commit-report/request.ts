import {
  CommitReportInput,
  CommitReportOutput,
  PromptBuilderInput,
  StepperRequest,
} from '../../types.js';

const COMMIT_REPORT_PRESET = 'commit-report';

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
  const prompt: PromptBuilderInput<CommitReportInput> = {
    preset: COMMIT_REPORT_PRESET,
    template: input.template,
    payload: input,
  };

  return {
    requestId: `${input.userId}:${input.commitSha}`,
    prompt,
    payload: input,
    responseMode: 'json',
    callbacks: input.callbacks,
    metadata: {
      userId: input.userId,
      commitSha: input.commitSha,
      repo: input.repo,
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

  const payload = request.payload as Partial<CommitReportInput>;

  // Guard required fields to avoid passing malformed generic requests into legacy paths.
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.commitSha !== 'string' ||
    typeof payload.repo !== 'string' ||
    typeof payload.message !== 'string' ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.components) ||
    typeof payload.diffSummary !== 'string'
  ) {
    return null;
  }

  return {
    userId: payload.userId,
    commitSha: payload.commitSha,
    repo: payload.repo,
    message: payload.message,
    files: payload.files,
    components: payload.components,
    diffSummary: payload.diffSummary,
    template: payload.template,
    callbacks: payload.callbacks,
  };
}

export { COMMIT_REPORT_PRESET };
