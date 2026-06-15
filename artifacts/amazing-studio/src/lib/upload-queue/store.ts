import { convertToWebP, uploadFileViaPresign } from "@/lib/image-upload";
import { idbDeleteBlob, idbLoadBlob, idbSaveBlob } from "./idb";
import { applyUploadJob, attachQueryKeys } from "./attach-handlers";
import type { UploadAttachTarget, UploadJob, UploadJobListener, InvalidateListener } from "./types";

const STORAGE_KEY = "amazingUploadQueue_v1";
const MAX_RETRIES = 4;

function loadJobs(): UploadJob[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const jobs = JSON.parse(raw) as UploadJob[];
    return jobs.map(j => {
      let attach = j.attach;
      if (attach && !("entity" in attach) && "dressId" in (attach as object)) {
        const legacy = attach as { dressId?: number; mode?: "album" | "cover" };
        attach = { entity: "dress" as const, mode: legacy.mode ?? "album", dressId: legacy.dressId };
      }
      return { ...j, previewUrl: "", attach };
    });
  } catch {
    return [];
  }
}

function saveJobs(jobs: UploadJob[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
}

class UploadQueueStore {
  private jobs: UploadJob[] = loadJobs();
  private listeners = new Set<UploadJobListener>();
  private invalidateListeners = new Set<InvalidateListener>();
  private processing = false;
  private blobs = new Map<string, Blob>();

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => void this.processQueue());
      void this.hydratePending();
    }
  }

  subscribe(fn: UploadJobListener): () => void {
    this.listeners.add(fn);
    fn(this.jobs);
    return () => this.listeners.delete(fn);
  }

  onInvalidate(fn: InvalidateListener): () => void {
    this.invalidateListeners.add(fn);
    return () => this.invalidateListeners.delete(fn);
  }

  getJobs(): UploadJob[] {
    return this.jobs;
  }

  getActiveCount(): number {
    return this.jobs.filter(j => j.status === "pending" || j.status === "uploading").length;
  }

  getJob(id: string): UploadJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  private emit() {
    saveJobs(this.jobs);
    for (const fn of this.listeners) fn(this.jobs);
  }

  private notifyInvalidate(keys: string[][]) {
    if (!keys.length) return;
    for (const fn of this.invalidateListeners) fn(keys);
  }

  private patch(id: string, patch: Partial<UploadJob>) {
    this.jobs = this.jobs.map(j => j.id === id ? { ...j, ...patch, updatedAt: Date.now() } : j);
    this.emit();
  }

  async enqueue(file: File, attach?: UploadAttachTarget): Promise<string> {
    const id = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    const job: UploadJob = {
      id,
      status: "pending",
      fileName: file.name || "ảnh",
      previewUrl,
      progress: 0,
      retries: 0,
      attach,
      applied: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.blobs.set(id, file);
    await idbSaveBlob(id, file);
    this.jobs = [job, ...this.jobs];
    this.emit();
    void this.processQueue();
    return id;
  }

  /** Bind dressId to queued jobs (save-first flow). Keeps per-job album/cover mode. */
  bindDressJobs(jobIds: string[], dressId: number) {
    const set = new Set(jobIds);
    this.jobs = this.jobs.map(j => {
      if (!set.has(j.id) || j.attach?.entity !== "dress") return j;
      return {
        ...j,
        attach: { entity: "dress", mode: j.attach.mode, dressId },
        updatedAt: Date.now(),
      };
    });
    this.emit();
    for (const j of this.jobs) {
      if (set.has(j.id) && j.status === "uploaded" && j.objectPath && !j.applied) {
        void this.tryApply(j.id);
      }
    }
  }

  /** @deprecated use bindDressJobs */
  attachJobs(jobIds: string[], attach: { dressId: number; mode: "album" | "cover" }) {
    this.bindDressJobs(jobIds, attach.dressId);
  }

  retryJob(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.status !== "failed") return;
    this.patch(id, { status: "pending", error: undefined, progress: 0, applied: false });
    void this.processQueue();
  }

  removeJob(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (job?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(job.previewUrl);
    this.blobs.delete(id);
    void idbDeleteBlob(id);
    this.jobs = this.jobs.filter(j => j.id !== id);
    this.emit();
  }

  private async hydratePending() {
    for (const job of this.jobs) {
      if (job.status === "uploading") {
        this.patch(job.id, { status: "pending", progress: 0 });
      }
      const needsBlob = job.status === "pending" || job.status === "failed";
      if (needsBlob || !job.previewUrl) {
        const blob = await idbLoadBlob(job.id);
        if (blob) {
          this.blobs.set(job.id, blob);
          if (!job.previewUrl?.startsWith("blob:")) {
            this.patch(job.id, { previewUrl: URL.createObjectURL(blob) });
          }
        }
      }
      if (job.status === "uploaded" && job.objectPath && job.attach?.dressId && !job.applied) {
        void this.tryApply(job.id);
      }
    }
    void this.processQueue();
  }

  private async getBlob(job: UploadJob): Promise<Blob | null> {
    if (this.blobs.has(job.id)) return this.blobs.get(job.id)!;
    const blob = await idbLoadBlob(job.id);
    if (blob) this.blobs.set(job.id, blob);
    return blob;
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const next = this.jobs.find(j => j.status === "pending");
        if (!next) break;
        await this.runJob(next);
      }
    } finally {
      this.processing = false;
    }
  }

  private async runJob(job: UploadJob) {
    const blob = await this.getBlob(job);
    if (!blob) {
      this.patch(job.id, { status: "failed", error: "Không tìm thấy file — chọn lại ảnh" });
      return;
    }
    this.patch(job.id, { status: "uploading", progress: 10, error: undefined });
    try {
      const { blob: webp, mimeType } = await convertToWebP(blob);
      this.patch(job.id, { progress: 40 });
      const outName = job.fileName.replace(/\.[^.]+$/, "") + ".webp";
      const objectPath = await uploadFileViaPresign(webp, outName, mimeType);
      this.patch(job.id, { status: "uploaded", progress: 100, objectPath, mimeType });
      this.blobs.delete(job.id);
      await idbDeleteBlob(job.id);
      await this.tryApply(job.id);
    } catch (err) {
      const retries = job.retries + 1;
      if (retries < MAX_RETRIES) {
        this.patch(job.id, { status: "pending", retries, progress: 0, error: `Thử lại (${retries}/${MAX_RETRIES})…` });
        await new Promise(r => setTimeout(r, 800 * retries));
        void this.processQueue();
      } else {
        this.patch(job.id, { status: "failed", retries, error: String(err).replace(/^Error:\s*/, "") });
      }
    }
  }

  private async tryApply(jobId: string) {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job || job.status !== "uploaded" || !job.objectPath || job.applied) return;
    if (!job.attach?.dressId) return;
    try {
      await applyUploadJob(job);
      this.patch(jobId, { applied: true });
      this.notifyInvalidate(attachQueryKeys(job.attach));
    } catch (e) {
      console.error("apply upload failed", e);
      this.patch(jobId, {
        status: "failed",
        error: e instanceof Error ? e.message : "Không gắn được ảnh vào sản phẩm",
        applied: false,
      });
    }
  }
}

export const uploadQueueStore = new UploadQueueStore();

export function waitForUploadJob(id: string): Promise<{ objectPath: string; mimeType: string; name: string }> {
  return new Promise((resolve, reject) => {
    const unsub = uploadQueueStore.subscribe((jobs) => {
      const j = jobs.find(x => x.id === id);
      if (!j) return;
      if (j.status === "uploaded" && j.objectPath) {
        unsub();
        resolve({ objectPath: j.objectPath, mimeType: j.mimeType ?? "image/webp", name: j.fileName });
      }
      if (j.status === "failed") {
        unsub();
        reject(new Error(j.error ?? "Upload thất bại"));
      }
    });
  });
}
