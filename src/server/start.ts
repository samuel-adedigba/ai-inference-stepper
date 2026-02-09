// packages/stepper/src/server/start.ts

import 'dotenv/config';
import { initStepper } from '../index.js';
import { logger } from '../logging.js';
import { startWorker, stopWorker } from '../queue/worker.js';
import { closeRedis } from '../cache/redisCache.js';
import { closeQueue } from '../queue/producer.js';
import type { ProviderConfig, StepperConfig } from '../types.js';

export interface StartServerOptions {
  port?: number;
  init?: {
    config?: Partial<StepperConfig>;
    providers?: ProviderConfig[];
  };
}

export interface RunningServer {
  server: import('http').Server;
  shutdown: () => Promise<void>;
}

export async function startServer(options?: StartServerOptions): Promise<RunningServer> {
  const overrides = options?.init?.config;
  const providers = options?.init?.providers;

  const appConfig = initStepper({ config: overrides, providers });

  const { default: app } = await import('./app.js');
  const port = options?.port ?? appConfig.server.port;

  const server = app.listen(port, () => {
    logger.info({ port }, 'Server started');

    logger.info({
      cors: appConfig.security.cors.enabled,
      rateLimit: appConfig.security.rateLimit.enabled,
      helmet: appConfig.security.helmet.enabled,
      apiKey: appConfig.security.apiKey.enabled,
    }, 'Security configuration');

    if (process.env.DISCORD_WEBHOOK_URL) {
      logger.info('Stepper error webhook configured - alerts enabled');
    } else {
      logger.info('Stepper error webhook not configured (set DISCORD_WEBHOOK_URL to enable)');
    }

    startWorker();
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down gracefully');
    await new Promise<void>((resolve) => {
      server.close(async () => {
        await stopWorker();
        await closeQueue();
        await closeRedis();
        logger.info('Shutdown complete');
        resolve();
      });
    });
  };

  return { server, shutdown };
}

export default startServer;
