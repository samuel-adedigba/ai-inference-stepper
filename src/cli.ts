#!/usr/bin/env node

import { startServer } from './server/start.js';
import { logger } from './logging.js';

startServer().catch(() => {
  logger.error({ errorCode: 'SERVER_START_FAILED' }, 'Failed to start Stepper server');
  process.exit(1);
});
