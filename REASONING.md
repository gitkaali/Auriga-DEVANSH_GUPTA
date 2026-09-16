# Engineering Reasoning

## Problem Interpretation

The central invariant is a backend-owned active queue. The frontend must display the server's ordering, not recreate it. SLA escalation is a separate scheduled concern and must be safe under repeated and concurrent execution.

## Queue Ordering

The queue excludes `RESOLVED` and `CLOSED` tickets. Overdue status is computed at query time as `current_time > promised_response_at`, which lets a ticket move groups as time passes without a state mutation. The SQL order is overdue group, explicit priority rank, promised response time, creation time, and ID. The final ID tie-breaker makes pagination deterministic.

The query uses parameterized Prisma SQL fragments. Search and filters are applied before the order and offset/limit, so pagination does not change the business ordering.

## Escalation Design

`backend/src/domain/escalation.ts` contains pure escalation rules. The database service selects active breached tickets with non-terminal priorities, then conditionally updates each row and writes a system audit record in one transaction. A `NORMAL` ticket can become only `HIGH` in a run; a later run may move it to `URGENT`. `URGENT` has no next level.

The scheduler is a dedicated process with a configurable interval. The API also exposes an admin-only manual trigger for operations. Conditional update predicates protect against concurrent API edits or another scheduler instance: only one process can update a ticket from the expected old priority.

## Data Model

Users, opaque sessions, tickets, and audit records are separate relational models. Foreign keys preserve ownership and assignment relationships. Audit records identify user versus system actors and never contain credentials.

## Architecture Decisions

Fastify and Prisma provide a small TypeScript backend with explicit schemas and a mature relational client. React/Vite keeps the browser application lightweight. The domain functions do not import Fastify or Prisma, which makes the highest-risk rules cheap to test.

Session cookies were chosen over browser-stored bearer tokens. Session tokens are random and only their SHA-256 hashes are stored. The cookie is HttpOnly and SameSite strict; state-changing requests also require a CSRF header matching a separate cookie.

Ticket authorization is centralized in `backend/src/domain/authorization.ts`. Administrators have full ticket access. Agents can access tickets they created or that are assigned to them, and can modify only tickets assigned to them. The same visibility predicate is applied to queue results, ticket detail, audit history, and dashboard aggregates to prevent read-side IDOR/BOLA leaks.

## Indexes and Performance

Indexes cover status/deadline, priority/deadline, assignment/status, customer name, creation time, and audit history. The queue uses a parameterized SQL query because Prisma's ordinary `orderBy` cannot express the required dynamic overdue and enum-rank ordering in one portable query. The current queue query is intentionally readable; large deployments should benchmark it with `EXPLAIN ANALYZE` and add a search-specific index strategy if customer-name search volume requires it.

## Edge Cases

- Exact equality with the deadline is not overdue; only a later current time is overdue.
- Resolved and closed tickets cannot be overdue or escalated.
- Urgent tickets do not escalate further.
- A breached normal ticket never jumps directly to urgent.
- Assignment can be cleared with `null`, while only administrators can change assignment.
- The last active administrator cannot be deactivated or demoted.
- Unknown IDs return safe not-found responses.
- Invalid bodies and query values return safe validation errors.

## Testing Strategy

Unit tests cover queue ordering, pure escalation behavior, and authorization policy. PostgreSQL-backed integration tests cover authentication, CSRF enforcement, agent visibility, assigned-ticket access, and IDOR prevention. Before public production deployment, add broader authorization matrix coverage for every route and Playwright coverage for login, filtering, pagination, destructive actions, and responsive queue behavior.

## Tradeoffs and Remaining Limitations

The current implementation favors a simple scheduler process over introducing Redis or a job broker. PostgreSQL row locks and conditional updates provide correctness for concurrent scheduler instances, but a larger deployment should add worker observability, distributed rate limiting, and explicit leader/lease management if scheduler volume grows. Admin user creation and activation/role management are exposed through protected API routes; production should add an audited administrative UI workflow if operators need to manage users frequently.

The UI now provides ticket creation, status/priority/deadline changes, assignment, ticket detail, audit history, deletion confirmation, and priority/status breakdowns. A richer admin user-management surface is still appropriate for a full operational rollout. Production also requires TLS, secret rotation, backups, monitoring, dependency review, and a formal threat model.

The final local `npm audit --omit=dev` check reported three high-severity advisories through Prisma's tooling dependency chain. npm's suggested remediation is a forced, breaking version change, so it was not applied blindly. This must be resolved and regression-tested as part of dependency maintenance before public production deployment.