import { isPlatformDatabaseConfigured } from "@workspace/platform-db";
import { forEachRoutableTenant } from "../platform/tenant-database-router";

export type BusinessJobRunner = (work: () => Promise<void>) => Promise<void>;

export const runBusinessJob: BusinessJobRunner = async (work) => {
  if (!isPlatformDatabaseConfigured()) {
    await work();
    return;
  }
  await forEachRoutableTenant(async () => work());
};
