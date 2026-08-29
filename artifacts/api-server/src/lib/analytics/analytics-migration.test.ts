import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const migration = readFileSync(resolve(root, "lib/db/migrations/0005_analytics_attribution.sql"), "utf8");
const runner = readFileSync(resolve(root, "artifacts/api-server/src/migrations.ts"), "utf8");

describe("analytics migration wiring", () => {
  it("is additive and registered in the real startup migration runner", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS attribution");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS analytics_events");
    expect(migration).not.toMatch(/\bDROP\b|\bTRUNCATE\b/i);
    expect(runner).toContain("CREATE TABLE IF NOT EXISTS analytics_events");
    expect(runner).toContain("analytics_events_provider_name_event_id_uidx");
  });
});
