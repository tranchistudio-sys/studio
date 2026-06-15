import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadQueueStore } from "@/lib/upload-queue/store";
import type { UploadJob } from "@/lib/upload-queue/types";

const UploadQueueContext = createContext<UploadJob[]>([]);

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<UploadJob[]>(() => uploadQueueStore.getJobs());
  const qc = useQueryClient();

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
