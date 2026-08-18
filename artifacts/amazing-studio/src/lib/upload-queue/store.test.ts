import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadQueueScope } from "./types";

const mocks = vi.hoisted(() => ({
  convertToWebP: vi.fn(),
  uploadFileViaPresign: vi.fn(),
  applyUploadJob: vi.fn(),
  idbSaveBlob: vi.fn(),
  idbLoadBlob: vi.fn(),
  idbDeleteBlob: vi.fn(),
}));

vi.mock("@/lib/image-upload", () => ({
  convertToWebP: mocks.convertToWebP,
  uploadFileViaPresign: mocks.uploadFileViaPresign,
}));
vi.mock("./idb", () => ({
  idbSaveBlob: mocks.idbSaveBlob,
  idbLoadBlob: mocks.idbLoadBlob,
  idbDeleteBlob: mocks.idbDeleteBlob,
}));
vi.mock("./attach-handlers", () => ({
  applyUploadJob: mocks.applyUploadJob,
  attachQueryKeys: () => [["cms-products"]],
}));

import { UploadQueueStore } from "./store";

const scopeA: UploadQueueScope = {
  key: "tenant:a:membership:ma:user:ua",
  tenantId: "tenant-a",
  membershipId: "membership-a",
  userId: "platform:user-a",
};
const scopeB: UploadQueueScope = {
  key: "tenant:b:membership:mb:user:ua",
  tenantId: "tenant-b",
  membershipId: "membership-b",
  userId: "platform:user-a",
};

function fakeFile(name = "dress.jpg"): File {
  return Object.assign(new Blob(["image"], { type: "image/jpeg" }), { name }) as File;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let storage: Map<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: vi.fn((key: string) => storage.delete(key)),
  });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "job-1") });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
  mocks.idbSaveBlob.mockResolvedValue(undefined);
  mocks.idbLoadBlob.mockResolvedValue(null);
  mocks.idbDeleteBlob.mockResolvedValue(undefined);
  mocks.convertToWebP.mockImplementation(async (blob: Blob) => ({
    blob,
    mimeType: "image/webp",
    width: 10,
    height: 10,
  }));
  mocks.uploadFileViaPresign.mockReset();
  mocks.applyUploadJob.mockReset();
  mocks.applyUploadJob.mockResolvedValue(true);
});

describe("tenant-scoped upload queue", () => {
  it("stays paused until an authenticated tenant scope exists", async () => {
    const store = new UploadQueueStore();

    await expect(store.enqueue(fakeFile())).rejects.toThrow("chọn studio");
    expect(mocks.idbSaveBlob).not.toHaveBeenCalled();
    expect(mocks.uploadFileViaPresign).not.toHaveBeenCalled();
  });

  it("persists every job with tenant, membership and user scope", async () => {
    const upload = deferred<string>();
    mocks.uploadFileViaPresign.mockReturnValue(upload.promise);
    const store = new UploadQueueStore();
    store.setScope(scopeA);

    const id = await store.enqueue(fakeFile(), { entity: "dress", mode: "cover", dressId: 7 });

    expect(store.getJob(id)?.scope).toEqual(scopeA);
    expect(mocks.idbSaveBlob).toHaveBeenCalledWith(scopeA.key, id, expect.any(Blob));
    expect([...storage.keys()]).toEqual([
      `amazingUploadQueue_v2:${encodeURIComponent(scopeA.key)}`,
    ]);
    await vi.waitFor(() => expect(mocks.uploadFileViaPresign).toHaveBeenCalled());
    expect(mocks.uploadFileViaPresign.mock.calls[0]?.[4]).toMatchObject({ tenantId: scopeA.tenantId });
    upload.resolve("/objects/cms-public/job-1");
    await vi.waitFor(() => expect(mocks.applyUploadJob).toHaveBeenCalled());
  });

  it("never applies a tenant A job after switching to tenant B", async () => {
    const upload = deferred<string>();
    mocks.uploadFileViaPresign.mockReturnValue(upload.promise);
    const store = new UploadQueueStore();
    store.setScope(scopeA);
    await store.enqueue(fakeFile(), { entity: "dress", mode: "album", dressId: 1 });
    await vi.waitFor(() => expect(mocks.uploadFileViaPresign).toHaveBeenCalledTimes(1));

    store.setScope(scopeB);
    expect(store.getJobs()).toEqual([]);
    upload.resolve("/objects/cms-public/from-tenant-a");
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mocks.applyUploadJob).not.toHaveBeenCalled();
    expect(store.getScopeKey()).toBe(scopeB.key);
    expect(store.getJobs()).toEqual([]);
  });

  it("does not auto-resume the old unscoped v1 queue", () => {
    storage.set("amazingUploadQueue_v1", JSON.stringify([{
      id: "legacy-job",
      status: "uploaded",
      objectPath: "/objects/old",
      attach: { entity: "dress", mode: "cover", dressId: 1 },
    }]));
    const store = new UploadQueueStore();

    store.setScope(scopeA);

    expect(store.getJobs()).toEqual([]);
    expect(mocks.applyUploadJob).not.toHaveBeenCalled();
  });
});
