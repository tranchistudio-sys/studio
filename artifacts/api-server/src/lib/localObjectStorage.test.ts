import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalCmsPublicUploadTarget,
  createTenantLocalUploadTarget,
  createTenantLocalWeddingPublicUploadTarget,
  readLocalObject,
  readTenantLocalObject,
  saveLocalCmsPublicUpload,
  saveLocalUpload,
  saveTenantLocalObject,
  verifyTenantLocalWeddingPublicUpload,
} from "./localObjectStorage";
import { TenantMediaPathError, type TenantMediaScope } from "./tenant-media-path";

const OBJECT_ID = "a4aa87a1-a083-4a8b-a28f-e14ff866feba";
const AMAZING: TenantMediaScope = {
  tenantId: "90d5fd42-6e03-4f7c-81af-51fbb25e8f41",
  tenantSlug: "amazing-studio",
};
const OTHER: TenantMediaScope = {
  tenantId: "1292b99a-3e59-4261-a5e7-6f9ea01e6f10",
  tenantSlug: "other-studio",
};
let storageRoot = "";
let previousStorageRoot: string | undefined;

describe("local CMS public object namespace", () => {
  beforeEach(async () => {
    previousStorageRoot = process.env.LOCAL_OBJECT_STORAGE_DIR;
    storageRoot = await mkdtemp(path.join(tmpdir(), "amazing-cms-public-"));
    process.env.LOCAL_OBJECT_STORAGE_DIR = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.LOCAL_OBJECT_STORAGE_DIR;
    else process.env.LOCAL_OBJECT_STORAGE_DIR = previousStorageRoot;
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("server cấp UUID trong namespace cms-public", () => {
    const target = createLocalCmsPublicUploadTarget();
    expect(target.objectPath).toMatch(/^\/objects\/cms-public\/[0-9a-f-]{36}$/i);
    expect(target.uploadURL).toBe(`/api/storage/cms-public/uploads/local/${target.objectId}`);
  });

  it("không dùng chung file với namespace private uploads", async () => {
    await saveLocalUpload(OBJECT_ID, Buffer.from("private-proof"), "image/jpeg", "proof.jpg");
    await saveLocalCmsPublicUpload(OBJECT_ID, Buffer.from("public-cover"), "image/webp", "cover.webp");

    const privateObject = await readLocalObject(`/objects/uploads/${OBJECT_ID}`);
    const publicObject = await readLocalObject(`/objects/cms-public/${OBJECT_ID}`);
    expect(privateObject?.body.toString()).toBe("private-proof");
    expect(publicObject?.body.toString()).toBe("public-cover");
    expect(publicObject?.contentType).toBe("image/webp");
  });

  it("cùng UUID vẫn được lưu thành hai object vật lý riêng theo tenant", async () => {
    await saveTenantLocalObject(
      AMAZING,
      "uploads",
      OBJECT_ID,
      Buffer.from("amazing-proof"),
      "image/jpeg",
      "proof.jpg",
    );
    await saveTenantLocalObject(
      OTHER,
      "uploads",
      OBJECT_ID,
      Buffer.from("other-proof"),
      "image/png",
      "proof.png",
    );

    const amazingPath = `/objects/tenants/${AMAZING.tenantId}/uploads/${OBJECT_ID}`;
    const otherPath = `/objects/tenants/${OTHER.tenantId}/uploads/${OBJECT_ID}`;
    expect((await readTenantLocalObject(AMAZING, amazingPath))?.body.toString()).toBe("amazing-proof");
    expect((await readTenantLocalObject(OTHER, otherPath))?.body.toString()).toBe("other-proof");
    await expect(readTenantLocalObject(OTHER, amazingPath)).rejects.toMatchObject({
      code: "TENANT_MEDIA_TENANT_MISMATCH",
    });
  });

  it("target upload mới không bao giờ cấp legacy path", () => {
    const target = createTenantLocalUploadTarget(OTHER, "cms-public");
    expect(target.objectPath).toMatch(
      new RegExp(`^/objects/tenants/${OTHER.tenantId}/cms-public/[0-9a-f-]{36}$`),
    );
    expect(target.uploadURL).toBe(
      `/api/storage/cms-public/uploads/local/tenants/${OTHER.tenantId}/${target.objectId}`,
    );
  });

  it("legacy path chỉ đọc được trong Amazing tenant", async () => {
    await saveLocalUpload(OBJECT_ID, Buffer.from("legacy-amazing"), "image/jpeg", "old.jpg");
    expect((await readTenantLocalObject(AMAZING, `/objects/uploads/${OBJECT_ID}`))?.body.toString()).toBe(
      "legacy-amazing",
    );
    await expect(readTenantLocalObject(OTHER, `/objects/uploads/${OBJECT_ID}`)).rejects.toBeInstanceOf(
      TenantMediaPathError,
    );
  });

  it("chữ ký upload wedding bị ràng buộc vào tenant", () => {
    const target = createTenantLocalWeddingPublicUploadTarget(AMAZING);
    const parsed = new URL(target.uploadURL, "https://example.test");
    const expires = parsed.searchParams.get("exp");
    const signature = parsed.searchParams.get("sig");
    expect(verifyTenantLocalWeddingPublicUpload(AMAZING, target.objectId, expires, signature)).toBe(true);
    expect(verifyTenantLocalWeddingPublicUpload(OTHER, target.objectId, expires, signature)).toBe(false);
  });
});
