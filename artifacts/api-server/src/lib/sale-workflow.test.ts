import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { evaluateSaleWorkflow, type SaleWorkflowDecision } from "./sale-workflow";

type Turn = { direction: "incoming" | "outgoing"; message: string; aiDecision?: string | null };

function decide(message: string, prior: Turn[] = []): SaleWorkflowDecision {
  return evaluateSaleWorkflow({ message, prior });
}

describe("sample confirmation workflow", () => {
  it("discovers, sends gate samples, waits for confirmation, then quotes", () => {
    const discovery = decide("Chị hỏi chụp cổng.");
    expect(discovery.action).toBe("ASK_DISCOVERY");
    expect(discovery.nextSlot?.key).toBe("gate_count");

    const sendSample = decide("Chị thích nhẹ nhàng, tinh tế.", [
      { direction: "incoming", message: "Chụp cổng bao nhiêu?" },
      { direction: "outgoing", message: "Chị thích ảnh cổng theo phong cách nào ạ?" },
    ]);
    expect(sendSample.action).toBe("ASK_DISCOVERY");
    expect(sendSample.nextSlot?.key).toBe("gate_count");

    const directPrice = decide("Cho chị xem giá luôn nha.", [
      { direction: "incoming", message: "Chị hỏi chụp cổng." },
      { direction: "incoming", message: "Chị thích nhẹ nhàng." },
      { direction: "outgoing", message: "[image:/objects/gate-sample]", aiDecision: "claude_sample_img0" },
      { direction: "outgoing", message: "Chị thấy hướng này ổn không ạ?" },
    ]);
    expect(directPrice.priceRequested).toBe(true);
    expect(directPrice.stage).toBe("SEND_PRICE_SHEET");
    expect(directPrice.action).toBe("SEND_PRICE_SHEET");

    const quote = decide("Chị ưng mẫu này, gửi bảng giá nha.", [
      { direction: "incoming", message: "Chị hỏi chụp cổng." },
      { direction: "incoming", message: "Chị thích nhẹ nhàng." },
      { direction: "outgoing", message: "[image:/objects/gate-sample]", aiDecision: "claude_sample_img0" },
    ]);
    expect(quote.sampleConfirmed).toBe(true);
    expect(quote.action).toBe("SEND_PRICE_SHEET");
  });

  it("allows price first only when the customer insists", () => {
    const result = decide("Cứ cho chị xem bảng giá trước đi.", [
      { direction: "incoming", message: "Chị hỏi album studio." },
      { direction: "outgoing", message: "Chị thích phong cách nào ạ?" },
    ]);
    expect(result.forcedPrice).toBe(true);
    expect(result.action).toBe("SEND_PRICE_SHEET");
  });

  it.each([
    "Chị thích tấm thứ 2.",
    "Cái đầu đẹp.",
    "Cái giữa á.",
    "Cái cuối.",
    "Ừ kiểu này được.",
  ])("treats a concrete sample choice as ready for Step 3: %s", (message) => {
    const result = decide(message, [
      { direction: "incoming", message: "Chị hỏi chụp cổng." },
      { direction: "outgoing", message: "[image:/objects/gate-1]", aiDecision: "claude_sample_img0" },
      { direction: "outgoing", message: "[image:/objects/gate-2]", aiDecision: "claude_sample_img1" },
    ]);
    expect(result.sampleConfirmed).toBe(true);
    expect(result.action).toBe("SEND_PRICE_SHEET");
  });

  it.each([
    ["Em thích Hàn Quốc.", "han quoc"],
    ["Em muốn tối giản.", "toi gian"],
    ["Có kiểu fashion hơn không?", "fashion"],
    ["Em thích nhẹ nhàng nền sáng.", "nhe nhang"],
  ])("remembers the requested sample style: %s", (message, style) => {
    const result = decide(message, [
      { direction: "incoming", message: "Chị hỏi chụp cổng." },
    ]);
    expect(result.style).toBe(style);
  });
});

