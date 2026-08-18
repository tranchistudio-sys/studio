import assert from "node:assert/strict";
import { processTask, startPolling } from "./worker.mjs";
const id = "00000000-0000-4000-8000-000000000001";
const stop = startPolling({ next: async () => ({ taskId: id, baseSha: "abc", mode: "readonly" }) }, 10); await new Promise(r => setTimeout(r, 30)); stop();
assert.equal(typeof processTask, "function");
console.log("WORKER_ENTRYPOINT_TEST_PASS");
