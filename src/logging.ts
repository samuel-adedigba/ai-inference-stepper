import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Base pino logger instance with structured logging
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
    : undefined,
  base: {
    service: 'stepper',
    env: process.env.NODE_ENV || 'development',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.token',
      'req.body.password',
      'req.body.apiKey',
      'input.token',
      'config.providers[*].apiKeyEnvVar', // Don't log env var names if they contain secrets (unlikely but safe)
      'context.input.token',
      'error.config.headers.Authorization', // Redact axios/fetch error headers
      'context.tokens',
    ],
    remove: true
  }
});

/**
 * Create a child logger with additional context (e.g., jobId, requestId)
 */
export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}