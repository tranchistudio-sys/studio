import { createHash } from "node:crypto";

export function normalizeLockedMigrationContent(content) {
  return content.replace(/\r\n?/g, "\n");
}

export function lockedMigrationChecksum(content) {
  return createHash("sha256").update(normalizeLockedMigrationContent(content)).digest("hex");
}

export function verifyLockedMigration(filename, content, checksums) {
  const expected = checksums.get(filename);
  if (!expected) return { locked: false, valid: true, checksum: null };
  const checksum = lockedMigrationChecksum(content);
  return { locked: true, valid: checksum === expected, checksum };
}
