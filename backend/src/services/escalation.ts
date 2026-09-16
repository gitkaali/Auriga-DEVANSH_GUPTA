import { Prisma, TicketStatus, type PrismaClient } from '@prisma/client';
import { calculateEscalation } from '../domain/escalation.js';

export async function escalateBreachedTickets(prisma: PrismaClient, now = new Date()): Promise<number> {
  const candidates = await prisma.ticket.findMany({
    where: {
      status: { in: [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.IN_PROGRESS] },
      promisedResponseAt: { lt: now },
      priority: { in: ['NORMAL', 'HIGH'] },
    },
    orderBy: { id: 'asc' },
  });

  let escalated = 0;
  for (const candidate of candidates) {
    await prisma.$transaction(async (transaction) => {
      const lockedRows = await transaction.$queryRaw<Array<{
        id: number;
        priority: 'NORMAL' | 'HIGH' | 'URGENT' | 'LOW';
        status: TicketStatus;
        promisedResponseAt: Date;
      }>>(Prisma.sql`
        SELECT id, priority, status, "promisedResponseAt"
        FROM "Ticket"
        WHERE id = ${candidate.id}
        FOR UPDATE`);
      const locked = lockedRows[0];
      if (!locked) return;

      const change = calculateEscalation({
        id: locked.id,
        priority: locked.priority,
        status: locked.status,
        promisedResponseAt: locked.promisedResponseAt,
      }, now);
      if (!change) return;

      const updated = await transaction.ticket.updateMany({
        where: {
          id: locked.id,
          priority: locked.priority,
          status: { in: [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.IN_PROGRESS] },
          promisedResponseAt: { lt: now },
        },
        data: { priority: change.newPriority },
      });
      if (updated.count !== 1) return;

      await transaction.auditRecord.create({
        data: {
          ticketId: locked.id,
          action: 'SLA_ESCALATION',
          previousValue: locked.priority,
          newValue: change.newPriority,
          actorType: 'SYSTEM',
          occurredAt: now,
        },
      });
      escalated += 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  return escalated;
}
