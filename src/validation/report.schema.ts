import { z } from 'zod';
import { ReportOutput } from '../types.js';

/**
 * Comprehensive Zod schema for validating AI-generated report output
 * with detailed error messages
 */
export const ReportOutputSchema = z.object({
  title: z.string()
    .min(10, 'Title must be at least 10 characters')
    .max(120, 'Title must not exceed 120 characters')
    .refine(
      (val) => val.trim().length > 0,
      'Title cannot be empty or whitespace only'
    ),

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
    .refine(
      (val) => val.split(',').every(tag => tag.trim().length > 0),
      'Tags must be comma-separated with no empty values'
    ),
});

/**
 * Validate report output against schema
 */
export function validateReportOutput(data: unknown): {
  valid: boolean;
  result?: ReportOutput;
  error?: string;
} {
  try {
    const validated = ReportOutputSchema.parse(data);
    return { valid: true, result: validated as ReportOutput };
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
 * Safely parse JSON and validate
 */
export function parseAndValidateReport(jsonString: string): {
  valid: boolean;
  result?: ReportOutput;
  error?: string;
} {
  try {
    // Clean up common AI model output issues
    let cleaned = jsonString.trim();

    // Remove markdown code blocks if present
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/```\s*$/, '');

    // Remove any leading/trailing text that isn't JSON
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }

    const parsed = JSON.parse(cleaned);
    return validateReportOutput(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { valid: false, error: `Invalid JSON: ${error.message}` };
    }
    return { valid: false, error: 'Failed to parse JSON' };
  }
}