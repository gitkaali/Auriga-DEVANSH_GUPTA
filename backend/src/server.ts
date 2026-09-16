import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const app = await buildApp();

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
}

const shutdown = async (): Promise<void> => {
  await app.close();
  await prisma.$disconnect();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