describe("direct action priority and repeat-question regression", () => {
  const albumStart: Turn[] = [
    { direction: "incoming", message: "Album Studio" },
    { direction: "outgoing", message: "Dạ mình thích hướng sang trọng, nàng thơ, nhẹ nhàng, tinh tế hay tối giản hơn ạ?" },
  ];

  it("sends Album Studio samples when style is still empty", () => {
    const result = decide("xem mẫu", albumStart);

    expect(result.serviceKey).toBe("album_studio");
    expect(result.missingSlots.map((slot) => slot.key)).toContain("style");
    expect(result.requestedAction).toBe("sample");
    expect(result.action).toBe("SEND_SAMPLE");
    expect(result.actionPriorityReason).toBe("direct_sample_request");
    expect(result.lastAskedQuestionKey).toBe("style");
  });

  it("treats ung after a sent sample as ready to quote despite missing style", () => {
    const result = decide("ưng", [
      ...albumStart,
      { direction: "incoming", message: "xem mẫu" },
      { direction: "outgoing", message: "[image:/objects/album-studio-sample]", aiDecision: "claude_sample_img0" },
      { direction: "outgoing", message: "Dạ em gửi mình vài mẫu Album Studio để tham khảo nha." },
    ]);

    expect(result.sampleSent).toBe(true);
    expect(result.sampleConfirmed).toBe(true);
    expect(result.requestedAction).toBe("sample_confirmation");
    expect(result.action).toBe("SEND_PRICE_SHEET");
    expect(result.actionPriorityReason).toBe("sample_confirmed_ready_to_quote");
  });

  it("lets a direct price request bypass the unanswered style slot", () => {
    const result = decide("báo giá", albumStart);

    expect(result.detectedIntent).toBe("price_sheet");
    expect(result.priceRequested).toBe(true);
    expect(result.requestedAction).toBe("price_sheet");
    expect(result.action).toBe("SEND_PRICE_SHEET");
    expect(result.selectedAction).toBe("SEND_PRICE_SHEET");
    expect(result.actionPriorityReason).toBe("direct_price_request");
  });

  it("keeps the latest service when switching from Beauty to Album Studio", () => {
    const switched = decide("Album Studio", [
      { direction: "incoming", message: "Cho xem Beauty sexy" },
      { direction: "outgoing", message: "[image:/objects/beauty-sample]", aiDecision: "claude_sample_img0" },
    ]);
    expect(switched.serviceKey).toBe("album_studio");
    expect(switched.requestedAction).toBe("service_switch");
    expect(switched.action).toBe("ASK_DISCOVERY");

    const sample = decide("xem mẫu", [
      { direction: "incoming", message: "Cho xem Beauty sexy" },
      { direction: "outgoing", message: "[image:/objects/beauty-sample]", aiDecision: "claude_sample_img0" },
      { direction: "incoming", message: "Album Studio" },
      { direction: "outgoing", message: "Dạ mình thích phong cách nào ạ?" },
    ]);
    expect(sample.serviceKey).toBe("album_studio");
    expect(sample.sampleSent).toBe(false);
    expect(sample.action).toBe("SEND_SAMPLE");
  });

  it("does not ask the same style question again when the slot remains empty", () => {
    const result = decide("ừ", albumStart);

    expect(result.askedQuestionKeys).toEqual(["style"]);
    expect(result.lastAskedQuestionKey).toBe("style");
    expect(result.action).toBe("SEND_SAMPLE");
    expect(result.actionPriorityReason).toBe("repeat_question_guard:style");
  });

  it("runs Album Studio -> xem mau -> ung -> bao gia without returning to discovery", () => {
    const first = decide("Album Studio");
    expect(first.action).toBe("ASK_DISCOVERY");

    const sample = decide("xem mẫu", [
      { direction: "incoming", message: "Album Studio" },
      { direction: "outgoing", message: "Dạ mình thích hướng sang trọng, nàng thơ, nhẹ nhàng, tinh tế hay tối giản hơn ạ?" },
    ]);
    expect(sample.action).toBe("SEND_SAMPLE");

    const confirmed = decide("ưng", [
      { direction: "incoming", message: "Album Studio" },
      { direction: "outgoing", message: "Dạ mình thích hướng sang trọng, nàng thơ, nhẹ nhàng, tinh tế hay tối giản hơn ạ?" },
      { direction: "incoming", message: "xem mẫu" },
      { direction: "outgoing", message: "[image:/objects/album-studio-sample]", aiDecision: "claude_sample_img0" },
      { direction: "outgoing", message: "Dạ em gửi mình vài mẫu Album Studio để tham khảo nha." },
    ]);
    expect(confirmed.action).toBe("SEND_PRICE_SHEET");

    const price = decide("báo giá", [
      { direction: "incoming", message: "Album Studio" },
      { direction: "outgoing", message: "Dạ mình thích hướng sang trọng, nàng thơ, nhẹ nhàng, tinh tế hay tối giản hơn ạ?" },
      { direction: "incoming", message: "xem mẫu" },
      { direction: "outgoing", message: "[image:/objects/album-studio-sample]", aiDecision: "claude_sample_img0" },
      { direction: "incoming", message: "ưng" },
    ]);
    expect(price.priceRequested).toBe(true);
    expect(price.action).toBe("SEND_PRICE_SHEET");
    expect([sample.action, confirmed.action, price.action]).not.toContain("ASK_DISCOVERY");
  });

  it("continues package advice after a price sheet instead of returning to sample confirmation", () => {
    const result = decide("chinh chu hon", [
      { direction: "incoming", message: "Toi muon chup cong cuoi" },
      { direction: "incoming", message: "Phong cach nhe nhang" },
      { direction: "outgoing", message: "[image:/objects/gate-sample]", aiDecision: "claude_sample_img0" },
      { direction: "incoming", message: "Bao gia chup cong" },
      { direction: "outgoing", message: "[image:/objects/gate-price]", aiDecision: "claude_price_sheet_img0" },
      { direction: "outgoing", message: "Minh uu tien tiet kiem hay hinh anh chinh chu hon?", aiDecision: "claude_price_sheet_replied" },
    ]);

    expect(result.priceSheetSent).toBe(true);
    expect(result.style).toBe("chinh chu");
    expect(result.stage).toBe("RECOMMEND_PACKAGE");
    expect(result.action).toBe("CONTINUE_CONVERSATION");
    expect(result.actionPriorityReason).toBe("price_sheet_already_sent_follow_latest_preference");
  });

  it("never asks for sample confirmation twice", () => {
    const result = decide("hmm", [
      { direction: "incoming", message: "Toi muon chup cong cuoi phong cach nhe nhang" },
      { direction: "outgoing", message: "[image:/objects/gate-sample]", aiDecision: "claude_sample_img0" },
      { direction: "outgoing", message: "Minh thay mau em vua gui co hop gu khong a? Minh ung huong nao thi noi em nha.", aiDecision: "claude_sample_replied" },
    ]);

    expect(result.sampleSent).toBe(true);
    expect(result.askedQuestionKeys).toContain("sample_confirmation");
    expect(result.action).toBe("CONTINUE_CONVERSATION");
    expect(result.actionPriorityReason).toBe("repeat_sample_confirmation_guard");
  });

  it("acknowledges when the customer wants time instead of asking another question", () => {
    const result = decide("de minh xem them", [
      { direction: "incoming", message: "Toi muon chup cong cuoi phong cach nhe nhang" },
      { direction: "outgoing", message: "[image:/objects/gate-sample]", aiDecision: "claude_sample_img0" },
      { direction: "incoming", message: "Bao gia chup cong" },
      { direction: "outgoing", message: "[image:/objects/gate-price]", aiDecision: "claude_price_sheet_img0" },
      { direction: "outgoing", message: "Minh uu tien tiet kiem hay hinh anh chinh chu hon?", aiDecision: "claude_price_sheet_replied" },
    ]);

    expect(result.stage).toBe("FOLLOW_UP");
    expect(result.action).toBe("CONTINUE_CONVERSATION");
    expect(result.actionPriorityReason).toBe("customer_wants_time_to_consider");
  });
});

