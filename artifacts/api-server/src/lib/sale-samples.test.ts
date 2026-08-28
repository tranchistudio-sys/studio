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
  isExplicitSampleRequest,
  resolveSampleImages,
  selectSampleImages,
  buildWorkflowSampleReply,
  extractRecentSampleUrls,
  type SampleImage,
} from "./sale-samples";

describe("sale-samples: workflow reply labels", () => {
  it("names Album Studio when samples are sent without a selected style", () => {
    const reply = buildWorkflowSampleReply({ serviceKey: "album_studio", style: null, styleMatched: true });
    expect(reply).toContain("Album Studio");
    expect(reply).not.toContain("đúng dịch vụ");
  });
});

describe("sale-samples: explicit request gate", () => {
  it("recognizes direct sample requests without relying on the model marker", () => {
    expect(isExplicitSampleRequest("Cho anh xem mẫu beauty.")).toBe(true);
    expect(isExplicitSampleRequest("Gửi thêm hình đi em")).toBe(true);
    expect(isExplicitSampleRequest("Anh muốn chụp cool boy.")).toBe(false);
    expect(isExplicitSampleRequest("De minh xem them.")).toBe(false);
  });

  it("remembers wedding gate and ignores a conflicting rental marker", async () => {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: [{
          id: 10, name: "Cổng đỏ studio", slug: "cong-do", tags_text: "",
          category_id: 38, cover_image_url: "/objects/cover", first_photo: "/objects/gate-real", sort_order: 1,
        }] };
        if (sql.includes("cms_categories")) return { rows: [
          { id: 37, name: "Ảnh Cưới", parent_id: null },
          { id: 38, name: "Cổng studio - Album studio", parent_id: 37 },
        ] };
        return { rows: [] };
      });

    const result = await selectSampleImages({
      sampleRequested: true,
      sampleIntents: ["rental_outfit"],
      messageText: "Có hình mẫu không ạ?",
      contextText: "Gói chụp cổng Luxury 5.900.000đ, gồm 2 sare và 2 áo vest",
      maxTotal: 2,
    });

    expect(result.resolvedIntents).toEqual(["wedding_gate"]);
    expect(result.images[0]?.imageUrl).toBe("/objects/gate-real");
    expect(result.images[0]?.sourceType).toBe("gallery");
  });

  it("honors a locked gate service when only package details mention vest", async () => {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: [{
          id: 10, name: "Gate studio", slug: "gate", tags_text: "", category_id: 38,
          cover_image_url: "/objects/gate-cover", first_photo: "/objects/gate-real", sort_order: 1,
        }] };
        if (sql.includes("cms_categories")) return { rows: [
          { id: 37, name: "Wedding", parent_id: null },
          { id: 38, name: "Gate studio", parent_id: 37 },
        ] };
        return { rows: [] };
      });

    const result = await selectSampleImages({
      sampleRequested: true,
      sampleIntents: ["wedding_gate"],
      intentLocked: true,
      messageText: "Co hinh mau khong a?",
      contextText: "Goi Luxury gom 2 sare va 2 ao vest.",
      maxTotal: 2,
    });

    expect(result.resolvedIntents).toEqual(["wedding_gate"]);
    expect(result.images.map((image) => image.imageUrl)).toEqual(["/objects/gate-real"]);
  });

  it("keeps the workflow-locked outdoor album when old context mentions a gate", async () => {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: [
          { id: 10, name: "Gate studio", slug: "gate", tags_text: "", category_id: 38, cover_image_url: "/objects/gate", first_photo: null, sort_order: 1 },
          { id: 11, name: "Nui Ba Tay Ninh", slug: "nui-ba", tags_text: "Tay Ninh", category_id: 39, cover_image_url: "/objects/outdoor", first_photo: null, sort_order: 1 },
        ] };
        if (sql.includes("cms_categories")) return { rows: [
          { id: 37, name: "Wedding", parent_id: null },
          { id: 38, name: "Gate studio", parent_id: 37 },
          { id: 39, name: "Outdoor wedding", parent_id: 37 },
        ] };
        return { rows: [] };
      });

    const result = await selectSampleImages({
      sampleRequested: true,
      sampleIntents: ["album_outdoor"],
      intentLocked: true,
      messageText: "Nui Ba Den, phong cach tu nhien.",
      contextText: "Khach vua xem anh chup cong.",
      maxTotal: 2,
    });

    expect(result.resolvedIntents).toEqual(["album_outdoor"]);
    expect(result.images.map((image) => image.imageUrl)).toEqual(["/objects/outdoor"]);
  });
});

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

  it("phân biệt album studio, album ngoại cảnh và album cưới chưa rõ loại", () => {
    expect(detectServiceIntentFromText("anh muốn chụp ảnh cưới ngoại cảnh")).toBe("album_outdoor");
    expect(detectServiceIntentFromText("chị muốn chụp album studio")).toBe("album_studio");
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
    expect(detectServiceIntentFromText("ảnh cưới ngoại cảnh")).toBe("album_outdoor");
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
    expect(intentPrimaryGroup("album_studio")).toBe("wedding");
    expect(intentPrimaryGroup("album_outdoor")).toBe("wedding");
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
    expect(subcategoryAllows("wedding_gate", "cong studio anh cuoi")).toBe(true);
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
    expect(normalizeIntent("album studio")).toBe("album_studio");
    expect(normalizeIntent("album ngoai canh")).toBe("album_outdoor");
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

describe("sale-samples: style tag CMS and random selection", () => {
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
    { id: 3, name: "C thuong", slug: "c", tags_text: "han quoc, sang trong", category_id: 33, cover_image_url: "/objects/c", sort_order: 5, first_photo: null },
  ];
  function mockDb() {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("gallery_albums")) return { rows: ALBUMS };
        if (typeof sql === "string" && sql.includes("cms_categories")) return { rows: CATS };
        return { rows: [] };
      });
  }

  it("KHÔNG nêu style → chọn ngẫu nhiên trong đúng nhánh", async () => {
    mockDb();
    const imgs = await resolveSampleImages({ intents: ["beauty"], messageText: "", maxTotal: 2 });
    expect(imgs).toHaveLength(2);
    expect(imgs.every((image) => ["A thuong", "B uu tien", "C thuong"].includes(image.title))).toBe(true);
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

describe("sale-samples: exact configured gallery branches", () => {
  it("keeps Album Studio inside Cổng Studio - Album Studio", async () => {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: [
          { id: 1, name: "Studio nhẹ nhàng", slug: "studio", tags_text: "nhẹ nhàng", category_id: 38, cover_image_url: null, first_photo: "/objects/studio", sort_order: 1 },
          { id: 2, name: "Ngoại cảnh", slug: "outdoor", tags_text: "Tây Ninh", category_id: 39, cover_image_url: null, first_photo: "/objects/outdoor", sort_order: 0 },
        ] };
        if (sql.includes("cms_categories")) return { rows: [
          { id: 37, name: "ẢNH CƯỚI", parent_id: null },
          { id: 38, name: "Cổng Studio - Album Studio", parent_id: 37 },
          { id: 39, name: "Ngoại cảnh cưới", parent_id: 37 },
        ] };
        return { rows: [] };
      });
    const images = await resolveSampleImages({ intents: ["album_studio"], messageText: "nhẹ nhàng", maxTotal: 2 });
    expect(images.map((image) => image.imageUrl)).toEqual(["/objects/studio"]);
  });

  it("excludes Vũng Tàu and selects only verified Tây Ninh outdoor albums", async () => {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: [
          { id: 1, name: "Biển Vũng Tàu", slug: "vung-tau", tags_text: "Vũng Tàu", category_id: 39, cover_image_url: null, first_photo: "/objects/vung-tau", sort_order: 0 },
          { id: 2, name: "Cảnh ven Núi Bà", slug: "nui-ba", tags_text: "Tây Ninh", category_id: 39, cover_image_url: null, first_photo: "/objects/nui-ba", sort_order: 1 },
        ] };
        if (sql.includes("cms_categories")) return { rows: [
          { id: 37, name: "ẢNH CƯỚI", parent_id: null },
          { id: 39, name: "Ngoại cảnh cưới", parent_id: 37 },
        ] };
        return { rows: [] };
      });
    const images = await resolveSampleImages({ intents: ["album_outdoor"], messageText: "Núi Bà Đen Tây Ninh", maxTotal: 2 });
    expect(images.map((image) => image.imageUrl)).toEqual(["/objects/nui-ba"]);
  });

  it("keeps birthday Beauty samples in the birthday subtype", async () => {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: [
          { id: 1, name: "Sexy", slug: "sexy", tags_text: "sexy", category_id: 33, cover_image_url: null, first_photo: "/objects/sexy", sort_order: 0 },
          { id: 2, name: "Sinh nhật", slug: "birthday", tags_text: "beauty sinh nhật", category_id: 86, cover_image_url: null, first_photo: "/objects/birthday", sort_order: 5 },
        ] };
        if (sql.includes("cms_categories")) return { rows: [
          { id: 32, name: "THỜI TRANG", parent_id: null },
          { id: 33, name: "Sexy", parent_id: 32 },
          { id: 86, name: "SINH NHẬT", parent_id: 32 },
        ] };
        return { rows: [] };
      });
    const images = await resolveSampleImages({ intents: ["beauty"], messageText: "beauty sinh nhật sang trọng", maxTotal: 2 });
    expect(images.map((image) => image.imageUrl)).toEqual(["/objects/birthday"]);
  });
});

