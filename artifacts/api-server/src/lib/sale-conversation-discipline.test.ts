import { describe, it, expect } from "vitest";
import {
  inferKnownIntent,
  buildAntiDriftRule,
  detectServiceDrift,
  type ConversationTurn,
} from "./sale-conversation-discipline";

const incoming = (message: string): ConversationTurn => ({ direction: "incoming", message });
const outgoing = (message: string): ConversationTurn => ({ direction: "outgoing", message });

describe("inferKnownIntent — suy ra nhu cầu đang khóa từ hội thoại", () => {
  it("khách nói 'chụp cổng' → wedding_gate", () => {
    expect(inferKnownIntent([], "Anh muốn chụp cổng cưới")).toBe("wedding_gate");
    expect(inferKnownIntent([], "chụp cổng bao nhiêu")).toBe("wedding_gate");
  });

  it("khách nói 'chụp cưới / album / ngoại cảnh' (không phải cổng) → wedding", () => {
    expect(inferKnownIntent([], "Anh cần chụp cưới album studio")).toBe("wedding");
    expect(inferKnownIntent([], "bên mình có chụp ngoại cảnh không")).toBe("wedding");
  });

  it("beauty / cool boy → beauty", () => {
    expect(inferKnownIntent([], "Anh muốn chụp beauty")).toBe("beauty");
    expect(inferKnownIntent([], "cho xem mẫu cool boy")).toBe("beauty");
  });

  it("'thuê váy cưới' → rental (KHÔNG nhầm thành wedding)", () => {
    expect(inferKnownIntent([], "Cho anh thuê váy cưới")).toBe("rental");
  });

  it("chụp bầu → maternity; gia đình → family", () => {
    expect(inferKnownIntent([], "Anh chị muốn chụp bầu")).toBe("maternity");
    expect(inferKnownIntent([], "chụp gia đình cả nhà")).toBe("family");
  });

  it("dùng được cả khi gõ KHÔNG dấu", () => {
    expect(inferKnownIntent([], "chup cong cuoi gia bao nhieu")).toBe("wedding_gate");
    expect(inferKnownIntent([], "thue ao dai")).toBe("rental");
  });

  it("tin MƠ HỒ (nhắc ≥2 nhóm, kiểu menu/so sánh) → bỏ qua, không khóa sai", () => {
    expect(inferKnownIntent([], "chụp cưới hay chụp gia đình thì sao em")).toBeNull();
  });

  it("CHỈ lấy tin KHÁCH (incoming) — bỏ qua menu chào hỏi của bot", () => {
    const history = [
      outgoing("Anh đang tìm hiểu chụp cưới, chụp beauty hay chụp gia đình vậy anh?"),
      incoming("Anh chụp cổng cưới"),
    ];
    expect(inferKnownIntent(history, "")).toBe("wedding_gate");
  });

  it("không tự khóa từ tin bot dù bot lỡ nhắc 1 dịch vụ khác", () => {
    const history = [
      incoming("Anh chụp cổng cưới"),
      outgoing("Dạ bên em cũng có chụp gia đình nha anh"),
    ];
    // tin mới nhất (current) trống → quét incoming: 'chụp cổng cưới' → wedding_gate, KHÔNG phải family
    expect(inferKnownIntent(history, "ok em")).toBe("wedding_gate");
  });

  it("lấy nhu cầu MỚI NHẤT khi khách chủ động đổi", () => {
    const history = [incoming("Anh chụp cưới")];
    expect(inferKnownIntent(history, "à thôi anh chụp beauty đi")).toBe("beauty");
  });

  it("chưa rõ nhu cầu → null", () => {
    expect(inferKnownIntent([], "alo em ơi")).toBeNull();
    expect(inferKnownIntent([], "")).toBeNull();
  });
});

describe("inferKnownIntent — chống va chạm keyword (regression sau review)", () => {
  it("'chụp cá nhân' KHÔNG bị 'cả nhà' nuốt → vẫn là beauty", () => {
    expect(inferKnownIntent([], "anh muốn chụp cá nhân")).toBe("beauty");
    expect(inferKnownIntent([], "chụp cá nhân profile")).toBe("beauty");
    expect(inferKnownIntent([], "anh chụp ảnh cá nhân nàng thơ")).toBe("beauty");
  });

  it("'cả nhà' thật vẫn ra family", () => {
    expect(inferKnownIntent([], "chụp cả nhà mình")).toBe("family");
    expect(inferKnownIntent([], "chụp gia đình cả nhà")).toBe("family");
  });

  it("'có đâu' (mặc cả) / 'chứ rẻ' KHÔNG khóa nhầm thành cưới", () => {
    expect(inferKnownIntent([], "giá gì mà mắc, có đâu mà chốt")).not.toBe("wedding");
    expect(inferKnownIntent([], "giá gì mà mắc, có đâu mà chốt")).not.toBe("wedding_gate");
    expect(inferKnownIntent([], "bên kia chứ rẻ hơn nhiều")).not.toBe("wedding");
  });

  it("tên đường 'Cộng Hòa' KHÔNG khóa nhầm wedding_gate", () => {
    expect(inferKnownIntent([], "địa chỉ 268 Cộng Hòa quận Tân Bình")).toBeNull();
  });

  it("'chụp công ty' (corporate) KHÔNG khóa nhầm wedding_gate", () => {
    expect(inferKnownIntent([], "chụp công ty anh được không em")).not.toBe("wedding_gate");
    expect(inferKnownIntent([], "chụp công ty anh được không em")).not.toBe("wedding");
  });
});

