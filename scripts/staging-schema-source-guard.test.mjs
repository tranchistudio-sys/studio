import assert from "node:assert/strict";
import test from "node:test";
import { assertStagingSchemaSourceTarget } from "./staging-schema-source-guard.mjs";

const valid = {
  APP_ENV: "staging",
  STAGING_PROXY_APP: "amazing-studio-staging-db",
  DATABASE_URL:
    "postgresql://role:secret@127.0.0.1:15432/tenant_schema_source_staging",
};

test("accepts only the exact verified staging proxy/database", () => {
  assert.deepEqual(assertStagingSchemaSourceTarget(valid), {
    hostClassification: "verified-staging-proxy",
    database: "tenant_schema_source_staging",
  });
});

for (const [name, patch] of [
  ["production environment", { APP_ENV: "production" }],
  [
    "production host",
    {
      DATABASE_URL:
        "postgresql://role:secret@production.internal/tenant_schema_source_staging",
    },
  ],
  [
    "tenant database",
    {
      DATABASE_URL: "postgresql://role:secret@127.0.0.1:15432/tenant_customer",
    },
  ],
  ["unverified localhost", { STAGING_PROXY_APP: "" }],
  ["empty URL", { DATABASE_URL: "" }],
])
  test(`rejects ${name}`, () =>
    assert.throws(() =>
      assertStagingSchemaSourceTarget({ ...valid, ...patch }),
    ));
