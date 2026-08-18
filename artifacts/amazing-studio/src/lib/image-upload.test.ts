import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFileViaPresign } from "./image-upload";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubUpload(objectPath: string, uploadURL: string) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ objectPath, uploadURL }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => "legacy-session-token"),
  });
  return fetchMock;
}

describe("upload storage scope", () => {
  it("CMS uploads request the dedicated public namespace", async () => {
    const objectPath = "/objects/cms-public/a4aa87a1-a083-4a8b-a28f-e14ff866feba";
    const uploadURL = "/api/storage/cms-public/uploads/local/a4aa87a1-a083-4a8b-a28f-e14ff866feba";
    const fetchMock = stubUpload(objectPath, uploadURL);

    await expect(uploadFileViaPresign(
      new Blob(["image"], { type: "image/webp" }),
      "cover.webp",
      "image/webp",
      "cms-public",
    )).resolves.toBe(objectPath);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/storage/cms-public/uploads/request-url");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(uploadURL);
  });

  it("business uploads remain private by default", async () => {
    const objectPath = "/objects/uploads/87c04d41-8990-469b-af84-37ac57a73ca0";
    const uploadURL = "/api/storage/uploads/local/87c04d41-8990-469b-af84-37ac57a73ca0";
    const fetchMock = stubUpload(objectPath, uploadURL);

    await expect(uploadFileViaPresign(
      new Blob(["proof"], { type: "image/jpeg" }),
      "payment-proof.jpg",
      "image/jpeg",
    )).resolves.toBe(objectPath);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/storage/uploads/request-url");
  });

  it("binds queued upload requests to the expected tenant and abort signal", async () => {
    const objectPath = "/objects/cms-public/tenant-bound";
    const uploadURL = "/api/storage/cms-public/uploads/local/tenant-bound";
    const fetchMock = stubUpload(objectPath, uploadURL);
    const controller = new AbortController();

    await uploadFileViaPresign(
      new Blob(["image"], { type: "image/webp" }),
      "tenant-cover.webp",
      "image/webp",
      "cms-public",
      { tenantId: "tenant-a", signal: controller.signal },
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("X-Tenant-Id")).toBe("tenant-a");
    expect(request.credentials).toBe("include");
    expect(request.signal).toBe(controller.signal);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).signal).toBe(controller.signal);
  });
});
