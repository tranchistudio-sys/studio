import { runTenantMigrationOrchestrator } from "../artifacts/api-server/src/platform/tenant-migration-orchestrator.ts";
import { assertStagingSchemaSourceTarget } from "./staging-schema-source-guard.mjs";

assertStagingSchemaSourceTarget();
const version = await runTenantMigrationOrchestrator(process.env.DATABASE_URL);
console.log(`Ordered tenant migrations applied through ${version}`);
