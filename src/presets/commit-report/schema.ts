import { z } from 'zod';
import { CommitReportOutput } from '../../types.js';
import { parseJsonOutput } from '../../validation/json.js';

/**
 * CommitDiary-specific output schema.
 *
 * This intentionally lives under presets so package core can evolve toward
 * generic output contracts without coupling every runtime path to report fields.
 */
export const CommitReportOutputSchema = z.object({
  title: z.string()
    .min(10, 'Title must be at least 10 characters')
    .max(120, 'Title must not exceed 120 characters')
    .refine((val) => val.trim().length > 0, 'Title cannot be empty or whitespace only'),

  summary: z.string()
    .min(50, 'Summary must be at least 50 characters')
    .max(2000, 'Summary must not exceed 2000 characters'),

  changes: z.array(z.string().min(5, 'Each change must be at least 5 characters'))
    .min(1, 'At least one change must be listed')
    .max(50, 'Maximum 50 changes allowed'),

  rationale: z.string()
    .min(20, 'Rationale must be at least 20 characters')
    .max(2000, 'Rationale must not exceed 2000 characters'),

  impact_and_tests: z.string()
    .min(20, 'Impact and tests section must be at least 20 characters')
    .max(2000, 'Impact and tests section must not exceed 2000 characters'),

  next_steps: z.array(z.string().min(5, 'Each next step must be at least 5 characters'))
    .max(20, 'Maximum 20 next steps allowed'),

  tags: z.string()
    .max(200, 'Tags must not exceed 200 characters')
    .refine((val) => val.split(',').every(tag => tag.trim().length > 0), 'Tags must be comma-separated with no empty values'),
});

/**
 * CommitDiary preset validator wrapper.
 */
export function validateCommitReportOutput(data: unknown): {
  valid: boolean;
  result?: CommitReportOutput;
  error?: string;
} {
  try {
    const validated = CommitReportOutputSchema.parse(data);
    return { valid: true, result: validated as CommitReportOutput };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        error: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      };
    }

    return { valid: false, error: 'Unknown validation error' };
  }
}

/**
 * CommitDiary preset parser used by legacy adapter paths.
 */
export function parseAndValidateCommitReport(jsonString: string): {
  valid: boolean;
  result?: CommitReportOutput;
  error?: string;
} {
  return parseJsonOutput<CommitReportOutput>(jsonString, {
    kind: 'zod',
    schema: CommitReportOutputSchema,
  });
}
