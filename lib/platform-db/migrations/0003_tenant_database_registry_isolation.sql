-- PLATFORM DATABASE ONLY. Enforce the database-per-tenant invariant.
-- A different database_ref must never let two tenants share one physical DB.

CREATE UNIQUE INDEX IF NOT EXISTS tenant_database_registry_physical_database_unique
  ON tenant_database_registry (host_ref, database_name);
