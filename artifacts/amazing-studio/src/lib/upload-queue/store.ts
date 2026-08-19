import { convertToWebP, uploadFileViaPresign } from "@/lib/image-upload";
import { idbDeleteBlob, idbLoadBlob, idbSaveBlob } from "./idb";
import { applyUploadJob, attachQueryKeys } from "./attach-handlers";
import type {
  UploadAttachTarget,
  UploadJob,
  UploadJobListener,
  InvalidateListener,
  UploadQueueScope,
} from "./types";

const STORAGE_KEY_PREFIX = "amazingUploadQueue_v2:";
const MAX_RETRIES = 4;

function queueStorageKey(scopeKey: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
}

function sameScope(a: UploadQueueScope | null, b: UploadQueueScope | null): boolean {
  return a?.key === b?.key;
}

function isScopedJob(value: unknown, scope: UploadQueueScope): value is UploadJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<UploadJob>;
  return Boolean(
    typeof job.id === "string" &&
    job.scope?.key === scope.key &&
    job.scope.tenantId === scope.tenantId &&
    job.scope.membershipId === scope.membershipId &&
    job.scope.userId === scope.userId,
  );
}

function loadJobs(scope: UploadQueueScope): UploadJob[] {
  try {
    const raw = localStorage.getItem(queueStorageKey(scope.key));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(job => isScopedJob(job, scope)).map(job => ({
      ...job,
      // Blob URLs are valid only for the document that created them.
      previewUrl: "",
    }));
  } catch {
    return [];
  }
}

function saveJobs(scope: UploadQueueScope, jobs: UploadJob[]): void {
  try {
    localStorage.setItem(queueStorageKey(scope.key), JSON.stringify(jobs));
  } catch {
    // Storage can be unavailable/full. The in-memory queue remains usable.
  }
}

/**
 * Tenant-aware background upload queue.
 *
 * The store starts paused and is activated only after StaffAuthProvider has a
 * concrete tenant/user/membership scope. Every async continuation verifies the
 * generation again, so a job from tenant A cannot be applied after switching
 * to tenant B even if the underlying upload ignores AbortSignal.
 */
