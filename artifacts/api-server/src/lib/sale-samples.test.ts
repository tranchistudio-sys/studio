import { describe, it, expect, vi } from "vitest";

// Pure-function tests: mock DB để không cần DATABASE_URL khi import module.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import {
  detectServiceIntentFromText,
  normalizeIntent,
  detectGender,
  sampleGender,
  buildSampleLinks,
  toPublicImageUrl,
  type SampleImage,
} from "./sale-samples";

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

describe("sale-samples: toPublicImageUrl", () => {
  it("absolute giữ nguyên; /uploads & /objects resolve đúng tiền tố", () => {
    expect(toPublicImageUrl("https://cdn/x.jpg")).toBe("https://cdn/x.jpg");
    expect(toPublicImageUrl("/uploads/cms/x.webp")).toMatch(/\/uploads\/cms\/x\.webp$/);
    expect(toPublicImageUrl("/objects/uploads/abc")).toMatch(/\/api\/storage\/objects\/uploads\/abc$/);
    expect(toPublicImageUrl("")).toBe("");
  });
});
