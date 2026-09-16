export const priorityRank = {
  URGENT: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1,
} as const;

export type QueueStatus = 'OPEN' | 'PENDING' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type QueuePriority = keyof typeof priorityRank;

export interface QueueTicket {
  id: number;
  priority: QueuePriority;
  status: QueueStatus;
  promisedResponseAt: Date;
  createdAt: Date;
}

export function isActive(status: QueueStatus): boolean {
  return status !== 'RESOLVED' && status !== 'CLOSED';
}

export function isOverdue(ticket: QueueTicket, now: Date): boolean {
  return isActive(ticket.status) && now.getTime() > ticket.promisedResponseAt.getTime();
}

export function compareQueueTickets(left: QueueTicket, right: QueueTicket, now: Date): number {
  const overdueDifference = Number(isOverdue(left, now)) - Number(isOverdue(right, now));
  if (overdueDifference !== 0) return -overdueDifference;

  const priorityDifference = priorityRank[right.priority] - priorityRank[left.priority];
  if (priorityDifference !== 0) return priorityDifference;

  const responseDifference = left.promisedResponseAt.getTime() - right.promisedResponseAt.getTime();
  if (responseDifference !== 0) return responseDifference;

  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDifference !== 0) return createdDifference;

  return left.id - right.id;
}

export function orderQueue<T extends QueueTicket>(tickets: T[], now: Date): T[] {
  return [...tickets].sort((left, right) => compareQueueTickets(left, right, now));
}
