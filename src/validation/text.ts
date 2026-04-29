import { OutputParser } from '../types.js';
import { applyOutputSchema } from './outputSchema.js';

/**
 * Raw text output parser for generic generation use-cases.
 *
 * Schema behavior:
 * - without schema: returns raw text as-is
 * - with schema: validates/transforms the raw text through schema parser
 */
export const parseTextOutput: OutputParser<unknown> = (
  rawOutput: string,
  schema
) => {
  const validation = applyOutputSchema(rawOutput, schema);
  if (!validation.valid) {
    return validation;
  }

  return {
    valid: true,
    result: validation.result ?? rawOutput,
  };
};
