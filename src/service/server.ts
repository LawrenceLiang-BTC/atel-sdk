/**
 * Standalone server entry point.
 *
 * Usage:
 *   ATEL_PORT=3100 ATEL_DATA_DIR=./data tsx src/service/server.ts
 */

import { TrustScoreService } from './index.js';

const service = new TrustScoreService({
  port: parseInt(process.env.ATEL_PORT || '3100', 10),
  dataDir: process.env.ATEL_DATA_DIR || './data',
});

service.start().then(() => {
  console.log('ATEL Trust Score Service started');
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\n[ATEL] Shutting down...');
  await service.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
