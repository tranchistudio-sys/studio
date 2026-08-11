import assert from "node:assert/strict";
import { invocation, PROVIDER } from "./safe-worker.mjs";
assert.equal(invocation("readonly", "/tmp/wt").args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
assert.equal(invocation("readonly", "/tmp/wt").args[2], "read-only");
assert.equal(invocation("fix", "/tmp/wt").args[2], "workspace-write");
assert.equal(invocation("fix", "/tmp/wt").args.includes("/opt/amazing-studio/app"), false);
assert.equal(PROVIDER.family, "responses");
console.log("SAFE_WORKER_TESTS_PASS");
