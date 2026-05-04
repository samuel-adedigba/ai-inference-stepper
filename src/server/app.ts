// packages/stepper/src/server/app.ts

import express, { Request, Response, NextFunction, Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { enqueueReport, enqueueRequest, generateReport, generateRequest, getJob, healthcheck, deleteReport, PromptInput, StepperRequest } from '../index.js';
import { getReportCache } from '../cache/redisCache.js';
import { getMetrics } from '../metrics/metrics.js';
import { config } from '../config.js';
import { logger } from '../logging.js';
import { handleCommitReportWebhook } from '../presets/commit-report/webhookEndpoint.js';
import { toCommitReportInput } from '../presets/commit-report/request.js';
import { parseHttpOutputSchemaInput, toRuntimeOutputSchemaFromHttp } from '../validation/httpOutputSchema.js';

const app: Application = express();

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
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Request-ID'],
    maxAge: 86400, // Cache preflight for 24 hours
  };

  app.use(cors(corsOptions));
  logger.info({ origins: config.security.cors.allowedOrigins }, 'CORS protection enabled');
}


// 3. Rate Limiting - Prevent abuse and DDoS attacks


// Store for user-based rate limiting (in-memory, consider Redis for multi-instance)
const userRequestCounts = new Map<string, { count: number; resetTime: number }>();

// IP-based rate limiter
if (config.security.rateLimit.enabled) {
  const ipRateLimiter = rateLimit({
    windowMs: config.security.rateLimit.windowMs,
    max: config.security.rateLimit.maxRequests,
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
const userRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  if (!config.security.rateLimit.enabled) {
    return next();
  }

  const rateLimitKey = extractRateLimitKey(req);
  if (!rateLimitKey) {
    return next();
  }

  const now = Date.now();
  const windowMs = config.security.rateLimit.windowMs;
  const maxPerUser = config.security.rateLimit.maxRequestsPerUser;

  // Get or create user entry
  let userEntry = userRequestCounts.get(rateLimitKey);
  if (!userEntry || now > userEntry.resetTime) {
    userEntry = { count: 0, resetTime: now + windowMs };
    userRequestCounts.set(rateLimitKey, userEntry);
  }

  userEntry.count++;

  if (userEntry.count > maxPerUser) {
    logger.warn({ rateLimitKey, count: userEntry.count, path: req.path }, 'Rate limit exceeded (User/Tenant)');
    return res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the request rate limit. Please try again later.',
      retryAfter: Math.ceil((userEntry.resetTime - now) / 1000),
    });
  }

  next();
};

// Cleanup stale entries periodically (every 15 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, entry] of userRequestCounts.entries()) {
    if (now > entry.resetTime) {
      userRequestCounts.delete(userId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug({ cleaned }, 'Cleaned stale user rate limit entries');
  }
}, 15 * 60 * 1000);

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
  const providedKey = req.headers[headerName] as string;
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
  return typeof value === 'object' && value !== null;
}

function validateLegacyCommitInput(input: PromptInput): string | null {
  if (!input.userId || !input.commitSha || !input.repo || !input.message) {
    return 'Missing required fields: userId, commitSha, repo, message';
  }
  return null;
}

function validateGenericRequest(request: unknown): { valid: true; request: StepperRequest<unknown, unknown> } | { valid: false; error: string } {
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

  if (request.responseMode !== undefined && request.responseMode !== 'json' && request.responseMode !== 'text') {
    return { valid: false, error: "Invalid responseMode: expected 'json' or 'text'" };
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
    if (!Array.isArray(request.providers)) {
      return { valid: false, error: 'Invalid providers: expected array' };
    }
    for (const provider of request.providers) {
      if (!isRecord(provider) || typeof provider.name !== 'string') {
        return { valid: false, error: 'Invalid providers entry: each provider must include a string name' };
      }
    }
  }

  return { valid: true, request: normalizedRequest };
}

