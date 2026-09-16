import { describe, expect, it } from 'vitest';
import { calculateEscalation, calculateRunEscalations } from '../src/domain/escalation.js';
import { isOverdue, orderQueue, type QueueTicket } from '../src/domain/queue.js';

const now = new Date('2026-09-16T12:00:00.000Z');
const ticket = (overrides: Partial<QueueTicket>): QueueTicket => ({
  id: 1,
  priority: 'NORMAL',
  status: 'OPEN',
  promisedResponseAt: new Date('2026-09-16T13:00:00.000Z'),
  createdAt: new Date('2026-09-16T10:00:00.000Z'),
  ...overrides,
});

describe('queue ordering', () => {
  it('puts overdue active tickets before all non-overdue tickets', () => {
    const ordered = orderQueue([
      ticket({ id: 1, priority: 'URGENT' }),
      ticket({ id: 2, priority: 'LOW', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }),
    ], now);
    expect(ordered.map(({ id }) => id)).toEqual([2, 1]);
  });

  it('orders priority, deadline, creation, and id deterministically', () => {
    const ordered = orderQueue([
      ticket({ id: 4, priority: 'LOW' }),
      ticket({ id: 3, priority: 'HIGH' }),
      ticket({ id: 2, priority: 'HIGH', createdAt: new Date('2026-09-16T09:00:00.000Z') }),
      ticket({ id: 1, priority: 'HIGH', createdAt: new Date('2026-09-16T09:00:00.000Z') }),
    ], now);
    expect(ordered.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
  });

  it('does not mark resolved or closed tickets overdue', () => {
    expect(isOverdue(ticket({ status: 'RESOLVED', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }), now)).toBe(false);
    expect(isOverdue(ticket({ status: 'CLOSED', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }), now)).toBe(false);
  });
});

describe('SLA escalation', () => {
  it('increases normal and high by exactly one level', () => {
    expect(calculateEscalation(ticket({ id: 5, priority: 'NORMAL', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }), now)?.newPriority).toBe('HIGH');
    expect(calculateEscalation(ticket({ id: 6, priority: 'HIGH', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }), now)?.newPriority).toBe('URGENT');
  });

  it('does not escalate urgent, current, resolved, or closed tickets', () => {
    expect(calculateEscalation(ticket({ priority: 'URGENT' }), now)).toBeNull();
    expect(calculateEscalation(ticket({ promisedResponseAt: new Date('2026-09-16T13:00:00.000Z') }), now)).toBeNull();
    expect(calculateEscalation(ticket({ status: 'RESOLVED', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }), now)).toBeNull();
    expect(calculateEscalation(ticket({ status: 'CLOSED', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }), now)).toBeNull();
  });

  it('processes each candidate once per run', () => {
    const changes = calculateRunEscalations([
      ticket({ id: 7, priority: 'NORMAL', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }),
      ticket({ id: 7, priority: 'NORMAL', promisedResponseAt: new Date('2026-09-16T11:00:00.000Z') }),
    ], now);
    expect(changes).toHaveLength(2);
    expect(changes.every(({ newPriority }) => newPriority === 'HIGH')).toBe(true);
  });
});
