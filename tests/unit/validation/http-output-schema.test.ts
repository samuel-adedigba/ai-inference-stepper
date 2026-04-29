import { describe, it, expect } from 'vitest';
import {
  parseHttpOutputSchemaInput,
  toRuntimeOutputSchemaFromHttp,
} from '../../../src/validation/httpOutputSchema.js';

describe('HTTP output schema DSL', () => {
  it('parses a valid transport schema', () => {
    const parsed = parseHttpOutputSchemaInput({
      kind: 'http-json',
      requiredKeys: ['summary'],
      properties: {
        summary: { type: 'string' },
        score: { type: 'number' },
      },
      allowAdditionalKeys: true,
    });

    expect(parsed.valid).toBe(true);
  });

  it('rejects unsupported kind', () => {
    const parsed = parseHttpOutputSchemaInput({ kind: 'zod' });

    expect(parsed.valid).toBe(false);
    if (!parsed.valid) {
      expect(parsed.error).toContain("expected 'http-json'");
    }
  });

  it('validates runtime output with required keys and property types', () => {
    const parsed = parseHttpOutputSchemaInput({
      kind: 'http-json',
      requiredKeys: ['summary'],
      properties: {
        summary: { type: 'string' },
        tags: { type: 'array' },
      },
      allowAdditionalKeys: false,
    });

    if (!parsed.valid) {
      throw new Error(parsed.error);
    }

    const runtimeSchema = toRuntimeOutputSchemaFromHttp(parsed.schema);

    if (runtimeSchema.kind !== 'custom') {
      throw new Error('Expected custom runtime schema');
    }

    expect(runtimeSchema.parse({ summary: 'ok', tags: ['a', 'b'] })).toEqual({
      summary: 'ok',
      tags: ['a', 'b'],
    });

    expect(() => runtimeSchema.parse({ tags: ['a'] })).toThrow("missing required key 'summary'");
    expect(() => runtimeSchema.parse({ summary: 42, tags: ['a'] })).toThrow("expected type 'string'");
    expect(() => runtimeSchema.parse({ summary: 'ok', tags: ['a'], extra: true })).toThrow("unexpected key 'extra'");
  });
});
