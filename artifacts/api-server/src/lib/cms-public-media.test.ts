import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCmsObjectPath,
  ensureCmsPublicMediaRegistryInitialized,
  findDisallowedCmsObjectReference,
  isCmsPublicNamespacePath,
  isPrivateObjectReference,
  registerLegacyCmsPublicObjectValues,
  resetCmsPublicMediaRegistryForTests,
  rewriteCmsPublicMediaForResponse,
  signCmsPublicObjectValue,
  validateCmsPublicMediaWrite,
  verifyCmsPublicObjectSignature,
} from "./cms-public-media";

const { registryQuery } = vi.hoisted(() => ({
  registryQuery: vi.fn(async () => ({ rows: [] as Array<{ data?: unknown }> })),
}));
vi.mock("@workspace/db", () => ({ pool: { query: registryQuery } }));

const PUBLIC_OBJECT_ID = "a4aa87a1-a083-4a8b-a28f-e14ff866feba";
const PRIVATE_PROOF_ID = "87c04d41-8990-469b-af84-37ac57a73ca0";

describe("signed CMS public media", () => {
  beforeEach(() => {
    resetCmsPublicMediaRegistryForTests();
    registryQuery.mockClear();
    registryQuery.mockResolvedValue({ rows: [] });
  });

  it("chỉ ký object trong namespace cms-public", () => {
    const now = 1_700_000_000;
    const path = `cms-public/${PUBLIC_OBJECT_ID}`;
    const signed = signCmsPublicObjectValue(`/objects/${path}`, now);
    const parsed = new URL(signed, "https://example.test");

    expect(isCmsPublicNamespacePath(path)).toBe(true);
    expect(verifyCmsPublicObjectSignature(
      path,
      parsed.searchParams.get("exp"),
      parsed.searchParams.get("sig"),
      now,
    )).toBe(true);
  });

  it("không ký hoặc serve chứng từ thanh toán bị chèn vào CMS public", () => {
    const now = 1_700_000_000;
    const privatePaymentProof = `/objects/uploads/${PRIVATE_PROOF_ID}`;
    const maliciousCmsPayload = {
      name: "Album công khai",
      photos: [{ imageUrl: privatePaymentProof }],
    };

    // Write validation rejects the attempted private reference.
    expect(findDisallowedCmsObjectReference(maliciousCmsPayload)).toBe(privatePaymentProof);
    // Response rewriting cannot mint a public capability for it.
    expect(rewriteCmsPublicMediaForResponse(maliciousCmsPayload, 0)).toEqual(maliciousCmsPayload);
    expect(signCmsPublicObjectValue(privatePaymentProof, now)).toBe(privatePaymentProof);
    // The download route uses this verifier, so even a CMS-shaped path without
    // a registry entry fails closed before object storage is read.
    expect(verifyCmsPublicObjectSignature(
      `uploads/${PRIVATE_PROOF_ID}`,
      String(now + 3600),
      "attacker-controlled-signature",
      now,
    )).toBe(false);
  });

  it("write middleware trả 400 trước khi payload chứa payment proof tới CMS route", async () => {
    const privatePaymentProof = `/objects/uploads/${PRIVATE_PROOF_ID}`;
    const next = vi.fn();
    const response = {
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockReturnValue(response);

    await validateCmsPublicMediaWrite(
      { method: "POST", body: { coverImageUrl: privatePaymentProof } } as never,
      response as never,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "CMS_PRIVATE_OBJECT_REFERENCE",
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it("giữ tương thích đúng các object CMS legacy có trong startup registry", () => {
    const now = 1_700_000_000;
    const legacyPath = `/objects/uploads/${PUBLIC_OBJECT_ID}`;
    registerLegacyCmsPublicObjectValues({
      cover_image_url: legacyPath,
      extra_images: JSON.stringify([legacyPath]),
    });

    const signed = signCmsPublicObjectValue(legacyPath, now);
    const parsed = new URL(signed, "https://example.test");
    expect(signed).not.toBe(legacyPath);
    expect(findDisallowedCmsObjectReference({ coverImageUrl: legacyPath })).toBeNull();
    expect(verifyCmsPublicObjectSignature(
      `uploads/${PUBLIC_OBJECT_ID}`,
      parsed.searchParams.get("exp"),
      parsed.searchParams.get("sig"),
      now,
    )).toBe(true);
  });

  it("startup registry chỉ đọc cột media, không quét description/notes", async () => {
    await ensureCmsPublicMediaRegistryInitialized();
    const statements = (registryQuery.mock.calls as unknown[][]).map((call) => String(call[0]));
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((sql) => sql.includes("'cover_image_url'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'extra_images'"))).toBe(true);
    expect(statements.join("\n")).not.toContain("'description'");
    expect(statements.join("\n")).not.toContain("'notes'");
  });

  it("không dùng chữ ký của object public cho path private khác", () => {
    const now = 1_700_000_000;
    const signed = signCmsPublicObjectValue(`/objects/cms-public/${PUBLIC_OBJECT_ID}`, now);
    const parsed = new URL(signed, "https://example.test");
    expect(verifyCmsPublicObjectSignature(
      `uploads/${PRIVATE_PROOF_ID}`,
      parsed.searchParams.get("exp"),
      parsed.searchParams.get("sig"),
      now,
    )).toBe(false);
  });

  it("từ chối path traversal và namespace giả", () => {
    expect(canonicalCmsObjectPath("../secret")).toBeNull();
    expect(canonicalCmsObjectPath("safe\\..\\secret")).toBeNull();
    expect(isCmsPublicNamespacePath("cms-public/not-a-uuid")).toBe(false);
    expect(isCmsPublicNamespacePath(`cms-public/${PUBLIC_OBJECT_ID}/nested`)).toBe(false);
  });

  it("phân biệt object nội bộ với namespace public", () => {
    expect(isPrivateObjectReference(`/objects/uploads/${PRIVATE_PROOF_ID}`)).toBe(true);
    expect(isPrivateObjectReference(`/api/storage/objects/uploads/${PRIVATE_PROOF_ID}`)).toBe(true);
    expect(isPrivateObjectReference(`/objects/cms-public/${PUBLIC_OBJECT_ID}`)).toBe(false);
    expect(isPrivateObjectReference("/storage/public-objects/site/cover.jpg")).toBe(false);
  });
});
