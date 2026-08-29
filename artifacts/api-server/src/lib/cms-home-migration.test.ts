import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const migration = readFileSync(resolve(root, "lib/db/migrations/0006_cms_home_wedding_intro.sql"), "utf8");
const runner = readFileSync(resolve(root, "artifacts/api-server/src/migrations.ts"), "utf8");

const requiredColumns = [
  "wedding_intro_image_1_url",
  "wedding_intro_image_2_url",
  "wedding_intro_image_3_url",
  "wedding_intro_image_1_fit",
  "wedding_intro_image_2_fit",
  "wedding_intro_image_3_fit",
  "wedding_intro_image_1_x",
  "wedding_intro_image_1_y",
  "wedding_intro_image_1_zoom",
  "wedding_intro_image_2_x",
  "wedding_intro_image_2_y",
  "wedding_intro_image_2_zoom",
  "wedding_intro_image_3_x",
  "wedding_intro_image_3_y",
  "wedding_intro_image_3_zoom",
];

describe("CMS home wedding intro migration", () => {
  it.each(requiredColumns)("adds %s idempotently", (column) => {
    expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    expect(runner).toContain(`\"${column}\"`);
  });
});
