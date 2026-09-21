// packages/stepper/src/server/app.ts

import express, { Request, Response, NextFunction, Application } from 'express';
import { createHash } from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { enqueueReport, enqueueRequest, generateReport, generateRequest, getJob, healthcheck, deleteReport, PromptInput, StepperRequest } from '../index.js';
import { enqueueBatchJob } from '../queue/producer.js';
import { getReportCache } from '../cache/redisCache.js';
import { getMetrics } from '../metrics/metrics.js';
import { config } from '../config.js';
import { logger } from '../logging.js';
import { JobFailure, STEPPER_HTTP_CONTRACT_VERSION, StepperBatchRequest } from '../types.js';
import { handleCommitReportWebhook } from '../presets/commit-report/webhookEndpoint.js';
import { toCommitReportInput, validateCommitReportInput } from '../presets/commit-report/request.js';
import { parseHttpOutputSchemaInput, toRuntimeOutputSchemaFromHttp } from '../validation/httpOutputSchema.js';
import { validateBatchEnvelope } from '../validation/batch.js';
import { getRateLimitRedisClient, RedisRateLimitStore } from './redisRateLimitStore.js';

const app: Application = express();
const MAX_HTTP_REQUEST_BYTES = 1_000_000;
const MAX_CALLBACKS = 5;
const MAX_CALLBACK_HEADER_LENGTH = 512;

// Trust proxy for proper IP detection behind reverse proxies (nginx, ELB, etc.)
// Set to 1 for single proxy, true for any proxy, or specific IPs for security
if (process.env.TRUST_PROXY) {
  const trustProxy = process.env.TRUST_PROXY === 'true' ? true : parseInt(process.env.TRUST_PROXY, 10) || process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy);
  logger.info({ trustProxy }, 'Trust proxy configured');
}

/**
 * 1. Helmet - Security headers (XSS protection, clickjacking prevention, etc.)
 */
if (config.security.helmet.enabled) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false, // Disable for API compatibility
  }));
  logger.info('Helmet security headers enabled');
}

/**
 * 2. CORS - Cross-Origin Resource Sharing protection
 */
if (config.security.cors.enabled) {
  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      const allowedOrigins = config.security.cors.allowedOrigins;

      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) {
        return callback(null, true);
      }

      // If wildcard is allowed, accept all origins
      if (allowedOrigins.includes('*')) {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Origin not allowed
      logger.warn({ origin }, 'CORS: Origin not allowed');
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: config.security.cors.allowCredentials,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', config.security.apiKey.headerName, 'X-Request-ID'],
    maxAge: 86400, // Cache preflight for 24 hours
  };

  app.use(cors(corsOptions));
  logger.info({ origins: config.security.cors.allowedOrigins }, 'CORS protection enabled');
}


// 3. Rate Limiting - Prevent abuse and DDoS attacks


// IP-based rate limiter
if (config.security.rateLimit.enabled) {
  const ipRateLimiter = rateLimit({
    windowMs: config.security.rateLimit.windowMs,
    max: config.security.rateLimit.maxRequests,
    store: new RedisRateLimitStore(),
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false, // Disable X-RateLimit headers
    skip: (req) => {
      // Skip rate limiting for health endpoints if configured
      if (config.security.rateLimit.skipHealthEndpoints) {
        return req.path === '/health' || req.path === '/metrics' || req.path === '/';
      }
      return false;
    },
    handler: (req, res) => {
      logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded (IP)');
      res.status(429).json({
        error: 'Too many requests',
        message: 'You have exceeded the rate limit. Please try again later.',
        retryAfter: Math.ceil(config.security.rateLimit.windowMs / 1000),
      });
    },
    // Note: Using default keyGenerator which handles IPv6 properly
    // If behind a proxy, set app.set('trust proxy', 1) before this middleware
  });

  app.use(ipRateLimiter);
  logger.info({
    windowMs: config.security.rateLimit.windowMs,
    maxRequests: config.security.rateLimit.maxRequests,
  }, 'IP-based rate limiting enabled');
}

