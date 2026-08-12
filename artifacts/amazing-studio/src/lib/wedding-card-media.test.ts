import { describe, expect, it } from "vitest";
import { assignInitialRoles, removeMedia, setMediaRole, swapCovers, type WeddingMediaItem } from "./wedding-card-media";

const item = (id: string, role: WeddingMediaItem["role"]): WeddingMediaItem => ({ id, name: id, fingerprint: id, previewUrl: id, remoteUrl: id, role, status: "complete", progress: 100 });

describe("wedding media roles", () => {
  it("assigns the first two covers and the rest to album", () => {
    expect(assignInitialRoles([{}, {}, {}]).map((x) => x.role)).toEqual(["cover1", "cover2", "album"]);
  });
  it("moves the old cover back to album", () => {
    expect(setMediaRole([item("a", "cover1"), item("b", "cover2"), item("c", "album")], "c", "cover1").map((x) => x.role)).toEqual(["album", "cover2", "cover1"]);
  });
  it("swaps covers", () => {
    expect(swapCovers([item("a", "cover1"), item("b", "cover2")]).map((x) => x.role)).toEqual(["cover2", "cover1"]);
  });
  it("promotes an album image when a cover is removed", () => {
    expect(removeMedia([item("a", "cover1"), item("b", "cover2"), item("c", "album")], "a").map((x) => x.role)).toEqual(["cover2", "cover1"]);
  });
});
