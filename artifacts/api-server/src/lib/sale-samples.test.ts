import { describe, it, expect, vi } from "vitest";

// Pure-function tests: mock DB để không cần DATABASE_URL khi import module.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import {
  detectServiceIntentFromText,
  normalizeIntent,
  detectGender,
  sampleGender,
  buildSampleLinks,
  toPublicImageUrl,
  resolvePrimaryGroup,
  intentPrimaryGroup,
  subcategoryAllows,
  resolveSampleImages,
  type SampleImage,
} from "./sale-samples";

// Cây danh mục gallery mẫu (giống cấu trúc thật): Thời trang(32) > Sexy(33), Chụp bầu(59),
// Áo dài(41); Ảnh Cưới(37) > Studio(38), Ngoại cảnh(39), Tiệc cưới(82); Gia đình(90); Concept(46).
const CATS = new Map<number, { id: number; name: string; parent_id: number | null }>([
  [32, { id: 32, name: "Thời trang", parent_id: null }],
  [33, { id: 33, name: "Sexy", parent_id: 32 }],
  [59, { id: 59, name: "Chụp bầu", parent_id: 32 }],
  [41, { id: 41, name: "Áo dài", parent_id: 32 }],
  [37, { id: 37, name: "Ảnh Cưới", parent_id: null }],
  [38, { id: 38, name: "Studio", parent_id: 37 }],
  [39, { id: 39, name: "Ngoại cảnh", parent_id: 37 }],
  [82, { id: 82, name: "TIỆC CƯỚI", parent_id: 37 }],
  [90, { id: 90, name: "Gia đình", parent_id: null }],
  [46, { id: 46, name: "Concept khác", parent_id: null }],
]);

describe("sale-samples: detectServiceIntentFromText", () => {
  it("CASE 1 — cool boy → beauty (KHÔNG phải cưới)", () => {
    expect(detectServiceIntentFromText("Anh muốn chụp cool boy")).toBe("beauty");
    expect(detectServiceIntentFromText("cho em xem mẫu beauty cá tính")).toBe("beauty");
    expect(detectServiceIntentFromText("chụp nàng thơ nhẹ nhàng")).toBe("beauty");
  });

  it("CASE 3 — hỏi váy cưới/áo dài/vest → rental_outfit (Cho thuê đồ)", () => {
    expect(detectServiceIntentFromText("Bên em có váy cưới không?")).toBe("rental_outfit");
    expect(detectServiceIntentFromText("cho thuê áo dài không")).toBe("rental_outfit");
    expect(detectServiceIntentFromText("thuê vest chú rể")).toBe("rental_outfit");
  });

  it("CASE 4 — concept lạ/mới → new_concept_idea", () => {
    expect(detectServiceIntentFromText("Mình muốn concept lạ hơn")).toBe("new_concept_idea");
    expect(detectServiceIntentFromText("có ý tưởng gì mới mẻ không")).toBe("new_concept_idea");
    expect(detectServiceIntentFromText("mình chưa ưng mấy mẫu này")).toBe("new_concept_idea");
  });

  it("ảnh cưới / ngoại cảnh / cô dâu chú rể → wedding_album", () => {
    expect(detectServiceIntentFromText("anh muốn chụp ảnh cưới ngoại cảnh")).toBe("wedding_album");
    expect(detectServiceIntentFromText("chụp cô dâu chú rể")).toBe("wedding_album");
  });

  it("cổng cưới → wedding_gate; tiệc cưới → wedding_party", () => {
    expect(detectServiceIntentFromText("em muốn chụp cổng cưới")).toBe("wedding_gate");
    expect(detectServiceIntentFromText("chụp tiệc cưới phóng sự")).toBe("wedding_party");
  });

  it("mẹ bầu → maternity; gia đình → family", () => {
    expect(detectServiceIntentFromText("chụp mẹ bầu")).toBe("maternity");
    expect(detectServiceIntentFromText("chụp gia đình cả nhà")).toBe("family");
  });

  it("CASE 5 — câu giá trần / không rõ nhu cầu → unknown (KHÔNG gửi ảnh bừa)", () => {
    expect(detectServiceIntentFromText("giá bao nhiêu")).toBe("unknown");
    expect(detectServiceIntentFromText("xem a")).toBe("unknown");
    expect(detectServiceIntentFromText("alo")).toBe("unknown");
    expect(detectServiceIntentFromText("")).toBe("unknown");
  });

  it("ưu tiên đúng: 'thuê váy cưới' → rental_outfit chứ không phải wedding_album", () => {
    expect(detectServiceIntentFromText("cho thuê váy cưới đẹp")).toBe("rental_outfit");
  });

  it("LUẬT 4 — 'ngoại cảnh' TRẦN (không rõ cưới/beauty) → unknown để hỏi lại", () => {
    expect(detectServiceIntentFromText("cho em xem ngoại cảnh")).toBe("unknown");
    // nhưng có 'cưới' đi kèm thì vẫn rõ là cưới
    expect(detectServiceIntentFromText("ảnh cưới ngoại cảnh")).toBe("wedding_album");
  });
});

