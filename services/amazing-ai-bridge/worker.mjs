import { resolveWorktree, invocation, PROVIDER } from "../../safe-worker.mjs";
import { transition } from "../../x20-state-machine.mjs";

export async function prepareTask(task) {
  const worktree = await resolveWorktree(task.taskId);
  let state = { ...task, status: "QUEUED", commitSha: task.baseSha };
  state = transition(state, "ANALYZING");
  state = transition(state, "CODING");
  const command = invocation(task.mode, worktree, { X20_API_KEY: process.env.X20_API_KEY || "" });
  if (command.args.includes("--dangerously-bypass-approvals-and-sandbox")) throw new Error("UNSAFE_BYPASS");
  return { state, worktree, provider: PROVIDER, command: { ...command, env: { ...command.env, X20_API_KEY: command.env.X20_API_KEY ? "<INJECTED>" : "" } } };
}
