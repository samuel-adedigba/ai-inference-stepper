import { StepperOutputSchema } from '../types.js';

type HttpJsonType = 'string' | 'number' | 'boolean' | 'array' | 'object';

type HttpJsonSchemaNode = {
  type: HttpJsonType;
  requiredKeys?: string[];
  properties?: Record<string, HttpJsonSchemaNode>;
  items?: HttpJsonSchemaNode;
  allowAdditionalKeys?: boolean;
  minItems?: number;
  maxItems?: number;
};

export type HttpJsonOutputSchemaInput = {
  kind: 'http-json';
  requiredKeys?: string[];
  properties?: Record<string, HttpJsonSchemaNode>;
  allowAdditionalKeys?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidKeyName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSchemaNode(value: unknown, path: string, depth = 0): { valid: true; node: HttpJsonSchemaNode } | { valid: false; error: string } {
  if (!isRecord(value) || !('type' in value)) {
    return { valid: false, error: `Invalid ${path}: expected an object with a type` };
  }

  const allowedTypes: HttpJsonType[] = ['string', 'number', 'boolean', 'array', 'object'];
  if (!allowedTypes.includes(value.type as HttpJsonType)) {
    return { valid: false, error: `Invalid ${path}.type: expected one of ${allowedTypes.join(', ')}` };
  }

  if (depth > 8) {
    return { valid: false, error: `Invalid ${path}: schema nesting is limited to 8 levels` };
  }

  const node: HttpJsonSchemaNode = { type: value.type as HttpJsonType };

  if (value.requiredKeys !== undefined) {
    if (!Array.isArray(value.requiredKeys) || !value.requiredKeys.every(isValidKeyName)) {
      return { valid: false, error: `Invalid ${path}.requiredKeys: expected array of non-empty strings` };
    }
    node.requiredKeys = value.requiredKeys;
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      return { valid: false, error: `Invalid ${path}.properties: expected object map` };
    }

    node.properties = {};
    for (const [key, child] of Object.entries(value.properties)) {
      if (!key.trim()) {
        return { valid: false, error: `Invalid ${path}.properties key: keys must be non-empty` };
      }
      const parsedChild = parseSchemaNode(child, `${path}.properties.${key}`, depth + 1);
      if (!parsedChild.valid) return parsedChild;
      node.properties[key] = parsedChild.node;
    }
  }

  if (value.items !== undefined) {
    const parsedItems = parseSchemaNode(value.items, `${path}.items`, depth + 1);
    if (!parsedItems.valid) return parsedItems;
    node.items = parsedItems.node;
  }

  if (node.type === 'array' && value.items === undefined) {
    // Array item validation is optional for backwards compatibility.
  }

  if (value.allowAdditionalKeys !== undefined) {
    if (typeof value.allowAdditionalKeys !== 'boolean') {
      return { valid: false, error: `Invalid ${path}.allowAdditionalKeys: expected boolean` };
    }
    node.allowAdditionalKeys = value.allowAdditionalKeys;
  }

  for (const field of ['minItems', 'maxItems'] as const) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || (value[field] as number) < 0)) {
      return { valid: false, error: `Invalid ${path}.${field}: expected a non-negative integer` };
    }
    if (value[field] !== undefined) node[field] = value[field] as number;
  }

  if (node.type !== 'array' && (node.items !== undefined || node.minItems !== undefined || node.maxItems !== undefined)) {
    return { valid: false, error: `Invalid ${path}: items and item limits are only valid for arrays` };
  }

  return { valid: true, node };
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

    const parsedProperties: Record<string, HttpJsonSchemaNode> = {};
    for (const [key, rule] of Object.entries(value.properties)) {
      const parsedRule = parseSchemaNode(rule, `outputSchema.properties.${key}`);
      if (!parsedRule.valid) return parsedRule;
      parsedProperties[key] = parsedRule.node;
    }
    value.properties = parsedProperties;
  }

  if (value.allowAdditionalKeys !== undefined && typeof value.allowAdditionalKeys !== 'boolean') {
    return { valid: false, error: 'Invalid outputSchema.allowAdditionalKeys: expected boolean' };
  }

  return {
    valid: true,
    schema: {
      kind: 'http-json',
      requiredKeys: value.requiredKeys as string[] | undefined,
      properties: value.properties as Record<string, HttpJsonSchemaNode> | undefined,
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

      return validateNode(value, {
        type: 'object',
        requiredKeys: schema.requiredKeys,
        properties: schema.properties,
        allowAdditionalKeys: schema.allowAdditionalKeys,
      }, 'result') as Record<string, unknown>;
    },
  };
}

function validateNode(value: unknown, schema: HttpJsonSchemaNode, path: string): unknown {
  const actualType = resolveValueType(value);
  if (actualType !== schema.type && !(path === 'result' && actualType === 'object')) {
    throw new Error(`Output schema validation failed: '${path}' expected type '${schema.type}' but received '${actualType}'`);
  }

  if (schema.type === 'array') {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) throw new Error(`Output schema validation failed: '${path}' has too few items`);
    if (schema.maxItems !== undefined && items.length > schema.maxItems) throw new Error(`Output schema validation failed: '${path}' has too many items`);
    if (schema.items) items.forEach((item, index) => validateNode(item, schema.items!, `${path}[${index}]`));
    return value;
  }

  if (schema.type === 'object') {
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.requiredKeys || []) {
      const keyPath = path === 'result' ? key : `${path}.${key}`;
      if (!(key in objectValue)) throw new Error(`Output schema validation failed: missing required key '${keyPath}'`);
    }
    if (schema.properties) {
      for (const [key, childSchema] of Object.entries(schema.properties)) {
        if (key in objectValue) validateNode(objectValue[key], childSchema, `${path}.${key}`);
      }
      if (schema.allowAdditionalKeys === false) {
        const allowedKeys = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(objectValue)) {
          const keyPath = path === 'result' ? key : `${path}.${key}`;
          if (!allowedKeys.has(key)) throw new Error(`Output schema validation failed: unexpected key '${keyPath}'`);
        }
      }
    }
  }

  return value;
}
