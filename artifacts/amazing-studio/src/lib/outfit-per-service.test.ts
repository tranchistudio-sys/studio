import { describe, expect, it } from "vitest";
import {
  splitOutfitsBySub, planOutfitSync, setSubOutfits, mapDressRowToDraft,
  dedupeParentOutfits, moveOutfitsOnSubRemove,
} from "./outfit-per-service";

type D = { dbId?: number | null; code: string };
const d = (code: string, dbId: number | null = null): D => ({ code, dbId });

describe("splitOutfitsBySub — chia trang phục về TỪNG dịch vụ", () => {
  it("mỗi dịch vụ nhận đúng váy của CHILD booking mình (DV1 có 3, DV2/DV3 trống)", () => {
    const subs = [
      { key: "s1", siblingId: 101 },
      { key: "s2", siblingId: 102 },
      { key: "s3", siblingId: 103 },
    ];
    const bySibling = { 101: [d("CTVC-065"), d("CTVC-151"), d("ADC-021")] } as Record<number, D[]>;
    const { bySubKey, legacyParent } = splitOutfitsBySub(subs, bySibling, []);
    expect(bySubKey.s1.map(x => x.code)).toEqual(["CTVC-065", "CTVC-151", "ADC-021"]);
    expect(bySubKey.s2).toEqual([]);
    expect(bySubKey.s3).toEqual([]);
    expect(legacyParent).toBe(false);
  });

  it("DATA CŨ: váy nằm ở CHA, mọi con trống → dồn hết vào Dịch vụ 1, không mất data", () => {
    const subs = [
      { key: "s1", siblingId: 101 },
      { key: "s2", siblingId: 102 },
    ];
    const parent = [d("CTVC-153", 1), d("CTVC-145", 2), d("ADC-021", 3)];
    const { bySubKey, legacyParent } = splitOutfitsBySub(subs, {}, parent);
    expect(bySubKey.s1.map(x => x.code)).toEqual(["CTVC-153", "CTVC-145", "ADC-021"]);
    expect(bySubKey.s2).toEqual([]);
    expect(legacyParent).toBe(true);
  });

  it("MIXED: con có váy + cha còn váy cũ → váy cha vẫn hiện (prepend DV1), không bị nuốt", () => {
    const subs = [
      { key: "s1", siblingId: 101 },
      { key: "s2", siblingId: 102 },
    ];
    const bySibling = { 101: [d("MOI-1", 9)] } as Record<number, D[]>;
    const parent = [d("CU-1", 1)];
    const { bySubKey, legacyParent } = splitOutfitsBySub(subs, bySibling, parent);
    expect(bySubKey.s1.map(x => x.code)).toEqual(["CU-1", "MOI-1"]);
    expect(bySubKey.s2).toEqual([]);
    expect(legacyParent).toBe(true);
  });

  it("đơn 1 dịch vụ (không sibling): váy của booking chính về sub đầu như cũ", () => {
    const subs = [{ key: "s1", siblingId: null }];
    const parent = [d("A", 1)];
    const { bySubKey, legacyParent } = splitOutfitsBySub(subs, {}, parent);
    expect(bySubKey.s1.map(x => x.code)).toEqual(["A"]);
    expect(legacyParent).toBe(false);
  });
});

describe("setSubOutfits — sửa dịch vụ nào chỉ ảnh hưởng dịch vụ đó", () => {
  const base = { s1: [d("A"), d("B"), d("C")], s2: [d("X")], s3: [] as D[] };

  it("thêm váy vào DV2 → DV1 giữ nguyên 3 váy, DV3 vẫn trống", () => {
    const next = setSubOutfits(base, "s2", [...base.s2, d("Y")]);
    expect(next.s2.map(x => x.code)).toEqual(["X", "Y"]);
    expect(next.s1).toBe(base.s1); // giữ nguyên tham chiếu — không bị đụng
    expect(next.s1.map(x => x.code)).toEqual(["A", "B", "C"]);
    expect(next.s3).toEqual([]);
  });

  it("xoá váy ở DV1 → DV2 không đổi", () => {
    const next = setSubOutfits(base, "s1", base.s1.filter(x => x.code !== "B"));
    expect(next.s1.map(x => x.code)).toEqual(["A", "C"]);
    expect(next.s2).toBe(base.s2);
  });
});

