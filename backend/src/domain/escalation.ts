import type { QueuePriority, QueueStatus } from './queue.js';

const nextPriority: Partial<Record<QueuePriority, QueuePriority>> = {
  NORMAL: 'HIGH',
  HIGH: 'URGENT',
};

export interface EscalationCandidate {
  id: number;
  priority: QueuePriority;
  status: QueueStatus;
  promisedResponseAt: Date;
}

export interface EscalationChange {
  ticketId: number;
  previousPriority: QueuePriority;
  newPriority: QueuePriority;
  occurredAt: Date;
}

export function calculateEscalation(
  ticket: EscalationCandidate,
  now: Date,
): EscalationChange | null {
  const isEligible = ticket.status !== 'RESOLVED'
    && ticket.status !== 'CLOSED'
    && now.getTime() > ticket.promisedResponseAt.getTime();
  const newPriority = nextPriority[ticket.priority];

  if (!isEligible || !newPriority) return null;

  return {
    ticketId: ticket.id,
    previousPriority: ticket.priority,
    newPriority,
    occurredAt: now,
  };
}

export function calculateRunEscalations(
  tickets: EscalationCandidate[],
  now: Date,
): EscalationChange[] {
  return tickets.flatMap((ticket) => {
    const change = calculateEscalation(ticket, now);
    return change ? [change] : [];
  });
}