// User-based rate limiting middleware (applied to /v1 routes)
const userRateLimiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!config.security.rateLimit.enabled) {
    next();
    return;
  }

  const rateLimitKey = extractRateLimitKey(req);
  if (!rateLimitKey) {
    next();
    return;
  }

  const now = Date.now();
  const windowMs = config.security.rateLimit.windowMs;
  const maxPerUser = config.security.rateLimit.maxRequestsPerUser;

  // Charge batch requests by item count so one HTTP call cannot bypass the
  // consumer capacity limit with many upstream provider calls.
  const requestWeight = req.path === '/v1/generate/batch' && Array.isArray(req.body?.items)
    ? Math.max(1, Math.min(req.body.items.length, config.batch.maxItems))
    : 1;

  try {
    // Hash caller-controlled identifiers before using them in Redis keys.
    const digest = createHash('sha256').update(rateLimitKey).digest('hex');
    const bucket = Math.floor(now / windowMs);
    const redisKey = `${config.redis.keyPrefix}rate-limit:user:${digest}:${bucket}`;
    const redis = getRateLimitRedisClient();
    const count = await redis.incrby(redisKey, requestWeight);
    if (count === requestWeight) {
      await redis.pexpire(redisKey, windowMs);
    }

    if (count > maxPerUser) {
      const ttl = await redis.pttl(redisKey);
      logger.warn({ rateLimitKey, count, path: req.path }, 'Rate limit exceeded (User/Tenant)');
      res.status(429).json({
        error: 'Too many requests',
        message: 'You have exceeded the request rate limit. Please try again later.',
        retryAfter: Math.ceil((ttl > 0 ? ttl : windowMs) / 1000),
      });
      return;
    }
  } catch {
    // Do not fail open when the shared limiter cannot be reached.
    logger.error({ errorCode: 'DISTRIBUTED_RATE_LIMIT_UNAVAILABLE', path: req.path }, 'Distributed user rate limiter unavailable');
    res.status(503).json({ error: 'Rate limiter unavailable', message: 'Please retry shortly.' });
    return;
  }

  next();
};

//4. API Key Authentication - Protect endpoints from unauthorized access
const apiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!config.security.apiKey.enabled) {
    return next();
  }

  // Skip health endpoints if configured
  if (config.security.apiKey.skipHealthEndpoints) {
    if (req.path === '/health' || req.path === '/metrics' || req.path === '/') {
      return next();
    }
  }

  const headerName = config.security.apiKey.headerName;
  const providedHeader = req.headers[headerName];
  const providedKey = typeof providedHeader === 'string' ? providedHeader : null;
  const validKey = process.env.STEPPER_API_KEY;

  if (!validKey) {
    logger.error('API_KEY_ENABLED is true but STEPPER_API_KEY is not set!');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!providedKey) {
    logger.warn({ path: req.path, ip: req.ip }, 'Missing API key');
    return res.status(401).json({
      error: 'Unauthorized',
      message: `Missing API key. Include it in the '${headerName}' header.`,
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedKey, validKey)) {
    logger.warn({ path: req.path, ip: req.ip }, 'Invalid API key');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key.',
    });
  }

  next();
};

// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLegacyCommitInput(input: unknown): string | null {
  const result = validateCommitReportInput(input);
  return result.valid ? null : result.error;
}

type GenericRequestValidation =
  | { valid: true; request: StepperRequest<unknown, unknown> }
  | { valid: false; error: string; errorCode?: string; supportedVersion?: string };

