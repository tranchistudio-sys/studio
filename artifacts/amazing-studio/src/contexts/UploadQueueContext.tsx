import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { uploadQueueStore } from "@/lib/upload-queue/store";
import type { UploadJob } from "@/lib/upload-queue/types";

const UploadQueueContext = createContext<UploadJob[]>([]);

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<UploadJob[]>(() => uploadQueueStore.getJobs());
  const qc = useQueryClient();
  const { clientScope } = useStaffAuth();

  // Layout effect runs before a newly selected tenant can paint/interact. The
  // store itself starts paused, so import/startup can never resume old jobs.
  useLayoutEffect(() => {
    uploadQueueStore.setScope(clientScope);
    return () => uploadQueueStore.setScope(null);
  }, [clientScope?.key]);
  useEffect(() => uploadQueueStore.subscribe(setJobs), []);
  useEffect(() => uploadQueueStore.onInvalidate((keys) => {
    for (const key of keys) qc.invalidateQueries({ queryKey: key });
  }), [qc]);

  return (
    <UploadQueueContext.Provider value={jobs}>
      {children}
    </UploadQueueContext.Provider>
  );
}

export function useUploadQueue() {
  return useContext(UploadQueueContext);
}

export { uploadQueueStore };
