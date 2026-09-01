# Permanent staging and first-pilot runbook

## Boundary and inventory

Permanent staging uses only these resources:

- App: `amazing-studio-staging` (`https://amazing-studio-staging.fly.dev`)
- PostgreSQL app: `amazing-studio-staging-db`
- Platform database: `amazing_platform_staging`
- Clean tenant template: `tenant_template_staging`
- Clean Amazing compatibility fixture: `tenant_amazing_staging`
- Runtime roles: `staging_platform` and `staging_legacy`
- Provisioning role: `staging_provisioner` with `LOGIN CREATEDB CREATEROLE NOSUPERUSER`

Production is not a source, target, fallback, or rollback destination. The template source must be a reviewed schema-only staging secret; it must never point at production. Never paste credentials into a ticket, log, command transcript, or this document.

## One-time prerequisites

The GitHub environment `staging` must exist. The workflow fails when any required `STAGING_*` secret is absent. `STAGING_SCHEMA_SOURCE_DATABASE_URL` must point to a non-production database whose schema matches the current tenant schema; only `pg_dump --schema-only --no-owner --no-privileges` is consumed. Validate its identity before setting it.

In Google Cloud, add exactly this JavaScript origin to the existing web OAuth client:

`https://amazing-studio-staging.fly.dev`

Do not add a wildcard and do not weaken token validation. The public client ID is stored as `STAGING_GOOGLE_CLIENT_ID`; no Google client secret is required for login.

## Deploy and migrate

Run **Deploy Permanent Staging** manually against an approved commit. The workflow builds/tests before mutation, creates only the two fixed staging Fly apps, applies the ordered platform migration runner twice (idempotency proof), deploys `fly.staging.toml`, then checks `/api/healthz` and `/api/auth/config`.

Before any manual database command, verify all three:

1. Fly app is `amazing-studio-staging-db`.
2. Host is `amazing-studio-staging-db.internal` (or a local Fly proxy to that app).
3. Database is one of `postgres`, `amazing_platform_staging`, `tenant_template_staging`, or an explicitly recorded staging tenant database.

Stop on any mismatch. Platform migrations are run through `pnpm --filter @workspace/platform-db migrate`; `db push` is forbidden.

## Pilot acceptance

Use the public signup UI to create “Pilot Studio Test”; do not insert its commercial records with SQL. In Platform Admin, perform contact, approval, PAID or explicitly WAIVED setup payment, and activation. Record the provisioning job ID and verify:

- signup, tenant, and subscription are ACTIVE with a valid period;
- job is COMPLETED and registry health is healthy;
- tenant metadata contains the exact tenant UUID and current schema version;
- OWNER membership points to the owner staff row;
- customers, bookings, payments, expenses, and contracts are zero.

Repeat for tenant B. Create distinct canaries in customers, bookings, payments, staff, and contracts and prove A cannot read B and B cannot read A through authenticated APIs. Remove test canaries afterward.

Owner acceptance must use a real Google identity on the fixed staging hostname. Verify active tenant is “Pilot Studio Test”, then load dashboard and business APIs. A Platform Owner impersonation or fake-token bypass is not acceptable evidence.

## Failure, retry, backup, and restore drills

Run each failure only against disposable staging tenants: wrong metadata, controlled migration failure, missing uncommitted tenant secret, registry conflict, and worker interruption. Every case must remain non-ACTIVE, expose only a sanitized error, and retry without duplicating database, membership, or subscription. Correct the injected condition and verify retry reaches COMPLETED.

Back up the pilot tenant with `pg_dump` through a Fly proxy. Restore into a newly named staging-only database, then compare metadata, migration checksum/version, table counts, and selected canaries. Do not register the restored database as production or alter the pilot registry during this drill. Delete only after the evidence has been reviewed.

## Rollback

Application rollback means deploying the previously approved staging image/commit to `amazing-studio-staging`. Database migrations are forward-only; restore a staging backup into a new staging database when data rollback is required. Never deploy, migrate, provision, rotate, or restore production as part of this runbook.