describe("intent ownership and contextual routing", () => {
  const pricedGate: Turn[] = [
    { direction: "incoming", message: "Chụp cổng bao nhiêu?" },
    { direction: "outgoing", message: "[image:/objects/gate-price]", aiDecision: "price_sheet" },
  ];

  it.each([
    ["Basic với Premium khác gì?", "EXPLAIN_PACKAGES", "owner_gate_step_4_compare"],
    ["Có khuyến mãi không?", "FOLLOW_UP", "owner_gate_step_5_promotion"],
    ["Mắc quá em.", "RECOMMEND_PACKAGE", "owner_gate_step_6_objection"],
    ["Chị lấy Premium.", "CLOSE_OR_HANDOFF", "owner_gate_step_7_decision"],
  ])("routes %s to its single owner", (message, stage, reason) => {
    const result = decide(message, pricedGate);
    expect(result.stage).toBe(stage);
    expect(result.reason).toBe(reason);
    expect(result.action).not.toBe("SEND_PRICE_SHEET");
  });

  it.each([
    "Beauty có tính thêm một dịch vụ không?",
    "Quà có cộng dồn không?",
    "Chốt 2 dịch vụ được quà gì?",
  ])("keeps promotion eligibility in Step 5 even when another service is mentioned: %s", (message) => {
    const result = decide(message, []);
    expect(result.stage).toBe("FOLLOW_UP");
    expect(result.reason).toBe("owner_gate_step_5_promotion");
  });

  it.each([
    ["Có ngoại cảnh không?", "common_clarify_outdoor"],
    ["Có váy không?", "common_clarify_dress"],
  ])("clarifies ambiguous contextual request: %s", (message, reason) => {
    const result = decide(message, pricedGate);
    expect(result.serviceKey).toBe("wedding_gate");
    expect(result.reason).toBe(reason);
  });

  it("keeps a package-rights dress question in gate but switches an explicit rental request", () => {
    expect(decide("Gói cổng này có váy không?", pricedGate).serviceKey).toBe("wedding_gate");
    expect(decide("Bên em cho thuê váy riêng không?", pricedGate).serviceKey).toBe("rental_outfit");
  });

  it("does not let gate intent owners capture another service", () => {
    const albumContext: Turn[] = [
      { direction: "incoming", message: "Chị muốn chụp album studio." },
      { direction: "outgoing", message: "Em đang tư vấn album studio cho chị nha." },
    ];
    const result = decide("Gói Premium khác gì?", albumContext);
    expect(result.serviceKey).toBe("album_studio");
    expect(result.reason).not.toBe("owner_gate_step_4_compare");
  });

  it.each([
    "1.9 với 2.9 khác gì?",
    "Basic với Premium khác nhau sao?",
    "Premium với Luxury khác gì?",
    "1.9 với 3.9 khác nhiều không?",
    "2.9 với 5.9 khác gì?",
    "Gói thấp nhất với gói cao nhất khác gì?",
    "Gói nào đáng tiền?",
    "Em chỉ cần một cổng.",
    "Em cần hai cổng.",
    "Em muốn mica.",
    "Có cần lên Luxury không?",
    "Master có đáng không?",
    "Thêm 1 triệu được gì?",
    "Basic vẫn ổn chứ?",
    "Em tối đa 4 triệu.",
    "Em ưu tiên sản phẩm.",
    "Em ưu tiên ekip.",
    "Gói càng cao hơn ở đâu?",
    "Basic hay Premium?",
    "Chị đọc bảng mà không hiểu.",
  ])("routes Step 4 comparison coverage: %s", (message) => {
    const result = decide(message, pricedGate);
    expect(result.stage).toBe("EXPLAIN_PACKAGES");
    expect(result.reason).toBe("owner_gate_step_4_compare");
  });

  it.each([
    ["Giá Premium bao nhiêu?", "SEND_PRICE_SHEET"],
    ["Premium mắc quá.", "owner_gate_step_6_objection"],
    ["Premium có khuyến mãi không?", "owner_gate_step_5_promotion"],
    ["Chị lấy Premium.", "owner_gate_step_7_decision"],
  ])("keeps Step 4 boundary owner for %s", (message, expected) => {
    const result = decide(message, pricedGate);
    expect(result.action === expected || result.reason === expected).toBe(true);
  });

  it.each([
    "Mắc quá em.",
    "Ngân sách chị không tới.",
    "Có gói nào rẻ hơn không?",
    "Bớt được không em?",
    "Chỗ khác rẻ hơn.",
    "Chị đang tham khảo studio khác.",
    "Để chị suy nghĩ.",
    "Để hỏi chồng.",
    "Để hỏi gia đình.",
    "Em chưa muốn cọc.",
    "Giờ em chưa đủ tiền cọc.",
    "Em sợ phát sinh.",
    "Em sợ chụp không đẹp.",
    "Em mập, chụp chắc không đẹp.",
    "Chồng chị không thích chụp.",
    "Chị bận quá, không có thời gian.",
    "Chị chưa chốt ngày cưới.",
    "Premium dư quyền lợi, chị không dùng hết.",
    "Bỏ bớt món rồi giảm giá được không?",
    "Em sợ ảnh không giống mẫu.",
    "Có chỉnh hình đẹp không?",
    "Không biết gói này có đáng tiền không.",
    "Cho chị vài ngày suy nghĩ.",
    "Chị chọn studio khác rồi.",
  ])("routes Step 6 objection coverage: %s", (message) => {
    const result = decide(message, pricedGate);
    expect(result.stage).toBe("RECOMMEND_PACKAGE");
    expect(result.reason).toBe("owner_gate_step_6_objection");
  });

  it("keeps the Step 3 → 4 → 6 → 7 owner sequence", () => {
    expect(decide("Premium bao nhiêu?", pricedGate).action).toBe("SEND_PRICE_SHEET");
    expect(decide("Basic với Premium khác gì?", pricedGate).reason).toBe("owner_gate_step_4_compare");
    expect(decide("Nhưng 3.9 cao quá.", pricedGate).reason).toBe("owner_gate_step_6_objection");
    expect(decide("Vậy chị lấy Basic.", pricedGate).reason).toBe("owner_gate_step_7_decision");
  });

  it("keeps promotion in Step 5 before routing a later price objection to Step 6", () => {
    expect(decide("Có khuyến mãi không?", pricedGate).reason).toBe("owner_gate_step_5_promotion");
    expect(decide("Không có giảm thêm hả, chị thấy hơi cao.", pricedGate).reason).toBe("owner_gate_step_6_objection");
  });
});

