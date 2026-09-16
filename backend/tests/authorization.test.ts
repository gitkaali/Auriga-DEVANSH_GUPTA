import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { canAccessTicket, canModifyTicket } from '../src/domain/authorization.js';

describe('ticket authorization', () => {
  const ticket = { assigneeId: 7, creatorId: 8 };

  it('allows admins to access and modify every ticket', () => {
    expect(canAccessTicket(99, Role.ADMIN, ticket)).toBe(true);
    expect(canModifyTicket(99, Role.ADMIN, ticket.assigneeId)).toBe(true);
  });

  it('limits agents to tickets they created or own', () => {
    expect(canAccessTicket(7, Role.AGENT, ticket)).toBe(true);
    expect(canAccessTicket(8, Role.AGENT, ticket)).toBe(true);
    expect(canAccessTicket(99, Role.AGENT, ticket)).toBe(false);
    expect(canModifyTicket(7, Role.AGENT, ticket.assigneeId)).toBe(true);
    expect(canModifyTicket(8, Role.AGENT, ticket.assigneeId)).toBe(false);
  });
});