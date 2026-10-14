import type { Request, Response, NextFunction } from 'express';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  incrby: vi.fn(), pttl: vi.fn(), pexpire: vi.fn(),
  ipHandler: null as null | ((req: Request, res: Response) => void),
}));
vi.mock('../../src/index.js', () => ({}));
vi.mock('../../src/queue/producer.js', () => ({}));
vi.mock('../../src/cache/redisCache.js', () => ({}));
vi.mock('../../src/logging.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/config.js', () => ({ config: {
  security: {
    helmet: { enabled: false }, cors: { enabled: false },
    apiKey: { enabled: true, headerName: 'x-api-key' },
    rateLimit: { enabled: true, windowMs: 900000, maxRequests: 100, maxRequestsPerUser: 50 },
  }, redis: { keyPrefix: 'test:' }, batch: { maxItems: 100 },
} }));
vi.mock('../../src/server/redisRateLimitStore.js', () => ({
  RedisRateLimitStore: class {},
  getRateLimitRedisClient: () => mocks,
}));
vi.mock('express-rate-limit', () => ({ default: (options: { handler: typeof mocks.ipHandler }) => {
  mocks.ipHandler = options.handler;
  return (_req: Request, _res: Response, next: NextFunction): void => next();
} }));

import app from '../../src/server/app.js';

function response() {
  return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
}

beforeEach(() => { vi.clearAllMocks(); });

it.each([42500, 1, -1000])('IP rejection reports remaining time (%i ms)', (remainingMs) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const res = response();
    const req = { rateLimit: { resetTime: new Date(now + remainingMs) }, path: '/v1/reports' };
    mocks.ipHandler!(req as Request, res as unknown as Response);
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', String(seconds));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IP_RATE_LIMITED', retryAfter: seconds }));
  } finally { clock.mockRestore(); }
});

// Exercise the middleware registered on the actual report route without opening
// a socket or contacting Redis/providers.
const route = app._router.stack.find((layer: { route?: { path: string } }) => layer.route?.path === '/v1/reports');
const credentialLimiter = route.route.stack[0].handle;

it('credential rejection preserves Redis TTL in body and header', async () => {
  mocks.incrby.mockResolvedValue(51);
  mocks.pttl.mockResolvedValue(42500);
  const res = response();
  const next = vi.fn();
  await credentialLimiter({ headers: { 'x-api-key': 'test-key' }, path: '/v1/reports' }, res, next);
  expect(res.status).toHaveBeenCalledWith(429);
  expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '43');
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CREDENTIAL_RATE_LIMITED', retryAfter: 43 }));
  expect(next).not.toHaveBeenCalled();
});

it('allows requests within the credential limit', async () => {
  mocks.incrby.mockResolvedValue(1);
  const res = response();
  const next = vi.fn();
  await credentialLimiter({ headers: { 'x-api-key': 'test-key' }, path: '/v1/reports' }, res, next);
  expect(next).toHaveBeenCalledOnce();
  expect(res.status).not.toHaveBeenCalled();
  expect(mocks.pexpire).toHaveBeenCalledWith(expect.any(String), 900000);
});

it('fails closed when Redis is unavailable', async () => {
  mocks.incrby.mockRejectedValue(new Error('unavailable'));
  const res = response();
  const next = vi.fn();
  await credentialLimiter({ headers: { 'x-api-key': 'test-key' }, path: '/v1/reports' }, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(next).not.toHaveBeenCalled();
});
