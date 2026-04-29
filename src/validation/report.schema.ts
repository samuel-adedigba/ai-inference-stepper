import {
  CommitReportOutputSchema,
  parseAndValidateCommitReport,
  validateCommitReportOutput,
} from '../presets/commit-report/schema.js';

/**
 * Legacy compatibility exports for existing import paths.
 *
 * Source-of-truth now lives in `presets/commit-report/schema.ts` because
 * commit reports are a preset, not the package-wide generic contract.
 */
export const ReportOutputSchema = CommitReportOutputSchema;

export const validateReportOutput = validateCommitReportOutput;

export const parseAndValidateReport = parseAndValidateCommitReport;
