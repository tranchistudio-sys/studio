import fs from "node:fs/promises";
import path from "node:path";
export async function validateRollout({ approvedSha, originMain, manifest, releaseDir }) { if (!approvedSha) throw new Error("APPROVED_SHA_REQUIRED"); if (approvedSha !== originMain) throw new Error("SHA_NOT_ORIGIN_MAIN"); if (manifest.requiresExplicitApproval !== true) throw new Error("EXPLICIT_APPROVAL_REQUIRED"); await fs.mkdir(path.join(releaseDir, approvedSha), { recursive: true }); return true; }
if (process.argv[1]?.endsWith("x20-safe-worker-rollout.mjs")) { const sha = process.argv.find((x, i) => process.argv[i - 1] === "--approved-sha"); if (!sha) { console.error("APPROVED_SHA_REQUIRED"); process.exit(2); } }
