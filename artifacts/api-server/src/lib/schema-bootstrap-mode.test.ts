import { afterEach, describe, expect, it } from "vitest";
import { isSchemaBootstrapOnly } from "./schema-bootstrap-mode";

const originalValue = process.env.SCHEMA_BOOTSTRAP_ONLY;

afterEach(() => {
  if (originalValue === undefined) delete process.env.SCHEMA_BOOTSTRAP_ONLY;
  else process.env.SCHEMA_BOOTSTRAP_ONLY = originalValue;
});

describe("isSchemaBootstrapOnly", () => {
  it("is fail-closed unless explicitly enabled", () => {
    delete process.env.SCHEMA_BOOTSTRAP_ONLY;
    expect(isSchemaBootstrapOnly()).toBe(false);
    process.env.SCHEMA_BOOTSTRAP_ONLY = "true";
    expect(isSchemaBootstrapOnly()).toBe(false);
  });

  it("recognizes the isolated schema bootstrap process", () => {
    process.env.SCHEMA_BOOTSTRAP_ONLY = "1";
    expect(isSchemaBootstrapOnly()).toBe(true);
  });
});
