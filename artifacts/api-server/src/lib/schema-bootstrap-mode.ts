export function isSchemaBootstrapOnly(): boolean {
  return process.env.SCHEMA_BOOTSTRAP_ONLY === "1";
}