describe("sale-samples: LUẬT 1 — resolvePrimaryGroup (khóa nhóm theo DANH MỤC GỐC)", () => {
  it("mọi nhánh dưới Thời trang → thoitrang (kể cả Áo dài, Chụp bầu)", () => {
    expect(resolvePrimaryGroup(33, CATS)).toBe("thoitrang"); // Sexy
    expect(resolvePrimaryGroup(41, CATS)).toBe("thoitrang"); // Áo dài
    expect(resolvePrimaryGroup(59, CATS)).toBe("thoitrang"); // Chụp bầu
    expect(resolvePrimaryGroup(32, CATS)).toBe("thoitrang"); // chính gốc Thời trang
  });
  it("mọi nhánh dưới Ảnh Cưới → wedding", () => {
    expect(resolvePrimaryGroup(38, CATS)).toBe("wedding"); // Studio
    expect(resolvePrimaryGroup(39, CATS)).toBe("wedding"); // Ngoại cảnh
    expect(resolvePrimaryGroup(82, CATS)).toBe("wedding"); // Tiệc cưới
  });
  it("Gia đình → family; Concept & chưa gắn danh mục → null (KHÔNG chọn cho nhóm cứng)", () => {
    expect(resolvePrimaryGroup(90, CATS)).toBe("family");
    expect(resolvePrimaryGroup(46, CATS)).toBeNull();   // Concept khác
    expect(resolvePrimaryGroup(null, CATS)).toBeNull(); // album chưa gắn danh mục
    expect(resolvePrimaryGroup(999, CATS)).toBeNull();  // id lạ
  });
  it("BỀN với việc admin lồng danh mục bất kỳ: Gia đình nằm TRONG Thời trang vẫn ra family", () => {
    // admin tự lồng "Gia đình"(90) vào "Thời trang"(32) — nhóm vẫn phải đúng nhờ quét cả đường dẫn
    const nested = new Map(CATS);
    nested.set(90, { id: 90, name: "Gia đình", parent_id: 32 });
    expect(resolvePrimaryGroup(90, nested)).toBe("family");   // family thắng thoitrang (đặc trưng trước)
    expect(resolvePrimaryGroup(33, nested)).toBe("thoitrang"); // Sexy vẫn thoitrang
    expect(resolvePrimaryGroup(38, nested)).toBe("wedding");   // Studio vẫn wedding
  });
});

describe("sale-samples: intentPrimaryGroup", () => {
  it("map intent → nhóm lớn; rental/concept/unknown → null (dùng nguồn khác)", () => {
    expect(intentPrimaryGroup("beauty")).toBe("thoitrang");
    expect(intentPrimaryGroup("maternity")).toBe("thoitrang");
    expect(intentPrimaryGroup("wedding_album")).toBe("wedding");
    expect(intentPrimaryGroup("wedding_gate")).toBe("wedding");
    expect(intentPrimaryGroup("wedding_party")).toBe("wedding");
    expect(intentPrimaryGroup("family")).toBe("family");
    expect(intentPrimaryGroup("rental_outfit")).toBeNull();
    expect(intentPrimaryGroup("new_concept_idea")).toBeNull();
    expect(intentPrimaryGroup("unknown")).toBeNull();
  });
});

