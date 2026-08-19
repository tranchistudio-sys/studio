import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "1292b99a-3e59-4261-a5e7-6f9ea01e6f10";
const OBJECT_ID = "a4aa87a1-a083-4a8b-a28f-e14ff866feba";
const mocks = vi.hoisted(() => ({
  tenantIdentity: vi.fn(),
  platformConfigured: vi.fn(() => true),
  saveTenantLocalObject: vi.fn(async () => undefined),
  saveLocalUpload: vi.fn(async () => undefined),
  createLocalUploadTarget: vi.fn(() => ({
    objectId: "a4aa87a1-a083-4a8b-a28f-e14ff866feba",
    objectPath: "/objects/uploads/a4aa87a1-a083-4a8b-a28f-e14ff866feba",
    uploadURL: "/api/storage/uploads/local/a4aa87a1-a083-4a8b-a28f-e14ff866feba",
  })),
  createTenantLocalUploadTarget: vi.fn(() => ({
    objectId: "a4aa87a1-a083-4a8b-a28f-e14ff866feba",
    objectPath: "/objects/tenants/1292b99a-3e59-4261-a5e7-6f9ea01e6f10/uploads/a4aa87a1-a083-4a8b-a28f-e14ff866feba",
    uploadURL: "/api/storage/uploads/local/tenants/1292b99a-3e59-4261-a5e7-6f9ea01e6f10/a4aa87a1-a083-4a8b-a28f-e14ff866feba",
  })),
}));

vi.mock("@workspace/db", () => ({
  getTenantDatabaseIdentity: mocks.tenantIdentity,
}));

vi.mock("@workspace/platform-db", () => ({
  isPlatformDatabaseConfigured: mocks.platformConfigured,
}));

vi.mock("./localObjectStorage", () => ({
  useLocalObjectStorage: () => true,
  createLocalUploadTarget: mocks.createLocalUploadTarget,
  createTenantLocalUploadTarget: mocks.createTenantLocalUploadTarget,
  saveLocalUpload: mocks.saveLocalUpload,
  saveTenantLocalObject: mocks.saveTenantLocalObject,
}));

vi.mock("./objectStorage", () => ({
  ObjectStorageService: class {
    saveTenantObject = vi.fn();
  },
}));

import { persistImageBuffer } from "./autopost-storage";

describe("autopost tenant object writer", () => {
  beforeEach(() => {
    mocks.tenantIdentity.mockReset();
    mocks.platformConfigured.mockReset();
    mocks.platformConfigured.mockReturnValue(true);
    mocks.saveTenantLocalObject.mockClear();
    mocks.saveLocalUpload.mockClear();
    mocks.createLocalUploadTarget.mockClear();
    mocks.createTenantLocalUploadTarget.mockClear();
  });

  it("passes only the ALS tenant identity to the object writer", async () => {
    mocks.tenantIdentity.mockReturnValue({
      tenantId: TENANT_ID,
      tenantSlug: "other-studio",
      databaseRef: "tenant-other",
    });

    await expect(persistImageBuffer(Buffer.from("image"), "image/webp", "post.webp")).resolves.toBe(
      `/objects/tenants/${TENANT_ID}/uploads/${OBJECT_ID}`,
    );
    expect(mocks.createTenantLocalUploadTarget).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, tenantSlug: "other-studio" },
      "uploads",
    );
    expect(mocks.saveTenantLocalObject).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, tenantSlug: "other-studio" },
      "uploads",
      OBJECT_ID,
      expect.any(Buffer),
      "image/webp",
      "post.webp",
    );
  });

  it("does not write when an async job lost tenant context", async () => {
    mocks.tenantIdentity.mockImplementation(() => {
      throw new Error("TENANT_DATABASE_CONTEXT_REQUIRED");
    });
    await expect(persistImageBuffer(Buffer.from("image"), "image/webp", "post.webp")).rejects.toThrow(
      "TENANT_DATABASE_CONTEXT_REQUIRED",
    );
    expect(mocks.createTenantLocalUploadTarget).not.toHaveBeenCalled();
    expect(mocks.saveTenantLocalObject).not.toHaveBeenCalled();
  });

  it("keeps standalone rollback mode on the legacy one-tenant layout", async () => {
    mocks.platformConfigured.mockReturnValue(false);
    await expect(persistImageBuffer(Buffer.from("image"), "image/jpeg", "legacy.jpg")).resolves.toBe(
      `/objects/uploads/${OBJECT_ID}`,
    );
    expect(mocks.tenantIdentity).not.toHaveBeenCalled();
    expect(mocks.saveLocalUpload).toHaveBeenCalled();
    expect(mocks.saveTenantLocalObject).not.toHaveBeenCalled();
  });
});
