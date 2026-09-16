import { TicketStatus, type Prisma, type PrismaClient } from '@prisma/client';
import { priorityRank } from './queue.js';

const activeStatuses: TicketStatus[] = [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.IN_PROGRESS];

export function queueOrder(now: Date): Prisma.TicketOrderByWithRelationInput[] {
  void now;
  return [
    { promisedResponseAt: 'asc' },
    { createdAt: 'asc' },
    { id: 'asc' },
  ];
}

export function queueWhere(now: Date, filters: Prisma.TicketWhereInput = {}): Prisma.TicketWhereInput {
  return {
    ...filters,
    status: { in: activeStatuses },
  };
}

export function priorityValue(priority: keyof typeof priorityRank): number {
  return priorityRank[priority];
}

export type DatabaseClient = PrismaClient | Prisma.TransactionClient;