describe("sale-samples: LUẬT 2 — subcategoryAllows (nhánh con trên ĐƯỜNG DẪN DANH MỤC)", () => {
  it("beauty: nhận thời trang chung, LOẠI nhánh bầu", () => {
    expect(subcategoryAllows("beauty", "sexy thoi trang")).toBe(true);
    expect(subcategoryAllows("beauty", "chup bau thoi trang")).toBe(false);
  });
  it("maternity: CHỈ nhánh bầu", () => {
    expect(subcategoryAllows("maternity", "chup bau thoi trang")).toBe(true);
    expect(subcategoryAllows("maternity", "sexy thoi trang")).toBe(false);
  });
  it("cổng cưới: lấy Studio, LOẠI Ngoại cảnh (không lấy ngoại cảnh khi hỏi cổng)", () => {
    expect(subcategoryAllows("wedding_gate", "studio anh cuoi")).toBe(true);
    expect(subcategoryAllows("wedding_gate", "ngoai canh anh cuoi")).toBe(false);
  });
  it("tiệc cưới: nhánh Tiệc; ảnh cưới chung: nhận mọi nhánh trong Ảnh Cưới", () => {
    expect(subcategoryAllows("wedding_party", "tiec cuoi anh cuoi")).toBe(true);
    expect(subcategoryAllows("wedding_album", "ngoai canh anh cuoi")).toBe(true);
    expect(subcategoryAllows("wedding_album", "studio anh cuoi")).toBe(true);
  });
});

describe("sale-samples: normalizeIntent", () => {
  it("nhận nhãn AI gõ ở nhiều dạng", () => {
    expect(normalizeIntent("beauty")).toBe("beauty");
    expect(normalizeIntent("Beauty")).toBe("beauty");
    expect(normalizeIntent("wedding_album")).toBe("wedding_album");
    expect(normalizeIntent("wedding album")).toBe("wedding_album");
    expect(normalizeIntent("rental_outfit")).toBe("rental_outfit");
    expect(normalizeIntent("váy cưới")).toBe("rental_outfit");
    expect(normalizeIntent("new_concept_idea")).toBe("new_concept_idea");
    expect(normalizeIntent("ý tưởng")).toBe("new_concept_idea");
  });
  it("rác → null", () => {
    expect(normalizeIntent("")).toBeNull();
    expect(normalizeIntent("xyz123")).toBeNull();
  });
  it("compound: 'ao dai cuoi' → rental_outfit (KHÔNG ra wedding_album qua token 'cuoi')", () => {
    expect(normalizeIntent("ao dai cuoi")).toBe("rental_outfit");
    expect(normalizeIntent("vay cuoi dep")).toBe("rental_outfit");
  });
});

describe("sale-samples: detectGender (cool boy KHÔNG được gửi mẫu nữ)", () => {
  it("nam", () => {
    expect(detectGender("Anh muốn chụp cool boy")).toBe("male");
    expect(detectGender("chụp nam cá tính")).toBe("male");
    expect(detectGender("bên em có đồ nam không")).toBe("male");
    expect(detectGender("con trai chụp kiểu gì đẹp")).toBe("male");
  });
  it("nữ", () => {
    expect(detectGender("chụp nàng thơ")).toBe("female");
    expect(detectGender("cool girl")).toBe("female");
    expect(detectGender("thuê đồ nữ")).toBe("female");
  });
  it("không rõ → null", () => {
    expect(detectGender("chụp cưới ngoại cảnh")).toBeNull();
    expect(detectGender("giá bao nhiêu")).toBeNull();
    expect(detectGender("")).toBeNull();
  });
});

