import type { BusinessJobRunner } from "./lib/tenant-job-runner";
import { retryFailedMetaCapiEvents } from "./lib/analytics/meta-capi";

export function startAnalyticsRetryScheduler(runJob: BusinessJobRunner): void {
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_ACCESS_TOKEN) return;
  const run = () => void runJob(async () => { await retryFailedMetaCapiEvents(); }).catch((error) => {
    console.warn("[analytics] CAPI retry sweep failed", { error: error instanceof Error ? error.message : "unknown" });
  });
  setTimeout(run, 30_000);
  setInterval(run, 5 * 60_000);
}
