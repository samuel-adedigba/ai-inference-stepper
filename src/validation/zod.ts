import { z, ZodType } from 'zod';

/**
 * Parse unknown data through an explicit zod schema.
 */
export function parseZodOutput<TOutput>(schema: ZodType<TOutput>, value: unknown): {
  valid: boolean;
  result?: TOutput;
  error?: string;
} {
  try {
    return { valid: true, result: schema.parse(value) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        error: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      };
    }

    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown zod validation error',
    };
  }
}