function validateGenericRequest(request: unknown): GenericRequestValidation {
  if (!isRecord(request)) {
    return { valid: false, error: 'Request body must be an object' };
  }

  if (!('prompt' in request)) {
    return { valid: false, error: 'Missing required field: prompt' };
  }

  const prompt = request.prompt;
  const promptIsValid =
    typeof prompt === 'string' ||
    (isRecord(prompt) && (prompt.preset === undefined || typeof prompt.preset === 'string'));
  if (!promptIsValid) {
    return { valid: false, error: 'Invalid prompt: expected string or preset prompt object' };
  }
  if (typeof prompt === 'string' && prompt.length > 100_000) {
    return { valid: false, error: 'Prompt is too large' };
  }

  try {
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_HTTP_REQUEST_BYTES) {
      return { valid: false, error: 'Request payload is too large' };
    }
  } catch {
    return { valid: false, error: 'Request payload is invalid' };
  }

  if (request.responseMode !== undefined && request.responseMode !== 'json' && request.responseMode !== 'text') {
    return { valid: false, error: "Invalid responseMode: expected 'json' or 'text'" };
  }

  if (request.contractVersion !== undefined && request.contractVersion !== STEPPER_HTTP_CONTRACT_VERSION) {
    return {
      valid: false,
      error: 'Request contract version is not supported',
      errorCode: 'SCHEMA_VERSION_MISMATCH',
      supportedVersion: STEPPER_HTTP_CONTRACT_VERSION,
    };
  }

  if (request.cacheControl !== undefined && !['default', 'no-cache', 'refresh'].includes(request.cacheControl as string)) {
    return { valid: false, error: "Invalid cacheControl: expected 'default', 'no-cache', or 'refresh'" };
  }

  for (const field of ['preferredProviders', 'excludeProviders'] as const) {
    if (request[field] !== undefined && (!Array.isArray(request[field]) || request[field].length > 20 || !request[field].every((name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 100))) {
      return { valid: false, error: `Invalid ${field}: expected an array of non-empty provider names` };
    }
  }

  for (const field of ['tenantId', 'requestId', 'cacheKey'] as const) {
    if (request[field] !== undefined && (typeof request[field] !== 'string' || request[field].length > 256)) {
      return { valid: false, error: `Invalid ${field}: expected a string up to 256 characters` };
    }
  }

  const normalizedRequest: StepperRequest<unknown, unknown> = {
    ...(request as unknown as StepperRequest<unknown, unknown>),
  };

  if (request.outputSchema !== undefined) {
    const parsedSchema = parseHttpOutputSchemaInput(request.outputSchema);
    if (!parsedSchema.valid) {
      return { valid: false, error: parsedSchema.error };
    }

    if (request.responseMode === 'text') {
      return {
        valid: false,
        error: "outputSchema is only supported when responseMode is 'json'",
      };
    }

    // Convert transport-safe DSL to runtime parser contract expected by generic pipeline.
    normalizedRequest.outputSchema = toRuntimeOutputSchemaFromHttp(parsedSchema.schema);
    normalizedRequest.responseMode = 'json';
  }

  if (request.providers !== undefined) {
    // Provider configs can contain API keys and arbitrary base URLs. They are
    // valid for the in-process library API, but never accepted from HTTP JSON.
    return { valid: false, error: 'Provider configuration is not accepted over HTTP' };
  }

  if (request.callbacks !== undefined) {
    if (!Array.isArray(request.callbacks) || request.callbacks.length > MAX_CALLBACKS) {
      return { valid: false, error: `Invalid callbacks: expected at most ${MAX_CALLBACKS} entries` };
    }
    for (const callback of request.callbacks) {
      if (!isRecord(callback) || typeof callback.url !== 'string' || callback.url.length > 2048) {
        return { valid: false, error: 'Invalid callback: expected a URL up to 2048 characters' };
      }
      if (callback.headers !== undefined) {
        if (!isRecord(callback.headers) || Object.keys(callback.headers).length > 20
          || Object.values(callback.headers).some((value) => typeof value !== 'string' || value.length > MAX_CALLBACK_HEADER_LENGTH)) {
          return { valid: false, error: 'Invalid callback headers' };
        }
      }
      if (callback.retry !== undefined) {
        const retry = callback.retry;
        const maxAttempts = isRecord(retry) ? retry.maxAttempts : undefined;
        const backoffMs = isRecord(retry) ? retry.backoffMs : undefined;
        if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5
          || typeof backoffMs !== 'number' || !Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 60_000) {
          return { valid: false, error: 'Invalid callback retry settings' };
        }
      }
    }
  }

  return { valid: true, request: normalizedRequest };
}

