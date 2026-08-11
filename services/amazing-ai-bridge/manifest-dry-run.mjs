import fs from "node:fs/promises";
const m = JSON.parse(await fs.readFile(new URL("../../deploy/x20-safe-worker-manifest.json", import.meta.url)));
for (const e of m.entries) { if (!e.source || !e.destination || !e.backup || !e.rollback) throw new Error("INCOMPLETE_MANIFEST"); if (e.destination.includes("amazing-studio/app")) throw new Error("PRODUCTION_DESTINATION"); }
console.log("MANIFEST_DRY_RUN_PASS");
