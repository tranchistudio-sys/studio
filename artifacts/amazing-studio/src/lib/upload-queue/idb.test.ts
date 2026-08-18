import { describe, expect, it } from "vitest";
import { uploadBlobKey } from "./idb";

describe("upload blob keys", () => {
  it("namespaces identical job ids by tenant client scope", () => {
    expect(uploadBlobKey("tenant-a", "same-job")).not.toBe(
      uploadBlobKey("tenant-b", "same-job"),
    );
    expect(uploadBlobKey("tenant-a", "same-job")).toBe("tenant-a::same-job");
  });
});
