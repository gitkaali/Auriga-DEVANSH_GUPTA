import crypto from 'node:crypto';
import { Prisma, Role, TicketStatus } from '@prisma/client';
import argon2 from 'argon2';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { prisma } from './db.js';
import { escalateBreachedTickets } from './services/escalation.js';

const ticketPriorities = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
const ticketStatuses = ['OPEN', 'PENDING', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const activeStatuses: TicketStatus[] = [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.IN_PROGRESS];
const priorityRankSql = Prisma.sql`CASE t.priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END`;
const overdueRankSql = Prisma.sql`CASE WHEN t.status IN ('OPEN', 'PENDING', 'IN_PROGRESS') AND t."promisedResponseAt" < NOW() THEN 0 ELSE 1 END`;

const credentialsSchema = z.object({ email: z.string().trim().email().max(320), password: z.string().min(12).max(200) });
const ticketCreateSchema = z.object({
  customerName: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20_000),
  priority: z.enum(ticketPriorities).default('NORMAL'),
  status: z.enum(ticketStatuses).default('OPEN'),
  assigneeId: z.number().int().positive().nullable().optional(),
  promisedResponseAt: z.coerce.date(),
}).strict();
const ticketUpdateSchema = ticketCreateSchema.partial().strict();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  priority: z.enum(ticketPriorities).optional(),
  status: z.enum(ticketStatuses).optional(),
}).strict();

type SessionUser = { id: number; email: string; name: string; role: Role };
type AuthenticatedRequest = FastifyRequest & { user?: SessionUser };

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function csrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function setSecurityCookies(reply: FastifyReply, sessionToken: string, csrf: string): void {
  const secure = config.NODE_ENV === 'production';
  reply.setCookie('sid', sessionToken, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
  reply.setCookie('csrf', csrf, { httpOnly: false, secure, sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8 });
}

async function createSession(userId: number, reply: FastifyReply): Promise<void> {
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const csrf = csrfToken();
  await prisma.session.create({
    data: { tokenHash: tokenHash(sessionToken), userId, expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) },
  });
  setSecurityCookies(reply, sessionToken, csrf);
}

function requireUser(request: AuthenticatedRequest, reply: FastifyReply): SessionUser | undefined {
  if (!request.user) {
    void reply.unauthorized('Authentication required');
    return undefined;
  }
  return request.user;
}

function canModifyTicket(user: SessionUser, assigneeId: number | null): boolean {
  return user.role === Role.ADMIN || assigneeId === user.id;
}

