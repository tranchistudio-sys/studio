import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const ROOT = "/opt/amazing-ai-bridge/data/worktrees";
export const PROVIDER = Object.freeze({ provider: "wiseai_provider", name: "AMAZINGSTUDIO", baseUrl: "https://llm.14k7-homelab.io.vn/v1", model: "gpt-5.6-sol", family: "responses", reasoningEffort: "xhigh" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function resolveWorktree(taskId) { if (!uuid.test(taskId)) throw new Error("INVALID_TASK_UUID"); const root = await fs.realpath(ROOT); const resolved = await fs.realpath(path.join(root, taskId)); if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("WORKTREE_ESCAPE"); return resolved; }
export function invocation(mode, cwd, env = {}) { const sandbox = mode === "readonly" ? "read-only" : "workspace-write"; return { command: "codex", args: ["exec", "--sandbox", sandbox, "-C", cwd, "-m", PROVIDER.model], env: { ...env, WISEAI_BASE_URL: PROVIDER.baseUrl, WISEAI_MODEL: PROVIDER.model, WISEAI_REASONING_EFFORT: PROVIDER.reasoningEffort } }; }
export function runSafe(mode, cwd, env = {}, timeout = 180000) { const spec = invocation(mode, cwd, env); return new Promise((resolve, reject) => { const child = spawn(spec.command, spec.args, { cwd, env: { ...process.env, ...spec.env } }); let out = "", err = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += String(d).replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>"); }); const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("CODEX_TIMEOUT")); }, timeout); child.on("error", reject); child.on("close", code => { clearTimeout(timer); code === 0 ? resolve({ out, err, metadata: { taskId: randomUUID(), provider: PROVIDER.provider, model: PROVIDER.model, reasoningEffort: PROVIDER.reasoningEffort, cwd, mode } }) : reject(new Error(`CODEX_EXIT_${code}`)); }); }); }