describe("sale-samples: sampleGender (phân loại mẫu theo tên + danh mục)", () => {
  it("nam: catpath Gym/NAM/Beauty, áo dài nam", () => {
    expect(sampleGender("profile gym gym nam beauty")).toBe("male");
    expect(sampleGender("ao dai nam do do nam")).toBe("male");
    expect(sampleGender("vest chu re")).toBe("male");
  });
  it("nữ: nàng thơ, sexy", () => {
    expect(sampleGender("khi chat nang tho beauty")).toBe("female");
    expect(sampleGender("ca tinh sexy beauty")).toBe("female");
  });
  it("không rõ → null (vd cat BEAUTY chung)", () => {
    expect(sampleGender("ve dep tinh lang beauty")).toBeNull();
  });
});

describe("sale-samples: buildSampleLinks", () => {
  it("dedupe theo url + nhãn theo nguồn", () => {
    const imgs: SampleImage[] = [
      { title: "Cool Love", imageUrl: "/objects/a", detailUrl: "https://x/bo-anh/al-10", sourceType: "gallery" },
      { title: "Black & White", imageUrl: "/objects/b", detailUrl: "https://x/bo-anh/al-10", sourceType: "gallery" },
      { title: "Váy xoè", imageUrl: "/objects/c", detailUrl: "https://x/cho-thue-do", sourceType: "rental_item" },
      { title: "Concept", imageUrl: "/objects/d", sourceType: "photo_idea" },
    ];
    const links = buildSampleLinks(imgs);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("https://x/bo-anh/al-10");
    expect(links[1].title).toContain("cho thuê");
  });
});

describe("sale-samples: LUẬT 8 — ưu tiên album được ghim (sort_order nhỏ) khi gửi", () => {
  // Cây: Thời trang(32) > Sexy(33). 3 album cùng nhánh Sexy:
  //  - B: sort_order 1 (ĐƯỢC GHIM / ưu tiên), không tag.
  //  - A, C: sort_order 5 (thường), có tag "han quoc".
  const CATS = [
    { id: 32, name: "Thời trang", parent_id: null },
    { id: 33, name: "Sexy", parent_id: 32 },
  ];
  const ALBUMS = [
    { id: 1, name: "A thuong", slug: "a", tags_text: "han quoc", category_id: 33, cover_image_url: "/objects/a", sort_order: 5, first_photo: null },
    { id: 2, name: "B uu tien", slug: "b", tags_text: "", category_id: 33, cover_image_url: "/objects/b", sort_order: 1, first_photo: null },
    { id: 3, name: "C thuong", slug: "c", tags_text: "han quoc sang trong", category_id: 33, cover_image_url: "/objects/c", sort_order: 5, first_photo: null },
  ];
  function mockDb() {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("gallery_albums")) return { rows: ALBUMS };
        if (typeof sql === "string" && sql.includes("cms_categories")) return { rows: CATS };
        return { rows: [] };
      });
  }

  it("KHÔNG nêu style → album ƯU TIÊN (sort_order nhỏ) gửi TRƯỚC", async () => {
    mockDb();
    const imgs = await resolveSampleImages({ intents: ["beauty"], messageText: "", maxTotal: 2 });
    expect(imgs[0]?.title).toBe("B uu tien"); // được ghim → lên đầu dù không tag
  });

  it("NÊU style 'han quoc' → album KHỚP gu lên trước; ưu-tiên-nhưng-không-khớp bị đẩy sau", async () => {
    mockDb();
    const imgs = await resolveSampleImages({ intents: ["beauty"], messageText: "han quoc", maxTotal: 2 });
    const titles = imgs.map((i) => i.title);
    expect(titles).toContain("A thuong");
    expect(titles).toContain("C thuong");
    expect(titles).not.toContain("B uu tien"); // khớp gu thắng (LUẬT 1: tags trước, ưu tiên là tiebreak)
  });
});

describe("sale-samples: toPublicImageUrl", () => {
  it("absolute giữ nguyên; /uploads & /objects resolve đúng tiền tố", () => {
    expect(toPublicImageUrl("https://cdn/x.jpg")).toBe("https://cdn/x.jpg");
    expect(toPublicImageUrl("/uploads/cms/x.webp")).toMatch(/\/uploads\/cms\/x\.webp$/);
    expect(toPublicImageUrl("/objects/uploads/abc")).toMatch(/\/api\/storage\/objects\/uploads\/abc$/);
    expect(toPublicImageUrl("")).toBe("");
  });
});