export class UploadQueueStore {
  private scope: UploadQueueScope | null = null;
  private jobs: UploadJob[] = [];
  private listeners = new Set<UploadJobListener>();
  private invalidateListeners = new Set<InvalidateListener>();
  private runningGenerations = new Set<number>();
  private generation = 0;
  private abortController: AbortController | null = null;
  private blobs = new Map<string, Blob>();

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => void this.processQueue());
    }
  }

  setScope(nextScope: UploadQueueScope | null): void {
    if (sameScope(this.scope, nextScope)) return;

    this.generation += 1;
    this.abortController?.abort();
    this.abortController = nextScope ? new AbortController() : null;
    for (const job of this.jobs) {
      if (job.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(job.previewUrl);
    }
    this.blobs.clear();
    this.scope = nextScope ? { ...nextScope } : null;
    this.jobs = this.scope ? loadJobs(this.scope) : [];
    this.broadcast(false);

    if (this.scope) void this.hydratePending(this.scope, this.generation);
  }

  getScopeKey(): string | null {
    return this.scope?.key ?? null;
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
    return this.jobs.filter(job => job.status === "pending" || job.status === "uploading").length;
  }

  getJob(id: string): UploadJob | undefined {
    return this.jobs.find(job => job.id === id);
  }

  private broadcast(persist = true): void {
    if (persist && this.scope) saveJobs(this.scope, this.jobs);
    for (const listener of this.listeners) listener(this.jobs);
  }

  private notifyInvalidate(keys: string[][]): void {
    if (!keys.length) return;
    for (const listener of this.invalidateListeners) listener(keys);
  }

  private isCurrent(job: UploadJob, generation: number): boolean {
    return Boolean(
      this.scope &&
      generation === this.generation &&
      job.scope.key === this.scope.key,
    );
  }

  private patchCurrent(id: string, patch: Partial<UploadJob>): void {
    this.jobs = this.jobs.map(job => job.id === id
      ? { ...job, ...patch, updatedAt: Date.now() }
      : job);
    this.broadcast();
  }

  private patchScoped(job: UploadJob, generation: number, patch: Partial<UploadJob>): boolean {
    if (!this.isCurrent(job, generation)) return false;
    this.patchCurrent(job.id, patch);
    return true;
  }

  async enqueue(file: File, attach?: UploadAttachTarget): Promise<string> {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope) throw new Error("Vui lòng đăng nhập và chọn studio trước khi tải ảnh");

    const id = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    const job: UploadJob = {
      id,
      scope: { ...scope },
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
    await idbSaveBlob(scope.key, id, file);
    if (!this.isCurrent(job, generation)) {
      URL.revokeObjectURL(previewUrl);
      await idbDeleteBlob(scope.key, id).catch(() => {});
      throw new Error("Studio đã thay đổi trước khi ảnh được thêm vào hàng đợi");
    }
    this.blobs.set(id, file);
    this.jobs = [job, ...this.jobs];
    this.broadcast();
    void this.processQueue();
    return id;
  }

  /** Bind dressId to queued jobs (save-first flow). Keeps per-job album/cover mode. */
  bindDressJobs(jobIds: string[], dressId: number): void {
    const ids = new Set(jobIds);
    this.jobs = this.jobs.map(job => {
      if (!ids.has(job.id) || job.attach?.entity !== "dress") return job;
      return {
        ...job,
        attach: { entity: "dress", mode: job.attach.mode, dressId },
        updatedAt: Date.now(),
      };
    });
    this.broadcast();
    const generation = this.generation;
    for (const job of this.jobs) {
      if (ids.has(job.id) && job.status === "uploaded" && job.objectPath && !job.applied) {
        void this.tryApply(job.id, generation);
      }
    }
  }

  /** @deprecated use bindDressJobs */
  attachJobs(jobIds: string[], attach: { dressId: number; mode: "album" | "cover" }): void {
    this.bindDressJobs(jobIds, attach.dressId);
  }

  retryJob(id: string): void {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job || job.status !== "failed") return;
    this.patchCurrent(id, { status: "pending", error: undefined, progress: 0, applied: false });
    void this.processQueue();
  }

  removeJob(id: string): void {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) return;
    if (job.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(job.previewUrl);
    this.blobs.delete(id);
    void idbDeleteBlob(job.scope.key, id);
    this.jobs = this.jobs.filter(candidate => candidate.id !== id);
    this.broadcast();
  }

  private async hydratePending(scope: UploadQueueScope, generation: number): Promise<void> {
    for (const snapshot of [...this.jobs]) {
      if (!this.isCurrent(snapshot, generation)) return;
      let job = this.jobs.find(candidate => candidate.id === snapshot.id);
      if (!job) continue;
      if (job.status === "uploading") {
        this.patchScoped(job, generation, { status: "pending", progress: 0 });
        job = this.jobs.find(candidate => candidate.id === snapshot.id);
        if (!job) continue;
      }
      const needsBlob = job.status === "pending" || job.status === "failed";
      if (needsBlob || !job.previewUrl) {
        const blob = await idbLoadBlob(scope.key, job.id);
        if (!this.isCurrent(job, generation)) return;
        if (blob) {
          this.blobs.set(job.id, blob);
          if (!job.previewUrl?.startsWith("blob:")) {
            this.patchScoped(job, generation, { previewUrl: URL.createObjectURL(blob) });
          }
        }
      }
      const current = this.jobs.find(candidate => candidate.id === snapshot.id);
      if (current?.status === "uploaded" && current.objectPath && current.attach?.dressId && !current.applied) {
        await this.tryApply(current.id, generation);
      }
    }
    if (this.scope?.key === scope.key && generation === this.generation) {
      void this.processQueue();
    }
  }

  private async getBlob(job: UploadJob, generation: number): Promise<Blob | null> {
    if (this.blobs.has(job.id)) return this.blobs.get(job.id)!;
    const blob = await idbLoadBlob(job.scope.key, job.id);
    if (blob && this.isCurrent(job, generation)) this.blobs.set(job.id, blob);
    return blob;
  }

  private async processQueue(): Promise<void> {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope || this.runningGenerations.has(generation)) return;
    this.runningGenerations.add(generation);
    try {
      while (this.scope?.key === scope.key && generation === this.generation) {
        const next = this.jobs.find(job => job.status === "pending");
        if (!next) break;
        await this.runJob(next, generation);
      }
    } finally {
      this.runningGenerations.delete(generation);
    }
  }

  private async runJob(job: UploadJob, generation: number): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || !this.isCurrent(job, generation)) return;
    const blob = await this.getBlob(job, generation);
    if (!this.isCurrent(job, generation) || signal.aborted) return;
    if (!blob) {
      this.patchScoped(job, generation, { status: "failed", error: "Không tìm thấy file — chọn lại ảnh" });
      return;
    }
    this.patchScoped(job, generation, { status: "uploading", progress: 10, error: undefined });
    try {
      const { blob: webp, mimeType } = await convertToWebP(blob);
      if (!this.isCurrent(job, generation) || signal.aborted) return;
      this.patchScoped(job, generation, { progress: 40 });
      const outName = job.fileName.replace(/\.[^.]+$/, "") + ".webp";
      const objectPath = await uploadFileViaPresign(webp, outName, mimeType, "cms-public", {
        signal,
        tenantId: job.scope.tenantId !== "legacy-default" ? job.scope.tenantId : undefined,
      });
      if (!this.isCurrent(job, generation) || signal.aborted) return;
      this.patchScoped(job, generation, { status: "uploaded", progress: 100, objectPath, mimeType });
      this.blobs.delete(job.id);
      await idbDeleteBlob(job.scope.key, job.id);
      if (!this.isCurrent(job, generation) || signal.aborted) return;
      await this.tryApply(job.id, generation);
    } catch (error) {
      if (!this.isCurrent(job, generation) || signal.aborted) return;
      const current = this.jobs.find(candidate => candidate.id === job.id) ?? job;
      const retries = current.retries + 1;
      if (retries < MAX_RETRIES) {
        this.patchScoped(job, generation, {
          status: "pending",
          retries,
          progress: 0,
          error: `Thử lại (${retries}/${MAX_RETRIES})…`,
        });
        await new Promise(resolve => setTimeout(resolve, 800 * retries));
      } else {
        this.patchScoped(job, generation, {
          status: "failed",
          retries,
          error: String(error).replace(/^Error:\s*/, ""),
        });
      }
    }
  }

  private async tryApply(jobId: string, generation: number): Promise<void> {
    const job = this.jobs.find(candidate => candidate.id === jobId);
    const signal = this.abortController?.signal;
    if (!job || !signal || !this.isCurrent(job, generation) || signal.aborted) return;
    if (job.status !== "uploaded" || !job.objectPath || job.applied || !job.attach?.dressId) return;
    try {
      await applyUploadJob(job, signal);
      if (!this.isCurrent(job, generation) || signal.aborted) return;
      this.patchScoped(job, generation, { applied: true });
      this.notifyInvalidate(attachQueryKeys(job.attach));
    } catch (error) {
      if (!this.isCurrent(job, generation) || signal.aborted) return;
      console.error("apply upload failed", error);
      this.patchScoped(job, generation, {
        status: "failed",
        error: error instanceof Error ? error.message : "Không gắn được ảnh vào sản phẩm",
        applied: false,
      });
    }
  }
}

