# PR 2 — Tenant database router

## Scope and invariants

This PR replaces the process-wide business database singleton with a request/job
scope selected from the authenticated server session. It does not add public
registration, activation grants, subscriptions, or tenant provisioning.

The invariants are:

1. `sessions.active_tenant_id` is the only authority for authenticated business
   requests. Tenant-looking headers, query parameters, and request bodies never
   select a database.
2. Public endpoints use an explicit server-side host/slug mapping. Missing
   mapping fails closed.
3. Registry metadata and the referenced connection URL must agree on host,
   database, and role before a connection is attempted.
4. In platform mode, using `@workspace/db` without a tenant context throws.
   There is no implicit fallback to Amazing Studio.
5. Amazing Studio remains mapped to its current business database through
   `env:DEFAULT_TENANT_DATABASE_URL`; its rows are neither copied nor moved.
6. Tenant switching rotates the server session. An in-flight request either
   continues in its original immutable context or is rejected; it can never be
   re-routed to the newly selected tenant.
7. Background jobs enumerate eligible tenants from the platform database and
   acquire a fresh tenant lease for every run.
8. New media and browser upload jobs carry a tenant scope. Legacy unprefixed
   media remains readable only by the Amazing Studio tenant.

## Request flow

1. Load and validate the opaque platform session.
2. Authorize membership, tenant state, role, and CSRF.
3. Resolve `tenant_database_registry` by the session's active tenant ID.
4. Resolve the allow-listed server secret reference and compare its parsed
   physical identity to the registry row.
5. Acquire a bounded cached pool lease.
6. Enter `AsyncLocalStorage` and run every legacy `pool`/Drizzle call through
   that immutable binding.
7. Release the lease on response finish/close.

## Pool lifecycle

- Pools are keyed by tenant ID plus a fingerprint of registry metadata.
- Concurrent first use is deduplicated.
- Pool count and connections per pool are bounded by environment settings.
- Registry rotation retires the previous pool; it closes after active leases
  finish.
- Missing registry, unsupported secret references, metadata mismatch, exhausted
  capacity, and connection failure all return the same redacted unavailable
  result. Connection strings are never returned or logged.
- Shutdown and tests explicitly close the router; route code cannot close a
  process-wide fallback pool.

## Explicit non-request paths

- Google bootstrap resolves only the registered `amazing-studio` tenant.
- `/auth/me`, local legacy login, tenant staff candidates, MCP, and public routes
  acquire an explicit tenant context because they are mounted before the normal
  business guard.
- Startup DDL registered while modules load is deferred until the explicitly
  mapped Amazing Studio database is bound. Provisioning/migrating future tenant
  databases belongs to PR 3.
- Scheduler ticks enumerate active/trial registry rows and run once per tenant.

## Required merge evidence

- PostgreSQL HTTP integration fixture with platform DB + tenant A DB + tenant B
  DB, including identical resource IDs with different canary values.
- Raw `pool.query`, Drizzle, transaction, auth-before-guard, export, concurrent
  A/B requests, missing registry, bad secret, and unreachable pool cases.
- Header/query/body tenant tampering does not affect routing.
- Media paths and browser upload queue jobs cannot cross tenant scope.
- Frontend cache and tenant-scoped runtime state are cleared on every principal
  or tenant scope change.
- Full tests, typecheck, build, migration idempotency, and deploy guard pass.
