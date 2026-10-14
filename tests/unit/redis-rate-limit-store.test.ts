import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clients: FakeRedis[] = [];

class FakeRedis extends EventEmitter {
  status = 'connecting';
  quit = vi.fn().mockResolvedValue(undefined);
  incr = vi.fn();
  pexpire = vi.fn();
  pttl = vi.fn();
  decr = vi.fn();
  del = vi.fn();

  constructor() {
    super();
    clients.push(this);
  }
}

vi.mock('ioredis', () => ({ default: FakeRedis }));
vi.mock('../../src/config.js', () => ({
  config: { redis: { url: 'redis://test', keyPrefix: 'test:' } },
}));
vi.mock('../../src/logging.js', () => ({
  logger: { error: vi.fn() },
}));

afterEach(async () => {
  vi.useRealTimers();
  const module = await import('../../src/server/redisRateLimitStore.js');
  await module.closeRateLimitRedis();
  clients.length = 0;
});

describe('rate-limit Redis readiness', () => {
  it('waits for the first connection before returning the client', async () => {
    const { getReadyRateLimitRedisClient } = await import('../../src/server/redisRateLimitStore.js');
    const pending = getReadyRateLimitRedisClient();
    expect(clients).toHaveLength(1);
    clients[0].status = 'ready';
    clients[0].emit('ready');
    await expect(pending).resolves.toBe(clients[0]);
  });

  it('fails closed with a stable 503 error when Redis cannot connect', async () => {
    const { getReadyRateLimitRedisClient } = await import('../../src/server/redisRateLimitStore.js');
    const pending = getReadyRateLimitRedisClient();
    clients[0].emit('error', new Error('secret connection details'));
    await expect(pending).rejects.toMatchObject({
      code: 'RATE_LIMIT_REDIS_NOT_READY',
      statusCode: 503,
    });
  });
});