export const uploadQueueStore = new UploadQueueStore();

export function waitForUploadJob(id: string): Promise<{ objectPath: string; mimeType: string; name: string }> {
  const initial = uploadQueueStore.getJob(id);
  if (!initial) return Promise.reject(new Error("Không tìm thấy ảnh trong hàng đợi hiện tại"));
  if (initial.status === "uploaded" && initial.objectPath) {
    return Promise.resolve({
      objectPath: initial.objectPath,
      mimeType: initial.mimeType ?? "image/webp",
      name: initial.fileName,
    });
  }
  if (initial.status === "failed") {
    return Promise.reject(new Error(initial.error ?? "Upload thất bại"));
  }
  const expectedScope = initial.scope.key;
  return new Promise((resolve, reject) => {
    const unsub = uploadQueueStore.subscribe(jobs => {
      if (uploadQueueStore.getScopeKey() !== expectedScope) {
        unsub();
        reject(new Error("Studio đã thay đổi khi ảnh đang được tải"));
        return;
      }
      const job = jobs.find(candidate => candidate.id === id);
      if (!job) return;
      if (job.status === "uploaded" && job.objectPath) {
        unsub();
        resolve({ objectPath: job.objectPath, mimeType: job.mimeType ?? "image/webp", name: job.fileName });
      }
      if (job.status === "failed") {
        unsub();
        reject(new Error(job.error ?? "Upload thất bại"));
      }
    });
  });
}