describe("album discovery", () => {
  it("does not reuse discovery slots after a service switch", () => {
    const result = decide("Chị muốn chụp album studio.", [
      { direction: "incoming", message: "Chị hỏi chụp cổng." },
      { direction: "incoming", message: "Chị thích nhẹ nhàng." },
      { direction: "outgoing", message: "Em gửi mẫu cổng nha." },
    ]);
    expect(result.serviceKey).toBe("album_studio");
    expect(result.nextSlot?.key).toBe("style");
    expect(result.action).toBe("ASK_DISCOVERY");
  });

  it("sends Album Studio samples after style and never quotes immediately", () => {
    const first = decide("Chị muốn chụp album studio.");
    expect(first.serviceKey).toBe("album_studio");
    expect(first.nextSlot?.key).toBe("style");

    const styled = decide("Chị thích sang trọng.", [
      { direction: "incoming", message: "Chị muốn chụp album studio." },
      { direction: "outgoing", message: "Chị thích phong cách nào ạ?" },
    ]);
    expect(styled.action).toBe("SEND_SAMPLE");
  });

  it("asks only verified Tay Ninh outdoor scenery", () => {
    const first = decide("Chị muốn chụp album ngoại cảnh.");
    expect(first.nextSlot?.key).toBe("location_need");

    const outside = decide("Chị muốn chụp ở Vũng Tàu.", [
      { direction: "incoming", message: "Chị muốn chụp album ngoại cảnh." },
    ]);
    expect(outside.nextSlot?.key).toBe("location_need");

    const local = decide("Chị thích cảnh ven Núi Bà Đen, phong cách tự nhiên.", [
      { direction: "incoming", message: "Chị muốn chụp album ngoại cảnh." },
    ]);
    expect(local.missingSlots).toHaveLength(0);
    expect(local.action).toBe("SEND_SAMPLE");
  });

  it("disambiguates generic wedding album before continuing", () => {
    const result = decide("Chị muốn chụp album cưới.");
    expect(result.serviceKey).toBe("wedding_album");
    expect(result.nextSlot?.key).toBe("album_location_type");
  });
});