function extractRateLimitKey(req: Request): string | null {
  // Keep legacy userId support, but prefer generic tenantId when present.
  const tenantId = typeof req.body?.tenantId === 'string' ? req.body.tenantId : null;
  if (tenantId) {
    return `tenant:${tenantId}`;
  }

  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  if (userId) {
    return `user:${userId}`;
  }

  return null;
}

// API ROUTES

/**
 * POST /webhook/report-completion
 * Webhook endpoint for report completion notifications
 * This endpoint bypasses API key auth but uses webhook signature verification
 */
app.post('/webhook/report-completion', express.json({ limit: '10mb' }), async (req: Request, res: Response, next: NextFunction) => {
  return handleCommitReportWebhook(req, res, next);
});

// Apply API key authentication to all other routes
app.use(apiKeyAuth);

if (config.security.apiKey.enabled) {
  logger.info({ headerName: config.security.apiKey.headerName }, 'API key authentication enabled');
}


app.use(express.json({ limit: '10mb' }));

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

async function buildJobStatusResponse(jobId: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const job = await getJob(jobId);
  if (!job) {
    return { statusCode: 404, body: { error: 'Job not found' } };
  }

  const response: Record<string, unknown> = {
    id: job.id,
    status: job.state,
  };

  if (job.progress !== undefined) {
    response.progress = job.progress;
  }

  const jobData = job.data as { request?: StepperRequest<unknown, unknown>; input?: PromptInput; cacheKey?: string } | undefined;
  const cached = job.state === 'completed' && !job.result && jobData?.cacheKey
    ? await getReportCache(jobData.cacheKey)
    : null;
  const completedResult = job.result || (cached?.status === 'hydrated' ? {
    result: cached.result,
    usedProvider: 'cache',
    providersAttempted: cached.providersAttempted || [],
    fallback: cached.fallback || false,
    timings: { totalMs: 0 },
  } : null);

  if (job.state === 'completed' && completedResult) {
    response.data = completedResult;

    // Compatibility auto-cleanup for commit-report polling:
    // when the queue payload maps to commit preset data, keep existing delete-on-read behavior.
    const requestInput = jobData?.request ? toCommitReportInput(jobData.request) : null;
    const legacyInput = jobData?.input;
    const cleanupInput = requestInput || legacyInput;

    if (cleanupInput?.userId && cleanupInput.commitSha) {
      deleteReport(cleanupInput.userId, cleanupInput.commitSha, cleanupInput.template).catch(err => {
        logger.error({ err, jobId }, 'Failed to auto-cleanup cache after polling');
      });
    }
  }

  if (job.state === 'failed' && job.failedReason) {
    response.error = job.failedReason;
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
      return res.status(400).json({ error: validation.error });
    }

    const result = await enqueueRequest(validation.request);

    if (result.status === 200) {
      return res.status(200).json({
        status: 'completed',
        cached: true,
        stale: result.stale,
        data: result.data,
      });
    }

    return res.status(202).json({
      status: 'queued',
      jobId: result.jobId,
      statusUrl: `/v1/jobs/${result.jobId}`,
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
      return res.status(400).json({ error: validation.error });
    }

    const result = await generateRequest(validation.request);

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
 * GET /v1/jobs/:jobId
 * Generic job status endpoint.
 */
app.get('/v1/jobs/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    const response = await buildJobStatusResponse(jobId);
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

    const result = await enqueueReport(input);

    if (result.status === 200) {
      return res.status(200).json({
        status: 'completed',
        cached: true,
        stale: result.stale,
        data: result.data,
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
    const response = await buildJobStatusResponse(jobId);
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
app.delete('/v1/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, commitSha, template } = req.query;

    if (!userId || !commitSha) {
      return res.status(400).json({
        error: 'Missing required query parameters: userId, commitSha',
      });
    }

    await deleteReport(userId as string, commitSha as string, template as string);

    return res.status(200).json({ success: true, message: 'Cache entry deleted' });
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

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

export default app;
