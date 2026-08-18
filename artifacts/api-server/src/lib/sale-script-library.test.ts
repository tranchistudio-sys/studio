import { describe, it, expect, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import { parsePastedRows, parsePasteMatrix, looksLikeHeader, matrixToRows, scriptHasHardcodedPrice, buildGoldenExamplesBlock, getGoldenExamples, retargetNodeKey } from "./sale-script-library";

const mockQuery = pool.query as unknown as ReturnType<typeof vi.fn>;

/**
 * Script Library — test phần THUẦN (parse dán / cảnh báo giá cứng / build block).
 * (CRUD/retrieval qua DB test ở tầng integration; ở đây khoá logic không-DB.)
 */

describe("parsePastedRows — dán từ Excel/Sheets (tự suy cột)", () => {
  it("TAB 3 cột → [khách, trả lời, ghi chú]", () => {
    const rows = parsePastedRows("Sao mắc vậy\tDạ em hiểu ạ\tghi chú 1\nGiá cao quá\tDạ bên em ưu tiên chất lượng\t");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ customerText: "Sao mắc vậy", idealResponse: "Dạ em hiểu ạ", notes: "ghi chú 1" });
    expect(rows[1].customerText).toBe("Giá cao quá");
  });

  it("TAB 5 cột → [nhóm, tình huống, khách, trả lời, ghi chú]", () => {
    const rows = parsePastedRows("Album cưới\tChê giá\tSao mắc vậy\tDạ em hiểu ạ\tnote");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      groupLabel: "Album cưới", situationLabel: "Chê giá",
      customerText: "Sao mắc vậy", idealResponse: "Dạ em hiểu ạ", notes: "note",
    });
  });

  it("TAB 4 cột → [nhóm, tình huống, khách, trả lời]", () => {
    const rows = parsePastedRows("Album cưới\tHỏi giá\tBao nhiêu\tDạ gói hiện tại là {{PRICE}} ạ");
    expect(rows[0]).toMatchObject({ groupLabel: "Album cưới", situationLabel: "Hỏi giá", customerText: "Bao nhiêu" });
  });

  it("bỏ dòng tiêu đề (≥2 chữ tiêu đề chuẩn)", () => {
    const rows = parsePastedRows("Nhóm\tTình huống\tKhách hỏi\tLulu trả lời\tGhi chú\nAlbum\tChê giá\tSao mắc\tDạ em…\t");
    expect(rows).toHaveLength(1);
    expect(rows[0].customerText).toBe("Sao mắc");
  });

  it("bỏ dòng trống, cap không lỗi", () => {
    const rows = parsePastedRows("\n\nchị xem giá\tdạ đây ạ\n\n");
    expect(rows).toHaveLength(1);
  });

  it("100 dòng dán một lần → 100 dòng (không vỡ, không nhầm header)", () => {
    const text = Array.from({ length: 100 }, (_, i) => `Tin nhắn số ${i}\tPhản hồi mẫu ${i}`).join("\n");
    expect(parsePastedRows(text)).toHaveLength(100);
  });

  it("không TAB → fallback tách dấu | / 2+ khoảng trắng", () => {
    const rows = parsePastedRows("Sao mắc vậy | Dạ em hiểu ạ | note");
    expect(rows[0]).toMatchObject({ customerText: "Sao mắc vậy", idealResponse: "Dạ em hiểu ạ", notes: "note" });
  });
});

describe("matrixToRows — ép thứ tự cột theo mapping (preview)", () => {
  it("mapping đảo cột: trả lời đứng trước khách", () => {
    const m = parsePasteMatrix("Dạ em hiểu ạ\tSao mắc vậy");
    const rows = matrixToRows(m, ["idealResponse", "customerText"]);
    expect(rows[0]).toMatchObject({ customerText: "Sao mắc vậy", idealResponse: "Dạ em hiểu ạ" });
  });
  it("mapping 'skip' bỏ cột thừa", () => {
    const rows = matrixToRows([["STT", "Sao mắc", "Dạ em"]], ["skip", "customerText", "idealResponse"]);
    expect(rows[0]).toMatchObject({ customerText: "Sao mắc", idealResponse: "Dạ em" });
  });
  it("có mapping thì KHÔNG tự bỏ header (do người dùng chủ động chọn)", () => {
    const rows = matrixToRows([["Khách", "Sale"], ["Sao mắc", "Dạ em"]], ["customerText", "idealResponse"]);
    expect(rows).toHaveLength(2);
  });
});