function validateBatchRequest(value: unknown):
  | { valid: true; batch: StepperBatchRequest }
  | { valid: false; error: string; errorCode?: string; supportedVersion?: string } {
  if (isRecord(value) && value.contractVersion !== undefined && value.contractVersion !== STEPPER_HTTP_CONTRACT_VERSION) {
    return {
      valid: false,
      error: 'Request contract version is not supported',
      errorCode: 'SCHEMA_VERSION_MISMATCH',
      supportedVersion: STEPPER_HTTP_CONTRACT_VERSION,
    };
  }

  const envelope = validateBatchEnvelope(value, {
    maxItems: config.batch.maxItems,
    maxConcurrency: config.batch.maxConcurrency,
  });
  if (!envelope.valid) {
    return envelope;
  }

  const items = [];
  for (let index = 0; index < envelope.batch.items.length; index += 1) {
    const rawItem = envelope.batch.items[index];
    const validation = validateGenericRequest(rawItem.request);
    if (!validation.valid) {
      return { valid: false, error: `Invalid items[${index}].request: ${validation.error}`, errorCode: validation.errorCode, supportedVersion: validation.supportedVersion };
    }

    items.push({
      id: rawItem.id,
      request: {
        ...validation.request,
        tenantId: validation.request.tenantId || envelope.batch.tenantId,
        requestId: validation.request.requestId || `${envelope.batch.requestId || 'batch'}:${rawItem.id}`,
      },
    });
  }

  return {
    valid: true,
    batch: {
      tenantId: envelope.batch.tenantId,
      requestId: envelope.batch.requestId,
      items,
      concurrency: envelope.batch.concurrency,
    },
  };
}

function extractRateLimitKey(req: Request): string | null {
  // A caller-controlled tenant/user field is not an identity boundary: changing
  // it must not create a fresh quota bucket. Bind the quota to the credential.
  if (!config.security.apiKey.enabled) return null;
  const providedKey = req.headers[config.security.apiKey.headerName];
  if (typeof providedKey !== 'string' || providedKey.length === 0) return null;
  return `api-key:${createHash('sha256').update(providedKey).digest('hex')}`;
}

function getApiKeyOwnerKey(req: Request): string | undefined {
  if (!config.security.apiKey.enabled) return undefined;
  const providedKey = req.headers[config.security.apiKey.headerName];
  return typeof providedKey === 'string' && providedKey.length > 0
    ? createHash('sha256').update(providedKey).digest('hex')
    : undefined;
}

// API ROUTES

/**
 * POST /webhook/report-completion
 * Webhook endpoint for report completion notifications
 * This endpoint bypasses API key auth but uses webhook signature verification
 */
app.post('/webhook/report-completion', express.json({ limit: MAX_HTTP_REQUEST_BYTES }), async (req: Request, res: Response, next: NextFunction) => {
  return handleCommitReportWebhook(req, res, next);
});

// Apply API key authentication to all other routes
app.use(apiKeyAuth);

if (config.security.apiKey.enabled) {
  logger.info({ headerName: config.security.apiKey.headerName }, 'API key authentication enabled');
}


app.use(express.json({ limit: MAX_HTTP_REQUEST_BYTES }));

// REQUEST LOGGING

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
    }, 'HTTP request');
  });
  next();
});

