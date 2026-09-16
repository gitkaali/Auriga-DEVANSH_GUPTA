import crypto from 'node:crypto';
import argon2 from 'argon2';
import { Role, TicketStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';

const adminEmail = 'integration-admin@example.test';
const agentEmail = 'integration-agent@example.test';
const password = 'integration-password-123';
let app: Awaited<ReturnType<typeof buildApp>>;
let adminSession: string;
let agentSession: string;
const csrf = 'integration-csrf';
let unassignedTicketId: number;
let assignedTicketId: number;

function sessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token: string): string {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(token).digest('hex');
}

function headers(session: string, includeCsrf = true): Record<string, string> {
  return {
    cookie: `sid=${session}; csrf=${csrf}`,
    ...(includeCsrf ? { 'x-csrf-token': csrf } : {}),
  };
}

describe('API authorization integration', () => {
  beforeAll(async () => {
    app = await buildApp();
    const oldUsers = await prisma.user.findMany({ where: { email: { in: [adminEmail, agentEmail] } }, select: { id: true } });
    if (oldUsers.length > 0) {
      await prisma.ticket.deleteMany({ where: { creatorId: { in: oldUsers.map(({ id }) => id) } } });
      await prisma.user.deleteMany({ where: { id: { in: oldUsers.map(({ id }) => id) } } });
    }
    const [admin, agent] = await Promise.all([
      prisma.user.create({ data: { email: adminEmail, name: 'Integration Admin', passwordHash: await argon2.hash(password), role: Role.ADMIN } }),
      prisma.user.create({ data: { email: agentEmail, name: 'Integration Agent', passwordHash: await argon2.hash(password), role: Role.AGENT } }),
    ]);
    adminSession = sessionToken();
    agentSession = sessionToken();
    await prisma.session.createMany({ data: [
      { tokenHash: tokenHash(adminSession), userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
      { tokenHash: tokenHash(agentSession), userId: agent.id, expiresAt: new Date(Date.now() + 60_000) },
    ] });
    const deadline = new Date('2030-01-01T12:00:00.000Z');
    const unassigned = await prisma.ticket.create({ data: { customerName: 'Integration', title: 'Private unassigned', description: 'Should be hidden from the agent.', creatorId: admin.id, promisedResponseAt: deadline, status: TicketStatus.OPEN } });
    const assigned = await prisma.ticket.create({ data: { customerName: 'Integration', title: 'Assigned work', description: 'Should be visible to the agent.', creatorId: admin.id, assigneeId: agent.id, promisedResponseAt: deadline, status: TicketStatus.OPEN } });
    unassignedTicketId = unassigned.id;
    assignedTicketId = assigned.id;
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { id: { in: [unassignedTicketId, assignedTicketId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, agentEmail] } } });
    await app.close();
  });

  it('rejects unauthenticated and missing-CSRF requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tickets' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/tickets', headers: headers(adminSession, false), payload: {} })).statusCode).toBe(403);
  });

  it('prevents agent IDOR access while allowing assigned work', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/tickets', headers: headers(agentSession) });
    expect(list.statusCode).toBe(200);
    const ids = list.json<{ data: Array<{ id: number }> }>().data.map(({ id }) => id);
    expect(ids).toContain(assignedTicketId);
    expect(ids).not.toContain(unassignedTicketId);

    const hidden = await app.inject({ method: 'GET', url: `/api/tickets/${unassignedTicketId}`, headers: headers(agentSession) });
    const visible = await app.inject({ method: 'GET', url: `/api/tickets/${assignedTicketId}`, headers: headers(agentSession) });
    expect(hidden.statusCode).toBe(404);
    expect(visible.statusCode).toBe(200);
  });
});
