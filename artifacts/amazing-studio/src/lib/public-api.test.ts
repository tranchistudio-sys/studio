import { describe, expect, it } from "vitest";
import { readJsonArrayResponse } from "./public-api";

describe("readJsonArrayResponse", () => {
  it("returns a valid collection", async () => {
    const response = new Response(JSON.stringify([{ id: 1 }]), { status: 200 });

    await expect(readJsonArrayResponse<{ id: number }>(response)).resolves.toEqual([{ id: 1 }]);
  });

  it("rejects an error payload instead of passing a non-iterable object to the UI", async () => {
    const response = new Response(JSON.stringify({ error: "database unavailable" }), { status: 500 });

    await expect(readJsonArrayResponse(response)).rejects.toThrow("status 500");
  });

  it("rejects a successful non-array payload", async () => {
    const response = new Response(JSON.stringify({ items: [] }), { status: 200 });

    await expect(readJsonArrayResponse(response)).rejects.toThrow("invalid collection");
  });
});