describe("buildAntiDriftRule — khối luật chống trôi trong system prompt", () => {
  it("luôn có các luật chống reset / không hỏi lại / mỗi lượt 1 câu / sau khi gửi ảnh", () => {
    const rule = buildAntiDriftRule(null);
    expect(rule).toContain("KHÔNG RESET hội thoại");
    expect(rule).toContain("ĐÃ BIẾT thì KHÔNG hỏi lại");
    expect(rule).toContain("MỖI LƯỢT CHỈ HỎI 1 CÂU CHÍNH");
    expect(rule).toContain("SAU KHI GỬI ẢNH CONCEPT/MẪU");
    expect(rule).toContain("KHÔNG \"đổ menu\"");
  });

  it("knownIntent=null → KHÔNG có dòng KHÓA NHU CẦU (negative control)", () => {
    expect(buildAntiDriftRule(null)).not.toContain("KHÓA NHU CẦU HIỆN TẠI");
  });

  it("đã biết nhu cầu → thêm dòng KHÓA NHU CẦU đúng nhãn từng nhóm", () => {
    expect(buildAntiDriftRule("wedding_gate")).toContain("KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm chụp cổng cưới");
    expect(buildAntiDriftRule("wedding")).toContain("KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm chụp cưới");
    expect(buildAntiDriftRule("beauty")).toContain("KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm beauty / chụp cá nhân");
    expect(buildAntiDriftRule("rental")).toContain("KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm cho thuê trang phục");
    expect(buildAntiDriftRule("maternity")).toContain("KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm chụp bầu");
    expect(buildAntiDriftRule("family")).toContain("KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm chụp gia đình");
  });

  it("dòng khóa cưới nêu rõ các dịch vụ KHÁC cần tránh đổi sang", () => {
    expect(buildAntiDriftRule("wedding_gate")).toContain("KHÔNG gợi ý/đổi sang gia đình, beauty/cá nhân, chụp bầu, sản phẩm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Các tình huống nghiệp vụ A–F (theo yêu cầu chủ studio).
//
// Câu trả lời THẬT do model sinh (cần API key, không tất định) — nên ở tầng unit ta kiểm:
//  (1) hội thoại suy ra ĐÚNG nhu cầu đang khóa, và prompt ÉP model bám nhóm + không reset;
//  (2) detectServiceDrift PHÁT HIỆN được câu trả lời "trôi" (chứa cụm cấm) và BỎ QUA câu tốt.
// Tức là: nếu model lỡ trôi, ta bắt được; và prompt đã chỉ thị rõ để model không trôi.
// ─────────────────────────────────────────────────────────────────────────────

describe("Case A — intent=wedding_gate, khách hỏi tone 'Nhẹ nhàng trông ntn'", () => {
  const history = [
    incoming("Anh muốn chụp cổng cưới"),
    outgoing("Dạ chụp cổng đó anh 😊. Anh thích kiểu nhẹ nhàng hay sang trọng ạ?"),
  ];
  const intent = inferKnownIntent(history, "Nhẹ nhàng trông ntn");

  it("vẫn khóa ở wedding_gate dù tin mới không có từ khóa dịch vụ", () => {
    expect(intent).toBe("wedding_gate");
  });

  it("câu trả lời RESET/đổi nhóm bị bắt là trôi — pin đủ các cụm cấm chủ studio liệt kê", () => {
    const bad = "Dạ anh cần chụp dịch vụ gì ạ? Chụp cưới, gia đình hay beauty, chụp bầu, sản phẩm?";
    const drift = detectServiceDrift(bad, intent);
    // "Anh cần chụp dịch vụ gì" / "Anh đang cần chụp dịch vụ gì"
    expect(drift).toContain("reset:can chup dich vu gi");
    // "Chụp cưới, gia đình"
    expect(drift).toContain("reset:chup cuoi, gia dinh");
    // các dịch vụ KHÁC bị nhắc khi đã khóa cưới: beauty / bầu / sản phẩm / gia đình
    expect(drift).toContain("offintent:beauty");
    expect(drift).toContain("offintent:gia dinh");
    expect(drift).toContain("offintent:bau");
    expect(drift).toContain("offintent:san pham");
  });

  it("câu trả lời tiếp tục tư vấn cưới → KHÔNG bị coi là trôi", () => {
    const good =
      "Dạ tone nhẹ nhàng là kiểu trong trẻo, màu sáng tự nhiên nha anh.\n\n" +
      "Anh thích cổng hoa pastel hay xanh lá để em gửi đúng mẫu ạ?";
    expect(detectServiceDrift(good, intent)).toEqual([]);
  });
});

describe("Case B — intent=wedding_gate, khách hỏi 'giá sao em'", () => {
  const history = [incoming("Anh muốn chụp cổng cưới")];
  const intent = inferKnownIntent(history, "giá sao em");

  it("giữ nguyên nhu cầu cưới khi hỏi giá", () => {
    expect(intent).toBe("wedding_gate");
  });

  it("prompt yêu cầu báo giá đúng nhóm + khóa nhu cầu cưới, không hỏi lại dịch vụ", () => {
    const rule = buildAntiDriftRule(intent);
    expect(rule).toContain("KHÁCH HỎI GIÁ");
    expect(rule).toContain("KHÔNG hỏi lại dịch vụ");
    // dòng khóa nhu cầu cưới chỉ xuất hiện khi intent != null
    expect(rule).toContain("khách ĐANG quan tâm chụp cổng cưới");
  });

  it("câu báo giá cưới (hỏi gu trước, khớp PRICE_GATING) → KHÔNG trôi; câu hỏi lại dịch vụ → trôi", () => {
    const good = "Dạ chụp cổng bên em tone nhẹ nhàng hay sang trọng cổ điển hơn để em báo đúng gói nha anh?";
    expect(detectServiceDrift(good, intent)).toEqual([]);
    const bad = "Dạ anh cần chụp gì để em báo giá ạ?";
    expect(detectServiceDrift(bad, intent)).toContain("reset:can chup gi");
  });
});

describe("Case C — intent=beauty, khách hỏi 'tone nhẹ nhàng có không'", () => {
  const history = [incoming("Anh muốn chụp beauty")];
  const intent = inferKnownIntent(history, "tone nhẹ nhàng có không");

  it("giữ nguyên beauty", () => {
    expect(intent).toBe("beauty");
  });

  it("trả lời trong beauty → ok; nhảy sang cưới → trôi", () => {
    const good = "Dạ beauty bên em tone nhẹ nhàng trong trẻo lắm nha. Anh thích nàng thơ hay cá tính hơn ạ?";
    expect(detectServiceDrift(good, intent)).toEqual([]);
    const bad = "Dạ bên em có chụp cưới đẹp lắm, anh xem thử nha?";
    expect(detectServiceDrift(bad, intent)).toContain("offintent:chup cuoi");
  });
});

describe("Case D — intent=rental, khách hỏi 'váy này thuê nhiêu'", () => {
  const history = [incoming("Cho anh thuê váy cưới")];
  const intent = inferKnownIntent(history, "váy này thuê nhiêu");

  it("giữ nguyên rental", () => {
    expect(intent).toBe("rental");
  });

  it("trả lời giá thuê → ok; hỏi 'muốn chụp gì' → trôi", () => {
    const good = "Dạ váy cưới này bên em cho thuê 800k một ngày nha anh. Anh cần thuê ngày nào ạ?";
    expect(detectServiceDrift(good, intent)).toEqual([]);
    const bad = "Dạ anh muốn chụp gì để em tư vấn ạ?";
    expect(detectServiceDrift(bad, intent)).toContain("reset:muon chup gi");
  });
});

describe("Case E — đã biết NGÀY chụp → không hỏi lại ngày", () => {
  it("khối luật yêu cầu không hỏi lại thông tin đã biết, nêu rõ ví dụ NGÀY", () => {
    const rule = buildAntiDriftRule("wedding");
    expect(rule).toContain("NGÀY chụp");
    expect(rule).toContain("đã có ngày chụp thì đừng hỏi ngày nữa");
  });
});

describe("Case F — đã gửi concept, khách nói 'đẹp á'", () => {
  const history = [
    incoming("Anh muốn chụp cưới"),
    outgoing("Dạ em gửi anh 2 mẫu gần mood nhất nha 😊"),
  ];
  const intent = inferKnownIntent(history, "đẹp á");

  it("vẫn giữ nhu cầu cưới sau khi đã gửi ảnh", () => {
    expect(intent).toBe("wedding");
  });

  it("bước kế phải tiến tới chốt (không reset)", () => {
    const good = "Dạ anh ưng mẫu nào nhất để em tư vấn gói chụp phù hợp và báo giá nha?";
    expect(detectServiceDrift(good, intent)).toEqual([]);
    const bad = "Dạ vậy anh đang cần chụp dịch vụ gì ạ?";
    expect(detectServiceDrift(bad, intent)).toContain("reset:can chup dich vu gi");
  });
});
