import { StepperOutputSchema } from '../types.js';
import { applyOutputSchema } from './outputSchema.js';

function normalizeValidationError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Output schema validation failed';
}

function extractLikelyJson(text: string): string {
  let cleaned = text.trim();

  // AI providers often wrap JSON in markdown fences; strip those first.
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
  cleaned = cleaned.replace(/^```\s*/i, '').replace(/```\s*$/, '');

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  return cleaned;
}

/**
 * Parse a raw provider string into JSON with optional caller-provided schema validation.
 *
 * Important runtime behavior:
 * - If no schema is provided, valid JSON is accepted as-is.
 * - This enables generic use cases where callers only want structural JSON parsing.
 */
export function parseJsonOutput<TOutput = unknown>(
  rawOutput: string,
  schema?: StepperOutputSchema<TOutput>
): { valid: boolean; result?: TOutput; error?: string } {
  const trimmed = rawOutput.trim();

  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<')) {
    return {
      valid: false,
      error: 'Received HTML response instead of JSON. This usually indicates an authentication error, rate limiting, or provider service issue.',
    };
  }

  const cleaned = extractLikelyJson(trimmed);
  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
    return {
      valid: false,
      error: 'Response does not appear to be valid JSON format. Provider may have returned an error message.',
    };
  }

  try {
    const parsed = JSON.parse(cleaned);
    const validation = applyOutputSchema(parsed, schema);
    if (!validation.valid) {
      return {
        valid: false,
        error: normalizeValidationError(validation.error),
      };
    }

    return validation;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        valid: false,
        error: `Invalid JSON format: ${error.message}. This often happens when the AI provider returns an error page instead of JSON response.`,
      };
    }

    return { valid: false, error: 'Failed to parse JSON response' };
  }
}
