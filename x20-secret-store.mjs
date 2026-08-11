import fs from "node:fs/promises";
import path from "node:path";
export function createSecretStore(dir) {
  const file = path.join(dir, "x20-api-key");
  return { async save(value) { if (!value || typeof value !== "string") throw new Error("SECRET_REQUIRED"); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.writeFile(file, value, { mode: 0o600 }); }, async configured() { try { await fs.access(file); return true; } catch { return false; } }, async read() { return fs.readFile(file, "utf8"); }, async delete() { await fs.rm(file, { force: true }); } };
}
export function redact(value) { return String(value).replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>").replace(/(api[_-]?key|password|token)[=:]\s*\S+/gi, "$1=<REDACTED>"); }