async function buildJobStatusResponse(jobId: string, ownerKey?: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const job = await getJob(jobId, { includeData: true });
  if (!job) {
    return { statusCode: 404, body: { error: 'Job not found' } };
  }

  const jobData = job.data as {
    request?: StepperRequest<unknown, unknown>;
    input?: PromptInput;
    cacheKey?: string;
    ownerKey?: string;
  } | undefined;
  // Job IDs are bearer capabilities only when API-key auth is disabled. In
  // authenticated HTTP mode, bind reads to the credential that created them.
  if (config.security.apiKey.enabled && (!ownerKey || jobData?.ownerKey !== ownerKey)) {
    return { statusCode: 404, body: { error: 'Job not found' } };
  }

  const publicStatus = job.state === 'waiting' || job.state === 'delayed' || job.state === 'prioritized'
    ? 'queued'
    : job.state;
  const response: Record<string, unknown> = {
    id: job.id,
    status: publicStatus,
    rawStatus: job.state,
    contractVersion: STEPPER_HTTP_CONTRACT_VERSION,
  };

  if (job.progress !== undefined) {
    response.progress = job.progress;
  }

  const cached = (job.state === 'completed' || job.state === 'failed') && !job.result && jobData?.cacheKey
    ? await getReportCache(jobData.cacheKey)
    : null;
  const completedResult = job.result || (cached?.status === 'hydrated' ? {
    result: cached.result,
    usedProvider: cached.usedProvider || (cached.fallback ? 'fallback' : 'cache'),
    providersAttempted: cached.providersAttempted || [],
    fallback: cached.fallback || false,
    validated: cached.validated ?? !cached.fallback,
    timings: cached.timings || { totalMs: 0 },
  } : null);

  if (job.state === 'completed' && completedResult) {
    response.data = completedResult;

    // Compatibility auto-cleanup for commit-report polling:
    // when the queue payload maps to commit preset data, keep existing delete-on-read behavior.
    const requestInput = jobData?.request ? toCommitReportInput(jobData.request) : null;
    const legacyInput = jobData?.input;
    const cleanupInput = requestInput || legacyInput;

    if (cleanupInput?.userId && cleanupInput.commitSha) {
      deleteReport(cleanupInput.userId, cleanupInput.commitSha, cleanupInput.template, ownerKey).catch(() => {
        logger.error({ errorCode: 'CACHE_AUTO_CLEANUP_FAILED', jobId }, 'Failed to auto-cleanup cache after polling');
      });
    }
  }

  if (job.state === 'failed' && job.failedReason) {
    response.error = 'Generation failed';
    const failure: JobFailure = cached?.failure || {
      errorCode: 'UNKNOWN',
      message: 'Generation failed. Retry later.',
      retryable: false,
    };
    response.failure = failure;
  }

  return { statusCode: 200, body: response };
}

// API ROUTES

/**
 * POST /v1/generate
 * Enqueue a generic generation request.
 */
