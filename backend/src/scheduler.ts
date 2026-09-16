import { config } from './config.js';
import { prisma } from './db.js';
import { escalateBreachedTickets } from './services/escalation.js';

async function run(): Promise<void> {
  const execute = async (): Promise<void> => {
    const count = await escalateBreachedTickets(prisma);
    if (count > 0) console.info(`Escalated ${count} ticket(s)`);
  };

  await execute();
  const timer = setInterval(() => void execute().catch((error: unknown) => console.error('Escalation run failed', error)), config.ESCALATION_INTERVAL_MS);
  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await prisma.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void run().catch(async () => {
  console.error('Scheduler failed to start');
  await prisma.$disconnect();
  process.exitCode = 1;
});
