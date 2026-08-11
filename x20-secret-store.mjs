import fs from "node:fs/promises";
import path from "node:path";
export function createSecretStore(dir) {
  const file = path.join(dir, "x20-api-key");
  const state = { active: false };
  return {
    async save(value) { if (!value || typeof value !== "string") throw new Error("SECRET_REQUIRED"); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${process.pid}`; await fs.writeFile(tmp, value, { mode: 0o600 }); await fs.chmod(tmp, 0o600); await fs.rename(tmp, file); state.active = true; },
    async rotate(value) { return this.save(value); },
    async configured() { try { await fs.access(file); return true; } catch { return false; } },
    async active() { return state.active && await this.configured(); },
    async deactivate() { state.active = false; },
    async activate() { if (!await this.configured()) throw new Error("SECRET_NOT_CONFIGURED"); state.active = true; },
    async read() { return fs.readFile(file, "utf8"); },
    async delete() { await fs.rm(file, { force: true }); state.active = false; },
  };
}
export function redact(value) { return String(value).replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>").replace(/(api[_-]?key|password|token)[=:]\s*\S+/gi, "$1=<REDACTED>"); }