app.post('/v1/generate', userRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = validateGenericRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error, errorCode: validation.errorCode, supportedVersion: validation.supportedVersion });
    }

    const result = await enqueueRequest(validation.request, { ownerKey: getApiKeyOwnerKey(req) });

    if (result.status === 200) {
      return res.status(200).json({
        status: 'completed',
        cached: true,
        stale: result.stale,
        data: result.data,
        metadata: {
          provider: result.usedProvider,
          fallback: result.fallback,
          validated: result.validated,
          contractVersion: STEPPER_HTTP_CONTRACT_VERSION,
          timings: result.timings,
        },
      });
    }

    return res.status(202).json({
      status: 'queued',
      jobId: result.jobId,
      statusUrl: `/v1/jobs/${result.jobId}`,
      contractVersion: STEPPER_HTTP_CONTRACT_VERSION,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /v1/generate/batch
 * Enqueue independently identified generic requests as one bounded-concurrency job.
 */
app.post('/v1/generate/batch', userRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = validateBatchRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        error: validation.error,
        errorCode: validation.errorCode,
        supportedVersion: validation.supportedVersion,
      });
    }

    const jobId = await enqueueBatchJob(validation.batch, { ownerKey: getApiKeyOwnerKey(req) });
    return res.status(202).json({
      status: 'queued',
      jobId,
      statusUrl: `/v1/jobs/${jobId}`,
      itemCount: validation.batch.items.length,
      concurrency: validation.batch.concurrency,
      contractVersion: STEPPER_HTTP_CONTRACT_VERSION,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /v1/generate/immediate
 * Generate synchronously with the generic request contract.
 */
app.post('/v1/generate/immediate', userRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = validateGenericRequest(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error, errorCode: validation.errorCode, supportedVersion: validation.supportedVersion });
    }

    const result = await generateRequest(validation.request);

    return res.status(200).json({
      status: 'completed',
      data: result.result,
      metadata: {
        provider: result.usedProvider,
        fallback: result.fallback,
        validated: result.validated,
        contractVersion: STEPPER_HTTP_CONTRACT_VERSION,
        timings: result.timings,
        providersAttempted: result.providersAttempted,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /v1/jobs/:jobId
 * Generic job status endpoint.
 */
app.get('/v1/jobs/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    const response = await buildJobStatusResponse(jobId, getApiKeyOwnerKey(req));
    return res.status(response.statusCode).json(response.body);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /v1/providers
 * Expose configured provider health without credentials.
 */
app.get('/v1/providers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const health = await healthcheck();
    return res.status(200).json({
      status: health.status,
      providers: health.providers,
      timestamp: health.timestamp,
      contractVersion: STEPPER_HTTP_CONTRACT_VERSION,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /v1/reports
 * Enqueue or immediately return a report
 */
app.post('/v1/reports', userRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: PromptInput = req.body;

    const validationError = validateLegacyCommitInput(input);
    if (validationError) {
      return res.status(400).json({
        error: validationError,
      });
    }

    const result = await enqueueReport(input, { ownerKey: getApiKeyOwnerKey(req) });

    if (result.status === 200) {
      return res.status(200).json({
        status: 'completed',
        cached: true,
        stale: result.stale,
        data: result.data,
        metadata: {
          provider: result.usedProvider,
          fallback: result.fallback,
          timings: result.timings,
        },
      });
    } else {
      return res.status(202).json({
        status: 'queued',
        jobId: result.jobId,
        statusUrl: `/v1/reports/${result.jobId}`,
      });
    }
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /v1/reports/immediate
 * Generate report synchronously (blocking)
 */
app.post('/v1/reports/immediate', userRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: PromptInput = req.body;

    const validationError = validateLegacyCommitInput(input);
    if (validationError) {
      return res.status(400).json({
        error: validationError,
      });
    }

    const result = await generateReport(input);

    return res.status(200).json({
      status: 'completed',
      data: result.result,
      metadata: {
        provider: result.usedProvider,
        fallback: result.fallback,
        timings: result.timings,
        providersAttempted: result.providersAttempted,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /v1/reports/:jobId
 * Get job status and result
 */
app.get('/v1/reports/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    const response = await buildJobStatusResponse(jobId, getApiKeyOwnerKey(req));
    return res.status(response.statusCode).json(response.body);
  } catch (error) {
    return next(error);
  }
});

/**
 * DELETE /v1/reports
 * Manually purge a report from cache. 
 * Use this after saving the result to your primary database.
 */
app.delete('/v1/reports', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // The legacy key is derived from caller-supplied userId/commitSha and cannot
    // be safely bound to the authenticated API key. Keep deletion available to
    // trusted in-process callers via deleteReport(), but refuse the HTTP form.
    return res.status(403).json({
      error: 'Cache deletion is only available through the trusted library API',
    });

  } catch (error) {
    return next(error);
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const health = await healthcheck();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    return res.status(statusCode).json(health);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /metrics
 * Prometheus metrics endpoint
 */
app.get('/metrics', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', 'text/plain');
    return res.send(metrics);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /
 * Root endpoint with API info
 */
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'stepper',
    version: '1.0.0',
    endpoints: {
      'POST /v1/generate': 'Enqueue generic generation request',
      'POST /v1/generate/batch': 'Enqueue multiple identified generic requests',
      'POST /v1/generate/immediate': 'Generate immediately (generic contract)',
      'GET /v1/jobs/:jobId': 'Get generic job status',
      'GET /v1/providers': 'Get provider health summary',
      'POST /v1/reports': 'Enqueue report generation',
      'POST /v1/reports/immediate': 'Generate report immediately',
      'GET /v1/reports/:jobId': 'Get job status',
      'POST /webhook/report-completion': 'Webhook for report completion notifications',
      'GET /health': 'Health check',
      'GET /metrics': 'Prometheus metrics',
    },
    security: {
      cors: config.security.cors.enabled,
      rateLimit: config.security.rateLimit.enabled,
      helmet: config.security.helmet.enabled,
      apiKeyRequired: config.security.apiKey.enabled,
    },
  });
});

// =============================================================================
// ERROR HANDLER
// =============================================================================

app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ errorCode: 'UNHANDLED_SERVER_ERROR' }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal server error',
  });
});

export default app;
