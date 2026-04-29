import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJsonOutput } from '../../../src/validation/json.js';
import { parseTextOutput } from '../../../src/validation/text.js';
import { parseZodOutput } from '../../../src/validation/zod.js';

describe('Output Parsers', () => {
  it('should parse plain text output', () => {
    const output = parseTextOutput('hello world');

    expect(output.valid).toBe(true);
    expect(output.result).toBe('hello world');
  });

  it('should validate text output with zod schema when provided', () => {
    const output = parseTextOutput(
      'hello world',
      {
        kind: 'zod',
        schema: z.string().min(3),
      }
    );

    expect(output.valid).toBe(true);
    expect(output.result).toBe('hello world');
  });

  it('should fail text output when schema validation fails', () => {
    const output = parseTextOutput(
      'no',
      {
        kind: 'zod',
        schema: z.string().min(3),
      }
    );

    expect(output.valid).toBe(false);
    expect(output.error).toBeDefined();
  });

  it('should parse JSON output without schema', () => {
    const output = parseJsonOutput<{ message: string }>('{"message":"ok"}');

    expect(output.valid).toBe(true);
    expect(output.result).toEqual({ message: 'ok' });
  });

  it('should parse JSON output with zod schema when provided', () => {
    const output = parseJsonOutput<{ message: string }>(
      '{"message":"ok"}',
      {
        kind: 'zod',
        schema: z.object({ message: z.string() }),
      }
    );

    expect(output.valid).toBe(true);
    expect(output.result).toEqual({ message: 'ok' });
  });

  it('should fail JSON output when schema fails', () => {
    const output = parseJsonOutput<{ count: number }>(
      '{"count":"not-number"}',
      {
        kind: 'zod',
        schema: z.object({ count: z.number() }),
      }
    );

    expect(output.valid).toBe(false);
    expect(output.error).toBeDefined();
  });

  it('should parse fenced json output', () => {
    const output = parseJsonOutput<{ ok: boolean }>('```json\n{"ok":true}\n```');

    expect(output.valid).toBe(true);
    expect(output.result).toEqual({ ok: true });
  });

  it('should reject html responses in json mode', () => {
    const output = parseJsonOutput('<html><body>unauthorized</body></html>');

    expect(output.valid).toBe(false);
    expect(output.error).toContain('HTML response');
  });

  it('should validate unknown payloads via parseZodOutput', () => {
    const output = parseZodOutput(z.object({ id: z.string() }), { id: 'abc' });

    expect(output.valid).toBe(true);
    expect(output.result).toEqual({ id: 'abc' });
  });
});