describe("sale-samples: CMS tag fallback and conversation dedupe", () => {
  const categories = [
    { id: 32, name: "Thoi trang", parent_id: null },
    { id: 33, name: "Beauty", parent_id: 32 },
    { id: 37, name: "Anh cuoi", parent_id: null },
    { id: 38, name: "Cong Studio - Album Studio", parent_id: 37 },
    { id: 40, name: "Album Studio", parent_id: 37 },
  ];

  function mockGallery(albums: unknown[]) {
    (pool.query as unknown as { mockImplementation: (fn: (sql: string) => Promise<{ rows: unknown[] }>) => void })
      .mockImplementation(async (sql: string) => {
        if (sql.includes("gallery_albums")) return { rows: albums };
        if (sql.includes("cms_categories")) return { rows: categories };
        return { rows: [] };
      });
  }

  it("uses only exact CMS style tags and falls back inside the Gate branch when the tag is absent", async () => {
    mockGallery([
      { id: 1, name: "Nhe nhang only in album name", slug: "gate-name", tags_text: "", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-name", sort_order: 1 },
      { id: 2, name: "Gate luxury", slug: "gate-luxury", tags_text: "sang trong, cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-luxury", sort_order: 2 },
      { id: 3, name: "Beauty nhe nhang", slug: "beauty-soft", tags_text: "nhe nhang, beauty", category_id: 33, cover_image_url: null, first_photo: "/objects/beauty-soft", sort_order: 1 },
    ]);

    const result = await selectSampleImages({
      sampleRequested: true,
      sampleIntents: ["wedding_gate"],
      intentLocked: true,
      messageText: "Cho minh xem mau chup cong nhe nhang.",
      maxTotal: 2,
    });

    expect(result.images.map((image) => image.imageUrl)).not.toContain("/objects/beauty-soft");
    expect(result.images.every((image) => image.serviceIntent === "wedding_gate")).toBe(true);
    expect(result.styleMatched).toBe(false);
    expect(buildWorkflowSampleReply({ serviceKey: "wedding_gate", style: "nhe nhang", styleMatched: result.styleMatched }))
      .not.toContain("nhẹ nhàng");
  });

  it("returns only the Gate asset whose CMS tag exactly matches sang trong", async () => {
    mockGallery([
      { id: 1, name: "Sang trong only in name", slug: "gate-name", tags_text: "cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-name", sort_order: 1 },
      { id: 2, name: "Gate tagged", slug: "gate-tagged", tags_text: "sang trong, cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-tagged", sort_order: 2 },
      { id: 3, name: "Beauty tagged", slug: "beauty-tagged", tags_text: "sang trong, beauty", category_id: 33, cover_image_url: null, first_photo: "/objects/beauty-tagged", sort_order: 3 },
    ]);

    const result = await selectSampleImages({
      sampleRequested: true,
      sampleIntents: ["wedding_gate"],
      intentLocked: true,
      messageText: "Cho minh xem mau chup cong sang trong.",
      maxTotal: 2,
    });

    expect(result.images.map((image) => image.imageUrl)).toEqual(["/objects/gate-tagged"]);
    expect(result.styleMatched).toBe(true);
  });

  it("does not repeat URLs when the customer asks to see more", async () => {
    mockGallery([
      { id: 1, name: "Gate 1", slug: "gate-1", tags_text: "cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-1", sort_order: 1 },
      { id: 2, name: "Gate 2", slug: "gate-2", tags_text: "cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-2", sort_order: 2 },
      { id: 3, name: "Gate 3", slug: "gate-3", tags_text: "cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-3", sort_order: 3 },
    ]);

    const first = await selectSampleImages({
      sampleRequested: true, sampleIntents: ["wedding_gate"], intentLocked: true,
      messageText: "Cho minh xem mau chup cong.", maxTotal: 1,
    });
    const second = await selectSampleImages({
      sampleRequested: true, sampleIntents: ["wedding_gate"], intentLocked: true,
      messageText: "Cho xem them.", excludeUrls: first.images.map((image) => image.imageUrl), maxTotal: 1,
    });

    expect(second.images[0]?.imageUrl).not.toBe(first.images[0]?.imageUrl);
    expect(extractRecentSampleUrls([
      { direction: "outgoing", message: "[image:https://cdn.example/gate-1.jpg]" },
      { direction: "outgoing", message: "Tin nhan binh thuong" },
      { direction: "outgoing", message: "[image:https://cdn.example/gate-2.jpg]" },
    ])).toEqual(["https://cdn.example/gate-1.jpg", "https://cdn.example/gate-2.jpg"]);
  });

  it("supports three real Gate images and exact expanded style tags", async () => {
    mockGallery([
      { id: 1, name: "Gate editorial 1", slug: "gate-editorial-1", tags_text: "editorial, cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-editorial-1", sort_order: 1 },
      { id: 2, name: "Gate editorial 2", slug: "gate-editorial-2", tags_text: "editorial, cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-editorial-2", sort_order: 2 },
      { id: 3, name: "Gate editorial 3", slug: "gate-editorial-3", tags_text: "editorial, cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate-editorial-3", sort_order: 3 },
    ]);

    const result = await selectSampleImages({
      sampleRequested: true,
      sampleIntents: ["wedding_gate"],
      intentLocked: true,
      messageText: "Cho minh xem 3 mau chup cong editorial.",
      maxTotal: 3,
    });

    expect(result.images).toHaveLength(3);
    expect(result.styleMatched).toBe(true);
    expect(result.requestedStyleTags).toEqual(["editorial"]);
  });

  it("switches from Beauty to Gate and then to Album Studio without reusing the old Gate asset", async () => {
    mockGallery([
      { id: 1, name: "Beauty", slug: "beauty", tags_text: "beauty, sexy", category_id: 33, cover_image_url: null, first_photo: "/objects/beauty", sort_order: 1 },
      { id: 2, name: "Gate", slug: "gate", tags_text: "cuoi, studio", category_id: 38, cover_image_url: null, first_photo: "/objects/gate", sort_order: 2 },
      { id: 3, name: "Album studio", slug: "album-studio", tags_text: "cuoi, studio", category_id: 40, cover_image_url: null, first_photo: "/objects/album-studio", sort_order: 3 },
    ]);

    const gate = await selectSampleImages({
      sampleRequested: true, sampleIntents: ["wedding_gate"], intentLocked: true,
      messageText: "Cho minh xem mau chup cong.", contextText: "Luc truoc minh hoi beauty.", maxTotal: 1,
    });
    const studio = await selectSampleImages({
      sampleRequested: true, sampleIntents: ["album_studio"], intentLocked: true,
      messageText: "Cho minh xem mau album studio.", contextText: "Khach da xem anh cong.",
      excludeUrls: gate.images.map((image) => image.imageUrl), maxTotal: 1,
    });

    expect(gate.images.map((image) => image.imageUrl)).toEqual(["/objects/gate"]);
    expect(studio.images.map((image) => image.imageUrl)).toEqual(["/objects/album-studio"]);
  });
});