async function auditTicketChange(
  tx: Prisma.TransactionClient,
  ticketId: number,
  action: string,
  previousValue: string | null,
  newValue: string | null,
  actorId: number,
): Promise<void> {
  await tx.auditRecord.create({ data: { ticketId, action, previousValue, newValue, actorType: 'USER', actorId } });
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.NODE_ENV !== 'test' });
  await app.register(sensible);
  await app.register(cookie);
  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.addHook('preHandler', async (request: AuthenticatedRequest, reply) => {
    const sid = request.cookies.sid;
    if (sid) {
      const session = await prisma.session.findFirst({
        where: { tokenHash: tokenHash(sid), revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: true },
      });
      if (session?.user.isActive) request.user = session.user;
    }
    const publicAuthRoute = request.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(request.url);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !publicAuthRoute) {
      const csrf = request.headers['x-csrf-token'];
      if (!csrf || csrf !== request.cookies.csrf) return reply.forbidden('Invalid CSRF token');
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/', async (request, reply) => {
    if (config.CODESPACE_NAME) {
      return reply.redirect(`https://${config.CODESPACE_NAME}-5173.${config.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/`);
    }
    const host = request.headers.host?.split(':')[0] ?? '';
    if (host.endsWith('-3000.app.github.dev')) {
      const dashboardHost = host.replace(/-3000\.app\.github\.dev$/, '-5173.app.github.dev');
      return reply.redirect(`https://${dashboardHost}/`);
    }
    return {
      service: 'Auriga Helpdesk API',
      status: 'ok',
      dashboard: 'Open the forwarded port 5173 for the web interface.',
    };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const input = credentialsSchema.extend({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const count = await prisma.user.count();
    if (count > 0) return reply.conflict('Initial registration is closed');
    const user = await prisma.user.create({ data: { email: input.email.toLowerCase(), name: input.name, passwordHash: await argon2.hash(input.password), role: Role.ADMIN } });
    await createSession(user.id, reply);
    return reply.code(201).send({ id: user.id, email: user.email, name: user.name, role: user.role });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = credentialsSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !user.isActive || !(await argon2.verify(user.passwordHash, input.password))) return reply.unauthorized('Invalid credentials');
    await createSession(user.id, reply);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sid = request.cookies.sid;
    if (sid) await prisma.session.updateMany({ where: { tokenHash: tokenHash(sid), revokedAt: null }, data: { revokedAt: new Date() } });
    reply.clearCookie('sid', { path: '/' }).clearCookie('csrf', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = requireUser(request, reply);
    return user;
  });

  app.get('/api/users', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    if (user.role !== Role.ADMIN) return reply.forbidden('Only admins can list users');
    return prisma.user.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true },
    });
  });

  app.get('/api/tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const query = listQuerySchema.parse(request.query);
    const filters: Prisma.Sql[] = [Prisma.sql`t.status IN ('OPEN', 'PENDING', 'IN_PROGRESS')`];
    if (query.status) filters.push(Prisma.sql`t.status = CAST(${query.status} AS "TicketStatus")`);
    if (query.priority) filters.push(Prisma.sql`t.priority = CAST(${query.priority} AS "Priority")`);
    if (query.assigneeId) filters.push(Prisma.sql`t."assigneeId" = ${query.assigneeId}`);
    if (query.search) filters.push(Prisma.sql`t."customerName" ILIKE ${`%${query.search}%`}`);
    if (query.overdue === 'true') filters.push(Prisma.sql`t."promisedResponseAt" < NOW()`);
    if (query.overdue === 'false') filters.push(Prisma.sql`t."promisedResponseAt" >= NOW()`);
    const where = Prisma.join(filters, ' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t.id, t."customerName", t.title, t.description, t.priority, t.status,
        t."assigneeId", u.name AS "assigneeName", t."createdAt",
        t."promisedResponseAt", t."updatedAt",
        (t.status IN ('OPEN', 'PENDING', 'IN_PROGRESS') AND t."promisedResponseAt" < NOW()) AS overdue
      FROM "Ticket" t LEFT JOIN "User" u ON u.id = t."assigneeId"
      WHERE ${where}
      ORDER BY ${overdueRankSql}, ${priorityRankSql}, t."promisedResponseAt" ASC, t."createdAt" ASC, t.id ASC
      LIMIT ${query.pageSize} OFFSET ${offset}`);
    const countRows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*) AS count FROM "Ticket" t WHERE ${where}`);
    return { data: rows, page: query.page, pageSize: query.pageSize, total: Number(countRows[0]?.count ?? 0), currentUserId: user.id };
  });

  app.post('/api/tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const input = ticketCreateSchema.parse(request.body);
    if (input.assigneeId !== undefined && input.assigneeId !== null && user.role !== Role.ADMIN) return reply.forbidden('Only admins can assign tickets');
    if (input.assigneeId) {
      const assignee = await prisma.user.findFirst({ where: { id: input.assigneeId, isActive: true } });
      if (!assignee) return reply.notFound('Assignee not found');
    }
    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({ data: {
        customerName: input.customerName,
        title: input.title,
        description: input.description,
        priority: input.priority,
        status: input.status,
        promisedResponseAt: input.promisedResponseAt,
        assigneeId: input.assigneeId ?? null,
        creatorId: user.id,
      } });
      await auditTicketChange(tx, created.id, 'CREATED', null, created.title, user.id);
      return created;
    });
    return reply.code(201).send(ticket);
  });

  app.get('/api/tickets/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
    const ticket = await prisma.ticket.findUnique({ where: { id }, include: { assignee: { select: { id: true, name: true, email: true } } } });
    if (!ticket) return reply.notFound('Ticket not found');
    return ticket;
  });

  app.patch('/api/tickets/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
    const input = ticketUpdateSchema.parse(request.body);
    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) return reply.notFound('Ticket not found');
    if (!canModifyTicket(user, existing.assigneeId)) return reply.forbidden('Insufficient permission');
    if (input.assigneeId !== undefined && user.role !== Role.ADMIN) return reply.forbidden('Only admins can assign tickets');
    if (input.assigneeId) {
      const assignee = await prisma.user.findFirst({ where: { id: input.assigneeId, isActive: true } });
      if (!assignee) return reply.notFound('Assignee not found');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const updateData: Prisma.TicketUncheckedUpdateInput = {};
      if (input.customerName !== undefined) updateData.customerName = input.customerName;
      if (input.title !== undefined) updateData.title = input.title;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.priority !== undefined) updateData.priority = input.priority;
      if (input.status !== undefined) updateData.status = input.status;
      if (input.assigneeId !== undefined) updateData.assigneeId = input.assigneeId;
      if (input.promisedResponseAt !== undefined) updateData.promisedResponseAt = input.promisedResponseAt;
      const result = await tx.ticket.update({ where: { id }, data: updateData });
      const changes: Array<[string, string | null, string | null]> = [];
      if (input.status && input.status !== existing.status) changes.push(['STATUS_CHANGED', existing.status, input.status]);
      if (input.priority && input.priority !== existing.priority) changes.push(['PRIORITY_CHANGED', existing.priority, input.priority]);
      if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) changes.push(['ASSIGNEE_CHANGED', String(existing.assigneeId), String(input.assigneeId)]);
      if (input.promisedResponseAt && input.promisedResponseAt.getTime() !== existing.promisedResponseAt.getTime()) changes.push(['DEADLINE_CHANGED', existing.promisedResponseAt.toISOString(), input.promisedResponseAt.toISOString()]);
      for (const [action, previousValue, newValue] of changes) await auditTicketChange(tx, id, action, previousValue, newValue, user.id);
      return result;
    });
    return updated;
  });

  app.delete('/api/tickets/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    if (user.role !== Role.ADMIN) return reply.forbidden('Only admins can delete tickets');
    const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
    await prisma.ticket.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  });

  app.get('/api/tickets/:id/audit', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
    return prisma.auditRecord.findMany({ where: { ticketId: id }, orderBy: { occurredAt: 'desc' }, select: { action: true, previousValue: true, newValue: true, actorType: true, occurredAt: true, actor: { select: { name: true } } } });
  });

  app.get('/api/dashboard', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const [total, open, overdue, assigned, byPriority, byStatus, recentlyEscalated] = await Promise.all([
      prisma.ticket.count(),
      prisma.ticket.count({ where: { status: { in: activeStatuses } } }),
      prisma.ticket.count({ where: { status: { in: activeStatuses }, promisedResponseAt: { lt: new Date() } } }),
      prisma.ticket.count({ where: { assigneeId: user.id, status: { in: activeStatuses } } }),
      prisma.ticket.groupBy({ by: ['priority'], _count: { _all: true } }),
      prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.auditRecord.findMany({ where: { action: { in: ['SLA_ESCALATION', 'PRIORITY_CHANGED'] } }, orderBy: { occurredAt: 'desc' }, take: 10, include: { ticket: { select: { id: true, title: true } } } }),
    ]);
    return { total, open, overdue, assigned, byPriority, byStatus, recentlyEscalated };
  });

  app.post('/api/admin/run-escalation', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    if (user.role !== Role.ADMIN) return reply.forbidden('Only admins can trigger escalation');
    return { escalated: await escalateBreachedTickets(prisma) };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.badRequest('Invalid request data');
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return reply.notFound('Resource not found');
    const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ message: error instanceof Error ? error.message : 'Request failed' });
    }
    app.log.error(error);
    return reply.internalServerError('Internal server error');
  });

  return app;
}
