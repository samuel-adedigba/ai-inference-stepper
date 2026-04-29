export type PathKey = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNested(value: unknown, path: PathKey[]): unknown {
  let current: unknown = value;

  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current) || current.length <= key) {
        return undefined;
      }
      current = current[key];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

export function getStringAtPath(value: unknown, path: PathKey[]): string | undefined {
  const result = getNested(value, path);
  return typeof result === 'string' ? result : undefined;
}

/**
 * Require a text field in provider responses.
 *
 * Keeping this helper centralized makes parse behavior consistent across all
 * providers and prevents subtle differences in response validation rules.
 */
export function requireStringAtPath(value: unknown, path: PathKey[], errorMessage: string): string {
  const result = getStringAtPath(value, path);
  if (!result) {
    throw new Error(errorMessage);
  }

  return result;
}
