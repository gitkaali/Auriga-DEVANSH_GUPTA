# Auriga Helpdesk

A production-oriented generic helpdesk ticket management system focused on deterministic queue ordering, response-time commitments, auditable SLA escalation, and server-side authorization.

## Features

- Queue-first responsive React interface
- Deterministic backend queue ordering with overdue tickets first
- One-level-per-run automatic SLA escalation
- PostgreSQL relational persistence with Prisma migrations
- Admin and agent roles with server-side ticket visibility boundaries
- Secure HTTP-only sessions, Argon2id password hashing, CSRF validation, security headers, and rate limiting
- Ticket CRUD, assignment fields, status/priority/deadline changes, search, filters, pagination, dashboard metrics, ticket detail, audit history, and admin deletion
- Pure unit tests for queue and escalation rules

## Technology Stack

- React, TypeScript, Vite
- Fastify, TypeScript, Prisma
- PostgreSQL 17
- Vitest
- Docker Compose for local PostgreSQL

## Architecture

The `backend` package owns authentication, authorization, validation, database access, queue ordering, audit history, and escalation. The `frontend` package only renders API results and submits user actions. Agent queue, detail, audit, and dashboard data are filtered again on the server. A separate scheduler process calls the same escalation service as the API, so escalation does not depend on a browser being open.

See [REASONING.md](REASONING.md) for the design decisions and tradeoffs.

## Prerequisites

- Node.js 20 or newer
- npm
- Docker and Docker Compose

## Installation

```bash
npm install --prefix backend
npm install --prefix frontend
cp backend/.env.example backend/.env
docker compose up -d postgres
cd backend && npm exec -- prisma migrate dev --name init --schema prisma/schema.prisma
```

Change `SESSION_SECRET` in `backend/.env` to a long random value before using the application outside local development. Do not commit `.env`.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Application secret; currently reserved for future key rotation and must be long/random |
| `CORS_ORIGIN` | Exact permitted browser origin |
| `PORT` | API port, default `3000` |
| `ESCALATION_INTERVAL_MS` | Scheduler interval, default `60000` |
| `NODE_ENV` | `development`, `test`, or `production` |

## Local Execution

Start the API and scheduler in separate terminals:

```bash
npm run dev:api
cd backend && npm run scheduler
```

Start the frontend in another terminal:

```bash
npm run dev:web
```

Open `http://localhost:5173`. On a new database, use **First-time setup** once to create the initial administrator. Initial registration closes after the first user exists.

## Database

Prisma schema: `backend/prisma/schema.prisma`.

Useful commands:

```bash
cd backend
npm run db:generate
npm exec -- prisma migrate dev --name describe-change
npm run db:studio
```

Migrations are version-controlled. PostgreSQL is the intended runtime database; SQLite is not supported because the queue and concurrency behavior rely on relational transactions and row-level update semantics.

## Tests and Checks

```bash
npm test
npm run build
npm run lint
```

The current automated tests cover queue tie-breakers, overdue behavior, status exclusions, one-level escalation, non-breached tickets, terminal priorities, and duplicate candidates in one run. The API smoke path can be tested with the health endpoint and the registration/create/list flow described above.

## API Overview

- `POST /api/auth/register` - first administrator bootstrap only
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/tickets` - server-side search, filters, deterministic ordering, and pagination
- `POST /api/tickets`, `GET /api/tickets/:id`, `PATCH /api/tickets/:id`, `DELETE /api/tickets/:id`
- `GET /api/tickets/:id/audit`
- `GET /api/dashboard`
- `POST /api/admin/run-escalation` - admin-only operational trigger
- `GET /health`

State-changing requests require the CSRF token mirrored from the non-HttpOnly `csrf` cookie in the `x-csrf-token` header. Authentication uses an HttpOnly `sid` cookie containing an opaque session token whose hash is stored in PostgreSQL.

## Scheduler and Escalation

Run the scheduler as a separate process:

```bash
cd backend && npm run scheduler
```

For each run, breached active `NORMAL` tickets become `HIGH`, and breached active `HIGH` tickets become `URGENT`. `URGENT`, resolved, closed, and non-breached tickets are unchanged. The ticket update and `SYSTEM` audit record are committed together. Conditional updates make repeated or concurrent runs safe.

## Debugging

- Check PostgreSQL with `docker compose ps`.
- Check API health with `curl http://localhost:3000/health`.
- Inspect data with `cd backend && npm run db:studio`.
- Run `npm run build` after changes to catch backend or frontend type errors.
- API production errors intentionally return generic messages; inspect server logs locally for operational failures, never client responses.

## Security Considerations

Inputs are validated with Zod, queries use Prisma or parameterized SQL, writable ticket fields are explicit, output is rendered through React escaping, CORS is allowlisted, security headers are enabled, and authentication is rate-limited. Passwords, session tokens, and secrets are not written to audit records or logs. This application is not claimed to be 100% secure.

Remaining limitations are documented in [REASONING.md](REASONING.md), including the need for deployment-level TLS, a managed rate-limit strategy for multiple API replicas, operational secret rotation, and expanded browser/security integration coverage before public production launch.

## Deployment

Build both packages with `npm run build`. Run the compiled API and scheduler as separate processes behind a TLS-terminating reverse proxy. Provide production environment variables through the deployment secret manager, use a least-privilege PostgreSQL role, run migrations as a release step, restrict network access to PostgreSQL, and configure backups, monitoring, log retention, and alerting.

## Evaluation Conversation Log

See [AI_LOGS.md](AI_LOGS.md). It intentionally contains only the required placeholder until the candidate supplies the complete unmodified conversation.