describe("beauty and maternity discovery", () => {
  it("identifies birthday beauty and asks tone before samples", () => {
    const result = decide("Chị muốn chụp beauty sinh nhật.");
    expect(result.serviceKey).toBe("beauty");
    expect(result.filledSlots.find((slot) => slot.key === "beauty_type")?.value).toBe("birthday");
    expect(result.nextSlot?.key).toBe("style");
  });

  it("keeps the birthday subtype when the next reply only gives a luxury tone", () => {
    const result = decide("Tone sang trong, luxury.", [
      { direction: "incoming", message: "Ch\u1ecb mu\u1ed1n ch\u1ee5p beauty sinh nh\u1eadt." },
      { direction: "outgoing", message: "Ch\u1ecb th\u00edch tone n\u00e0o \u1ea1?" },
    ]);
    expect(result.filledSlots.find((slot) => slot.key === "beauty_type")?.value).toBe("birthday");
    expect(result.action).toBe("SEND_SAMPLE");
  });

  it("routes pregnancy separately and never keeps the generic beauty branch", () => {
    const result = decide("Chị đang mang thai muốn chụp beauty bầu.");
    expect(result.serviceKey).toBe("maternity");
    expect(result.nextSlot?.key).toBe("pregnancy_month");
  });
  it("keeps the supplied pregnancy month and family participants without asking again", () => {
    const result = decide("Em dang mang thai 7 thang, muon chup cung gia dinh, phong cach nhe nhang.");
    expect(result.serviceKey).toBe("maternity");
    expect(result.filledSlots.find((slot) => slot.key === "participants")?.value).toContain("cung gia dinh");
    expect(result.action).toBe("SEND_SAMPLE");
  });
});

describe("wedding party workflow", () => {
  const start: Turn[] = [
    { direction: "incoming", message: "Chị muốn thuê bên em chụp tiệc cưới." },
    { direction: "outgoing", message: "Chị cho em xin ngày cưới theo ngày Tây nha." },
  ];

  it("collects date, two locations, venue format and table count in order", () => {
    const afterDate = decide("Ngày 20/10/2026 nha em.", start);
    expect(afterDate.nextSlot?.key).toBe("bride_location");

    const afterLocations = decide("Nhà cô dâu ở Q1, nhà chú rể ở Q7.", [
      ...start,
      { direction: "incoming", message: "Ngày 20/10/2026 nha em." },
    ]);
    expect(afterLocations.nextSlot?.key).toBe("venue_format");
  });

  it("quotes after complete discovery without forcing a portfolio sample", () => {
    const result = decide("Chụp tiệc cưới ngày 20/10/2026, nhà cô dâu ở Q1, nhà chú rể ở Q7, chỉ làm nhà hàng khoảng 35 bàn.");
    expect(result.missingSlots).toHaveLength(0);
    expect(result.sampleRequired).toBe(false);
    expect(result.action).toBe("SEND_PRICE_SHEET");
  });
});
