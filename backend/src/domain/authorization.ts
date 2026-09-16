import { Role } from '@prisma/client';

export interface TicketOwnership {
  assigneeId: number | null;
  creatorId: number;
}

export function canAccessTicket(userId: number, role: Role, ticket: TicketOwnership): boolean {
  return role === Role.ADMIN || ticket.assigneeId === userId || ticket.creatorId === userId;
}

export function canModifyTicket(userId: number, role: Role, assigneeId: number | null): boolean {
  return role === Role.ADMIN || assigneeId === userId;
}