import { resolveWorktree, invocation, PROVIDER } from "../../safe-worker.mjs";
import { transition } from "../../x20-state-machine.mjs";

let stopping = false;
export async function processTask(task) {
  const cwd = await resolveWorktree(task.taskId); let state = { ...task, status: "QUEUED", commitSha: task.baseSha };
  state = transition(state, "ANALYZING"); state = transition(state, "CODING");
  const command = invocation(task.mode, cwd, { X20_API_KEY: process.env.X20_API_KEY || "" });
  if (command.args.includes("--dangerously-bypass-approvals-and-sandbox")) throw new Error("UNSAFE_BYPASS");
  return { state: transition(state, "TESTING"), cwd, provider: PROVIDER, command };
}
export function startPolling(queue, interval = 1000) { let timer; const tick = async () => { if (stopping) return; const task = await queue.next(); if (task) await processTask(task); timer = setTimeout(tick, interval); }; timer = setTimeout(tick, 0); return () => { stopping = true; clearTimeout(timer); }; }
if (process.env.X20_WORKER_TEST_MODE !== "true") startPolling({ next: async () => null });
process.on("SIGTERM", () => { stopping = true; }); process.on("SIGINT", () => { stopping = true; });
