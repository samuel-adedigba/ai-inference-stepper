import { StepperOutputSchema } from '../types.js';

/**
 * Apply a runtime output schema to already-parsed content.
 */
export function applyOutputSchema<TOutput>(
  parsed: unknown,
  schema?: StepperOutputSchema<TOutput>
): { valid: boolean; result?: TOutput; error?: string } {
  if (!schema) {
    return { valid: true, result: parsed as TOutput };
  }

  try {
    if (schema.kind === 'zod') {
      return { valid: true, result: schema.schema.parse(parsed) };
    }

    return { valid: true, result: schema.parse(parsed) };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Output schema validation failed',
    };
  }
}