describe("planOutfitSync — lưu đúng booking, di chuyển váy legacy cha → con", () => {
  it("draft dbId thuộc booking này → UPDATE; row bị bỏ → DELETE", () => {
    const plan = planOutfitSync([1, 2], [d("A", 1)]);
    expect(plan.toUpdate.map(x => x.code)).toEqual(["A"]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.deleteIds).toEqual([2]);
  });

  it("váy LEGACY mang dbId của CHA sync vào CON → INSERT mới dưới con (move), không update nhầm row cha", () => {
    // existingIds là của CHILD (trống) — draft có dbId=99 (row của CHA) phải thành insert
    const plan = planOutfitSync([], [d("CU-1", 99), d("MOI", null)]);
    expect(plan.toInsert.map(x => x.code)).toEqual(["CU-1", "MOI"]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it("dọn CHA sau move: drafts rỗng → mọi row cũ của cha bị delete", () => {
    const plan = planOutfitSync([5, 6, 7], []);
    expect(plan.deleteIds).toEqual([5, 6, 7]);
  });
});

describe("dedupeParentOutfits — chống hiển thị đúp sau lần lưu fail giữa chừng", () => {
  const o = (dressId: number, pickup = "2026-07-19", ret = "2026-07-21") =>
    ({ dressId, pickupDate: pickup, returnDate: ret });
  it("bản copy đã insert xuống child → loại khỏi danh sách cha", () => {
    const parent = [o(1), o(2), o(3)];
    const child = [o(1), o(2)]; // 2 bản đã copy dở xuống child trước khi lỗi mạng
    expect(dedupeParentOutfits(parent, child).map(x => x.dressId)).toEqual([3]);
  });
  it("cùng dress nhưng khác ngày → KHÔNG bị coi là trùng", () => {
    const parent = [o(1, "2026-08-01", "2026-08-02")];
    const child = [o(1)];
    expect(dedupeParentOutfits(parent, child)).toHaveLength(1);
  });
});

describe("moveOutfitsOnSubRemove — xoá card không làm mất váy legacy của cha", () => {
  it("váy fromParent chuyển sang card còn lại; váy của child mất theo card (đúng)", () => {
    const map = {
      s1: [{ code: "LEGACY", fromParent: true }, { code: "CHILD-OWN" }],
      s2: [{ code: "S2" }],
    };
    const next = moveOutfitsOnSubRemove(map, "s1", "s2");
    expect(next.s1).toBeUndefined();
    expect(next.s2.map((x: { code: string }) => x.code)).toEqual(["LEGACY", "S2"]);
  });
  it("không có legacy → xoá card sạch sẽ, card khác không đổi", () => {
    const map = { s1: [{ code: "A" }], s2: [{ code: "B" }] };
    const next = moveOutfitsOnSubRemove(map, "s1", "s2");
    expect(next.s1).toBeUndefined();
    expect(next.s2.map((x: { code: string }) => x.code)).toEqual(["B"]);
  });
});

describe("mapDressRowToDraft", () => {
  it("map row API snake_case đủ field", () => {
    let i = 0;
    const draft = mapDressRowToDraft({
      id: 12, dress_id: 34, outfit_code: "CTVC-065", outfit_name: "Váy đuôi cá yếm",
      outfit_image: null, category: "vay-cuoi", size: "M", rental_price: "500000",
      pickup_date: "2026-07-19", return_date: "2026-07-21", status: "reserved", note: "",
    }, () => `t${++i}`);
    expect(draft).toMatchObject({
      dbId: 12, dressId: 34, outfitCode: "CTVC-065", outfitName: "Váy đuôi cá yếm",
      rentalPrice: 500000, pickupDate: "2026-07-19", returnDate: "2026-07-21", status: "reserved",
    });
  });
});
