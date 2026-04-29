import { StepperOutputSchema } from '../types.js';

type HttpJsonType = 'string' | 'number' | 'boolean' | 'array' | 'object';

type HttpJsonPropertyRule = {
  type: HttpJsonType;
};

export type HttpJsonOutputSchemaInput = {
  kind: 'http-json';
  requiredKeys?: string[];
  properties?: Record<string, HttpJsonPropertyRule>;
  allowAdditionalKeys?: boolean;
};

// TODO: edge case — nested property rules are intentionally out of scope in this DSL.
// Use package runtime `zod/custom` schema APIs when deep structural validation is required.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidKeyName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveValueType(value: unknown): HttpJsonType | 'null' {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    return 'object';
  }

  if (typeof value === 'string') {
    return 'string';
  }

  if (typeof value === 'number') {
    return 'number';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  return 'null';
}

/**
 * Validate and normalize HTTP-transportable schema DSL.
 *
 * Why this exists:
 * - HTTP clients cannot safely send runtime function/zod instances.
 * - We still need a deterministic schema contract for `/v1/generate*` callers.
 */
export function parseHttpOutputSchemaInput(
  value: unknown
): { valid: true; schema: HttpJsonOutputSchemaInput } | { valid: false; error: string } {
  if (!isRecord(value)) {
    return { valid: false, error: 'Invalid outputSchema: expected object' };
  }

  if (value.kind !== 'http-json') {
    return { valid: false, error: "Invalid outputSchema.kind: expected 'http-json' for HTTP transport" };
  }

  if (value.requiredKeys !== undefined) {
    if (!Array.isArray(value.requiredKeys) || !value.requiredKeys.every(isValidKeyName)) {
      return { valid: false, error: 'Invalid outputSchema.requiredKeys: expected array of non-empty strings' };
    }
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      return { valid: false, error: 'Invalid outputSchema.properties: expected object map' };
    }

    for (const [key, rule] of Object.entries(value.properties)) {
      if (!key.trim()) {
        return { valid: false, error: 'Invalid outputSchema.properties key: keys must be non-empty' };
      }

      if (!isRecord(rule) || !('type' in rule)) {
        return { valid: false, error: `Invalid outputSchema.properties.${key}: missing 'type'` };
      }

      const allowedTypes: HttpJsonType[] = ['string', 'number', 'boolean', 'array', 'object'];
      if (!allowedTypes.includes(rule.type as HttpJsonType)) {
        return {
          valid: false,
          error: `Invalid outputSchema.properties.${key}.type: expected one of ${allowedTypes.join(', ')}`,
        };
      }
    }
  }

  if (value.allowAdditionalKeys !== undefined && typeof value.allowAdditionalKeys !== 'boolean') {
    return { valid: false, error: 'Invalid outputSchema.allowAdditionalKeys: expected boolean' };
  }

  return {
    valid: true,
    schema: {
      kind: 'http-json',
      requiredKeys: value.requiredKeys as string[] | undefined,
      properties: value.properties as Record<string, HttpJsonPropertyRule> | undefined,
      allowAdditionalKeys: value.allowAdditionalKeys as boolean | undefined,
    },
  };
}

/**
 * Convert HTTP schema DSL to runtime StepperOutputSchema.
 */
export function toRuntimeOutputSchemaFromHttp(
  schema: HttpJsonOutputSchemaInput
): StepperOutputSchema<unknown> {
  return {
    kind: 'custom',
    parse: (value: unknown) => {
      if (!isRecord(value) || Array.isArray(value)) {
        throw new Error('Output schema validation failed: expected JSON object result');
      }

      const normalized = value as Record<string, unknown>;

      for (const key of schema.requiredKeys || []) {
        if (!(key in normalized)) {
          throw new Error(`Output schema validation failed: missing required key '${key}'`);
        }
      }

      if (schema.properties) {
        for (const [key, rule] of Object.entries(schema.properties)) {
          if (!(key in normalized)) {
            continue;
          }

          const actualType = resolveValueType(normalized[key]);
          if (actualType !== rule.type) {
            throw new Error(
              `Output schema validation failed: key '${key}' expected type '${rule.type}' but received '${actualType}'`
            );
          }
        }

        if (schema.allowAdditionalKeys === false) {
          const allowedKeys = new Set(Object.keys(schema.properties));
          for (const key of Object.keys(normalized)) {
            if (!allowedKeys.has(key)) {
              throw new Error(`Output schema validation failed: unexpected key '${key}'`);
            }
          }
        }
      }

      return normalized;
    },
  };
}
