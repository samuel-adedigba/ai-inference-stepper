import { PromptInput, ReportOutput, StepperResponseMode } from '../types.js';
import { generateCommitReportFallback } from '../presets/commit-report/fallback.js';

/**
 * Generic fallback payload for non-preset flows.
 */
export function generateGenericFallback(responseMode: StepperResponseMode = 'json'): unknown {
  if (responseMode === 'text') {
    return 'Generation could not be completed because all configured providers failed. Retry later.';
  }

  return {
    error: 'GENERATION_FAILED',
    message: 'Generation could not be completed because all configured providers failed.',
    retryable: true,
  };
}

/**
 * Legacy commit-report fallback wrapper.
 *
 * Commit-specific fallback ownership now lives in presets/commit-report.
 * This wrapper is preserved to avoid abrupt breakage for existing imports.
 */
export function generateTemplateFallback(input: PromptInput): ReportOutput {
  return generateCommitReportFallback(input);
}
