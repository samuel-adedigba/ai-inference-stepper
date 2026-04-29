import { StepperRequest } from '../types.js';
import { parseJsonOutput } from './json.js';
import { parseTextOutput } from './text.js';
import { parseAndValidateCommitReport } from '../presets/commit-report/schema.js';
import { isCommitReportRequest } from '../presets/commit-report/request.js';

/**
 * Route provider raw output parsing based on request contract.
 *
 * Important behavior for contributors:
 * - commit-report preset requests must continue using strict commit report
 *   validation to preserve CommitDiary behavior.
 * - Generic requests use responseMode-driven parsing:
 *   - text => raw text passthrough
 *   - json => JSON parsing + optional caller schema validation
 */
export function parseProviderOutput(
  request: StepperRequest<unknown, unknown>,
  rawOutput: string
): { valid: boolean; result?: unknown; error?: string } {
  if (isCommitReportRequest(request)) {
    return parseAndValidateCommitReport(rawOutput);
  }

  if (request.responseMode === 'text') {
    return parseTextOutput(rawOutput, request.outputSchema);
  }

  return parseJsonOutput(rawOutput, request.outputSchema);
}