describe("retargetNodeKey — chép golden sang dịch vụ khác", () => {
  it("đổi đúng đoạn service, giữ step::situation", () => {
    expect(retargetNodeKey("svc::album-tai-studio::xu-ly-phan-van::gia-cao", "album-tai-studio", "beauty-thoi-trang"))
      .toBe("svc::beauty-thoi-trang::xu-ly-phan-van::gia-cao");
  });
  it("không khớp prefix → null (không chép nhầm greeting/khác)", () => {
    expect(retargetNodeKey("global-chao-hoi::chao-hoi", "album-tai-studio", "beauty")).toBeNull();
    expect(retargetNodeKey("svc::x::a", "album-tai-studio", "beauty")).toBeNull();
  });
});

describe("looksLikeHeader", () => {
  it("hàng tiêu đề chuẩn → true", () => {
    expect(looksLikeHeader(["Nhóm", "Tình huống", "Khách hỏi", "Lulu trả lời", "Ghi chú"])).toBe(true);
  });
  it("dữ liệu thật thường → false", () => {
    expect(looksLikeHeader(["Sao mắc vậy em", "Dạ em hiểu ạ"])).toBe(false);
  });
});

describe("scriptHasHardcodedPrice — cảnh báo giá cứng trong câu mẫu", () => {
  it("bắt số tiền cụ thể", () => {
    expect(scriptHasHardcodedPrice("Dạ gói này 3.900.000đ ạ")).toBe(true);
    expect(scriptHasHardcodedPrice("giá 5 triệu nha")).toBe(true);
    expect(scriptHasHardcodedPrice("cọc 500k")).toBe(true);
  });
  it("KHÔNG cảnh báo khi dùng placeholder / nói chung", () => {
    expect(scriptHasHardcodedPrice("Dạ gói này hiện bên em là {{PRICE}} ạ")).toBe(false);
    expect(scriptHasHardcodedPrice("Dạ em gửi mình các gói hiện tại nha")).toBe(false);
  });
});

describe("getGoldenExamples — retrieval top-N deterministic", () => {
  const EXAMPLES = [
    { customer_text: "sao album bên em mắc vậy", ideal_response: "R-mac", notes: "" },
    { customer_text: "giá cao quá em ơi", ideal_response: "R-cao", notes: "" },
    { customer_text: "chị muốn xem thêm concept khác", ideal_response: "R-concept", notes: "" },
  ];
  function armSelect() {
    // ensureScriptTable chạy CREATE/INDEX (trả rows:[]); chỉ SELECT scenario_key trả EXAMPLES.
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT (node_key, )?customer_text/i.test(sql)) return { rows: EXAMPLES };
      return { rows: [] };
    });
  }

  it("scenarioKey null → rỗng", async () => {
    expect(await getGoldenExamples(null, "abc")).toEqual([]);
  });

  it("xếp ví dụ TRÙNG TỪ KHOÁ với tin khách lên đầu", async () => {
    armSelect();
    const r = await getGoldenExamples("che-gia-cao", "sao mắc vậy em, album bên mình", 2);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].idealResponse).toBe("R-mac"); // "mắc/album" trùng → hạng 1
    expect(r.length).toBeLessThanOrEqual(2);   // tôn trọng topN
  });

  it("không tin nào trùng → vẫn trả vài ví dụ làm giọng chung (không rỗng)", async () => {
    armSelect();
    const r = await getGoldenExamples("che-gia-cao", "xyzxyz khong lien quan gi", 2);
    expect(r.length).toBeGreaterThan(0);
  });

  it("fail-soft: query throw → rỗng", async () => {
    mockQuery.mockImplementation(async (sql: string) => { if (/SELECT (node_key, )?customer_text/i.test(sql)) throw new Error("db"); return { rows: [] }; });
    expect(await getGoldenExamples("che-gia-cao", "sao mắc")).toEqual([]);
  });
});

describe("buildGoldenExamplesBlock", () => {
  it("rỗng → chuỗi rỗng", () => {
    expect(buildGoldenExamplesBlock([])).toBe("");
  });
  it("có ví dụ → block nhắc 'học giọng, không đọc y nguyên, giá historical lấy từ CRM'", () => {
    const b = buildGoldenExamplesBlock([{ customerText: "sao mắc", idealResponse: "dạ em hiểu", notes: "", score: 2 }]);
    expect(b).toContain("GOLDEN EXAMPLES");
    expect(b).toContain("KHÔNG đọc y nguyên");
    expect(b).toContain("BẢNG GIÁ CRM");
    expect(b).toContain("historical");
    expect(b).toContain("LUẬT AN TOÀN > CRM"); // thứ tự ưu tiên (mục G)
    expect(b).toContain("sao mắc");
  });
});
