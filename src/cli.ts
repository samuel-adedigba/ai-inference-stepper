#!/usr/bin/env node

import { startServer } from './server/start.js';
import { logger } from './logging.js';

startServer().catch((error) => {
  logger.error({ error }, 'Failed to start Stepper server');
  process.exit(1);
});
