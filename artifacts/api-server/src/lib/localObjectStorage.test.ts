import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalCmsPublicUploadTarget,
  readLocalObject,
  saveLocalCmsPublicUpload,
  saveLocalUpload,
} from "./localObjectStorage";

const OBJECT_ID = "a4aa87a1-a083-4a8b-a28f-e14ff866feba";
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
});
