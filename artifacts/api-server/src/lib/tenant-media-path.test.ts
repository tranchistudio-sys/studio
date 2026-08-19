import { describe, expect, it } from "vitest";
import {
  authorizeTenantMediaObjectPath,
  buildTenantLocalUploadUrl,
  buildTenantMediaObjectPath,
  buildTenantMediaStorageKey,
  buildTenantWeddingPublicUrl,
  TenantMediaPathError,
  type TenantMediaScope,
} from "./tenant-media-path";

const AMAZING: TenantMediaScope = {
  tenantId: "90d5fd42-6e03-4f7c-81af-51fbb25e8f41",
  tenantSlug: "amazing-studio",
};
const OTHER: TenantMediaScope = {
  tenantId: "1292b99a-3e59-4261-a5e7-6f9ea01e6f10",
  tenantSlug: "other-studio",
};
const OBJECT_ID = "a4aa87a1-a083-4a8b-a28f-e14ff866feba";

function expectCode(work: () => unknown, code: TenantMediaPathError["code"]): void {
  try {
    work();
    throw new Error("Expected TenantMediaPathError");
  } catch (error) {
    expect(error).toBeInstanceOf(TenantMediaPathError);
    expect((error as TenantMediaPathError).code).toBe(code);
  }
}

describe("tenant media paths", () => {
  it("always builds new objects below the authoritative tenant prefix", () => {
    expect(buildTenantMediaObjectPath(OTHER, "uploads", OBJECT_ID)).toBe(
      `/objects/tenants/${OTHER.tenantId}/uploads/${OBJECT_ID}`,
    );
    expect(buildTenantMediaStorageKey(OTHER, "cms-public", OBJECT_ID)).toBe(
      `tenants/${OTHER.tenantId}/cms-public/${OBJECT_ID}`,
    );
    expect(buildTenantLocalUploadUrl(OTHER, "uploads", OBJECT_ID)).toBe(
      `/api/storage/uploads/local/tenants/${OTHER.tenantId}/${OBJECT_ID}`,
    );
    expect(buildTenantWeddingPublicUrl(OTHER, OBJECT_ID)).toBe(
      `/api/storage/wedding-public/tenants/${OTHER.tenantId}/${OBJECT_ID}`,
    );
  });

  it("authorizes an own-tenant path and exposes only a scoped storage key", () => {
    const objectPath = buildTenantMediaObjectPath(OTHER, "cms-public", OBJECT_ID);
    expect(authorizeTenantMediaObjectPath(OTHER, objectPath, ["cms-public"])).toEqual({
      tenantId: OTHER.tenantId,
      namespace: "cms-public",
      objectName: OBJECT_ID,
      legacy: false,
      objectPath,
      storageKey: `tenants/${OTHER.tenantId}/cms-public/${OBJECT_ID}`,
    });
  });

  it("rejects a syntactically valid object belonging to another tenant", () => {
    const amazingObject = buildTenantMediaObjectPath(AMAZING, "uploads", OBJECT_ID);
    expectCode(
      () => authorizeTenantMediaObjectPath(OTHER, amazingObject),
      "TENANT_MEDIA_TENANT_MISMATCH",
    );
  });

  it("allows legacy reads only in the exact Amazing Studio server scope", () => {
    const legacy = `/objects/uploads/${OBJECT_ID}`;
    expect(authorizeTenantMediaObjectPath(AMAZING, legacy)).toMatchObject({
      legacy: true,
      storageKey: `uploads/${OBJECT_ID}`,
    });
    expectCode(
      () => authorizeTenantMediaObjectPath(OTHER, legacy),
      "TENANT_MEDIA_LEGACY_FORBIDDEN",
    );
    expectCode(
      () => authorizeTenantMediaObjectPath(
        { ...OTHER, tenantSlug: "Amazing-Studio" },
        legacy,
      ),
      "TENANT_MEDIA_SCOPE_INVALID",
    );
  });

  it("does not let a route consume a different valid namespace", () => {
    const privatePath = buildTenantMediaObjectPath(OTHER, "uploads", OBJECT_ID);
    expectCode(
      () => authorizeTenantMediaObjectPath(OTHER, privatePath, ["cms-public"]),
      "TENANT_MEDIA_NAMESPACE_FORBIDDEN",
    );
  });

  it("rejects traversal, encoded separators, query confusion, and loose UUIDs", () => {
    const badPaths = [
      `/objects/tenants/${OTHER.tenantId}/uploads/../${OBJECT_ID}`,
      `/objects/tenants/${OTHER.tenantId}/uploads/%2e%2e`,
      `/objects/tenants/${OTHER.tenantId}/uploads/%2fetc`,
      `/objects/tenants/${OTHER.tenantId}/uploads/${OBJECT_ID}\\..\\secret`,
      `/objects/tenants/${OTHER.tenantId}/uploads/${OBJECT_ID}?download=1`,
      `/objects/tenants/${OTHER.tenantId}//${OBJECT_ID}`,
      `/objects/tenants/${OTHER.tenantId}/uploads/00000000-0000-0000-0000-000000000000`,
      `/objects/tenants/${OTHER.tenantId}/unknown/${OBJECT_ID}`,
      `//objects/tenants/${OTHER.tenantId}/uploads/${OBJECT_ID}`,
    ];
    for (const path of badPaths) {
      expectCode(
        () => authorizeTenantMediaObjectPath(OTHER, path),
        "TENANT_MEDIA_PATH_INVALID",
      );
    }
  });

  it("supports only server-generated Facebook image names", () => {
    const name = `${OBJECT_ID}.WEBP`;
    const path = buildTenantMediaObjectPath(OTHER, "fb-inbox-images", name);
    expect(path).toBe(
      `/objects/tenants/${OTHER.tenantId}/fb-inbox-images/${OBJECT_ID}.webp`,
    );
    expectCode(
      () => buildTenantMediaObjectPath(OTHER, "fb-inbox-images", `${OBJECT_ID}.svg`),
      "TENANT_MEDIA_PATH_INVALID",
    );
  });

  it("fails closed when tenant scope is missing or malformed", () => {
    expectCode(
      () => buildTenantMediaObjectPath(undefined as never, "uploads", OBJECT_ID),
      "TENANT_MEDIA_SCOPE_INVALID",
    );
    expectCode(
      () => buildTenantMediaObjectPath(
        { tenantId: "not-a-tenant", tenantSlug: "other-studio" },
        "uploads",
        OBJECT_ID,
      ),
      "TENANT_MEDIA_SCOPE_INVALID",
    );
  });
});
