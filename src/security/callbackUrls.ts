type CallbackEnvironment = Record<string, string | undefined>;

function configuredOrigins(environment: CallbackEnvironment): Set<string> {
  const candidates = [
    environment.API_URL,
    ...(environment.CALLBACK_ALLOWED_ORIGINS || '').split(','),
  ];
  const origins = new Set<string>();

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;

    try {
      origins.add(new URL(value).origin);
    } catch {
      // Invalid configuration is ignored so production fails closed below.
    }
  }

  return origins;
}

/** Restrict production callbacks to explicitly configured service origins. */
export function isAllowedCallbackUrl(
  value: string,
  environment: CallbackEnvironment = process.env,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

    if (environment.NODE_ENV !== 'production') return true;
    return configuredOrigins(environment).has(url.origin);
  } catch {
    return false;
  }
}

export function getCallbackLogOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid-callback-url';
  }
}
