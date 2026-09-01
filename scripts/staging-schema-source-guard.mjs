const EXPECTED_DATABASE = "tenant_schema_source_staging";
const EXPECTED_INTERNAL_HOST = "amazing-studio-staging-db.internal";
const EXPECTED_PROXY_APP = "amazing-studio-staging-db";

export function assertStagingSchemaSourceTarget(env = process.env) {
  if (env.APP_ENV !== "staging")
    throw new Error("Schema bootstrap requires APP_ENV=staging");
  if (!env.DATABASE_URL?.trim())
    throw new Error("Schema bootstrap DATABASE_URL is missing");
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("Schema bootstrap DATABASE_URL is invalid");
  }
  if (!url.protocol.startsWith("postgres"))
    throw new Error("Schema bootstrap target is not PostgreSQL");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== EXPECTED_DATABASE)
    throw new Error(`Schema bootstrap database must be ${EXPECTED_DATABASE}`);
  const host = url.hostname.toLowerCase();
  const isInternal = host === EXPECTED_INTERNAL_HOST;
  const isVerifiedProxy =
    ["127.0.0.1", "localhost"].includes(host) &&
    env.STAGING_PROXY_APP === EXPECTED_PROXY_APP;
  if (!isInternal && !isVerifiedProxy)
    throw new Error("Schema bootstrap host is not the staging database app");
  return {
    hostClassification: isInternal
      ? "staging-internal"
      : "verified-staging-proxy",
    database,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const identity = assertStagingSchemaSourceTarget();
  console.log(
    `Schema bootstrap target verified: host=${identity.hostClassification} database=${identity.database}`,
  );
}
import { pathToFileURL } from "node:url";
