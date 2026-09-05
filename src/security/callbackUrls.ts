type CallbackEnvironment = Record<string, string | undefined>;

function allowsInsecureLocalCallbacks(environment: CallbackEnvironment): boolean {
  return environment.NODE_ENV === 'test'
    || (environment.NODE_ENV === 'development' && environment.ALLOW_INSECURE_DEV === 'true');
}

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

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

/** Restrict production callbacks to explicitly configured service origins. */
export function isAllowedCallbackUrl(
  value: string,
  environment: CallbackEnvironment = process.env,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password || isPrivateHost(url.hostname)) return false;

    if (allowsInsecureLocalCallbacks(environment)) return true;
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
