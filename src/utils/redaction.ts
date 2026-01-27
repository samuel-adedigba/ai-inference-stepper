/**
 * Redact sensitive information from text before sending to AI providers
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let redacted = text;

  // AWS access keys
  redacted = redacted.replace(/(A?KIA|AKIA)[A-Z0-9]{16}/g, '[REDACTED_AWS_KEY]');

  // Generic API keys and tokens (common patterns)
  redacted = redacted.replace(/[a-zA-Z0-9_-]{32,}/g, (match) => {
    // Don't redact commit SHAs (typically 40 chars) or very long base64
    if (match.length === 40 || match.length > 200) return match;
    return '[REDACTED_TOKEN]';
  });

  // Password/secret assignments in env-style
  redacted = redacted.replace(
    /(password|passwd|secret|api_key|apikey|token|auth)(\s*[:=]\s*)(\S+)/gi,
    '$1$2[REDACTED]'
  );

  // Email addresses
  redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');

  // Base64 encoded secrets (long base64 strings)
  redacted = redacted.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, '[REDACTED_BASE64]');

  return redacted;
}

/**
 * Redact sensitive fields from an object
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = { ...obj };
  const sensitiveKeys = ['apiKey', 'api_key', 'token', 'password', 'secret', 'authorization'];

  for (const key of Object.keys(result)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (typeof result[key] === 'string') {
      result[key] = redactSecrets(result[key] as string);
    }
  }

  return result as T;
}