import { runTenantMigrationOrchestrator } from "../artifacts/api-server/src/platform/tenant-migration-orchestrator.ts";

if (process.env.CI !== "true")
  throw new Error("Template migration runner is CI-only");
const target = new URL(process.env.DATABASE_URL ?? "");
if (!target.protocol.startsWith("postgres"))
  throw new Error("Template target must be PostgreSQL");
if (!["127.0.0.1", "localhost"].includes(target.hostname))
  throw new Error("Template target must be local CI PostgreSQL");
if (target.pathname !== "/tenant_schema_source_staging")
  throw new Error("Unexpected template database");

const version = await runTenantMigrationOrchestrator(target.toString());
console.log(`CI tenant template migrations complete: ${version}`);
