// packages/stepper/src/server/app.ts

import express, { Request, Response, NextFunction, Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { enqueueReport, generateReport, getJob, healthcheck, deleteReport, PromptInput } from '../index.js';
import { getMetrics } from '../metrics/metrics.js';
import { config } from '../config.js';
import { logger } from '../logging.js';

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

  // Extract userId from body (for POST requests) or skip if not present
  const userId = req.body?.userId;
  if (!userId) {
    return next();
  }

  const now = Date.now();
  const windowMs = config.security.rateLimit.windowMs;
  const maxPerUser = config.security.rateLimit.maxRequestsPerUser;

  // Get or create user entry
  let userEntry = userRequestCounts.get(userId);
  if (!userEntry || now > userEntry.resetTime) {
    userEntry = { count: 0, resetTime: now + windowMs };
    userRequestCounts.set(userId, userEntry);
  }

  userEntry.count++;

  if (userEntry.count > maxPerUser) {
    logger.warn({ userId, count: userEntry.count, path: req.path }, 'Rate limit exceeded (User)');
    return res.status(429).json({
      error: 'Too many requests',
      message: 'You have exceeded the rate limit for your user. Please try again later.',
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

// Apply API key authentication to all routes
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

// API ROUTES

/**
 * POST /v1/reports
 * Enqueue or immediately return a report
 */
app.post('/v1/reports', userRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: PromptInput = req.body;

    // Validate required fields
    if (!input.userId || !input.commitSha || !input.repo || !input.message) {
      return res.status(400).json({
        error: 'Missing required fields: userId, commitSha, repo, message',
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

    if (!input.userId || !input.commitSha || !input.repo || !input.message) {
      return res.status(400).json({
        error: 'Missing required fields: userId, commitSha, repo, message',
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
    const job = await getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const response: Record<string, unknown> = {
      id: job.id,
      status: job.state,
    };

    if (job.progress !== undefined) {
      response.progress = job.progress;
    }

    if (job.state === 'completed' && job.result) {
      response.data = job.result;

      // Auto-cleanup: Once returned to the poller, we can clear the cache
      // because the backend is expected to save it to Supabase immediately.
      const jobData = job.data as { input?: { userId?: string; commitSha?: string; template?: string } } | undefined;
      if (jobData?.input?.userId && jobData.input.commitSha) {
        deleteReport(jobData.input.userId, jobData.input.commitSha, jobData.input.template).catch(err => {
          logger.error({ err, jobId }, 'Failed to auto-cleanup cache after polling');
        });
      }
    }

    if (job.state === 'failed' && job.failedReason) {
      response.error = job.failedReason;
    }

    return res.status(200).json(response);
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
      'POST /v1/reports': 'Enqueue report generation',
      'POST /v1/reports/immediate': 'Generate report immediately',
      'GET /v1/reports/:jobId': 'Get job status',
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