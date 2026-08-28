import type { SaleSlot, SaleWorkflowDecision } from "./sale-workflow";
import type { SaleScriptQuestionAnswerRow } from "./sale-script-drafts";

export const WEDDING_GATE_SCRIPT_KEY = "SALE_WEDDING_GATE";
export const WEDDING_GATE_SCRIPT_VERSION = 1;

export type SaleScriptStatus = "draft" | "active" | "locked";

export type SaleScriptNode = {
  nodeKey: string;
  scriptKey: string;
  version: number;
  stepNumber: number;
  stage: string;
  title: string;
  replyTemplate: string;
  requiredSlots: string[];
  dataSources: string[];
  validators: string[];
  status: SaleScriptStatus;
};

export type LuluScriptState = {
  greeted: boolean;
  serviceIntent: string | null;
  serviceType: string | null;
  serviceCandidates: string[];
  askedServiceQuestion: boolean;
  currentScriptGroup: string | null;
  currentStep: number;
  lastUserIntent: string | null;
  completedCommonSteps: string[];
  pendingQuestion: string | null;
  slots: Record<string, string | null>;
  sampleSent: boolean;
  priceSheetSent: boolean;
  humanHandoff: boolean;
  selectedPackageName: string | null;
  decisionStatus: "NONE" | "TENTATIVE" | "CONFIRMED";
  bookingReady: boolean | null;
  recommendedPackageName: string | null;
  recommendationReason: string | null;
  bookingPhone: string | null;
  bookingCustomerName: string | null;
  requestedDates: string[];
  dateUncertain: boolean;
};

export type LuluResponseTrace = {
  status: "MAPPED" | "UNMAPPED_RESPONSE";
  scriptKey: string;
  routeKey: string | null;
  scriptVersion: number;
  nodeKey: string;
  stepNumber: number;
  stage: string;
  originalTemplate: string;
  renderedText: string;
  variables: Record<string, string | number | boolean | null | string[]>;
  dataSources: string[];
  assetIds: string[];
  priceSnapshot: Array<{ packageId: number; price: number; finalPrice: number }>;
  validatorResults: Array<{ name: string; passed: boolean; detail?: string }>;
  stateBefore: LuluScriptState;
  stateAfter: LuluScriptState;
  decisionRule: string;
  matchedIntent: string | null;
  matchedQuestionAnswerId: string | null;
  responseSource: "STRUCTURAL_FALLBACK" | "SALE_SCRIPT_DRAFT_ROW";
  aiParaphrase: { used: false; changes: [] };
};

export type ScriptCatalogItem = {
  serviceKey: string;
  serviceGroupName: string;
  scriptKey: string;
  version: number;
  status: SaleScriptStatus;
  active: boolean;
  nodes: SaleScriptNode[];
};

export type SaleScriptNodeOverrides = Record<string, Partial<Pick<SaleScriptNode, "title" | "replyTemplate">>>;
export type SaleScriptQuestionAnswerSheets = Record<string, SaleScriptQuestionAnswerRow[]>;

export type CommonServiceRoute = {
  serviceKey: string;
  serviceType: string;
  label: string;
  routeKey: string;
};

export const COMMON_SERVICE_ROUTES: CommonServiceRoute[] = [
  { serviceKey: "wedding_gate", serviceType: "WEDDING_GATE", label: "Chụp cổng tại studio", routeKey: "SALE_WEDDING_GATE" },
  { serviceKey: "album_outdoor", serviceType: "OUTDOOR_ALBUM", label: "Album cưới ngoại cảnh", routeKey: "SALE_OUTDOOR_ALBUM" },
  { serviceKey: "album_studio", serviceType: "STUDIO_ALBUM", label: "Album cưới tại studio", routeKey: "SALE_STUDIO_ALBUM" },
  { serviceKey: "wedding_party", serviceType: "WEDDING_DAY", label: "Chụp ngày cưới / chụp tiệc", routeKey: "SALE_WEDDING_DAY" },
  { serviceKey: "beauty", serviceType: "BEAUTY", label: "Beauty / thời trang / nàng thơ", routeKey: "SALE_BEAUTY" },
  { serviceKey: "family", serviceType: "FAMILY", label: "Chụp gia đình", routeKey: "SALE_FAMILY" },
  { serviceKey: "maternity", serviceType: "MATERNITY", label: "Chụp bầu", routeKey: "SALE_MATERNITY" },
  { serviceKey: "baby", serviceType: "BABY", label: "Chụp em bé", routeKey: "SALE_BABY" },
  { serviceKey: "rental_wedding_dress", serviceType: "RENTAL_WEDDING_DRESS", label: "Thuê váy cưới", routeKey: "SALE_RENTAL_WEDDING_DRESS" },
  { serviceKey: "rental_aodai", serviceType: "RENTAL_AODAI", label: "Thuê áo dài / Việt phục", routeKey: "SALE_RENTAL_AODAI" },
  { serviceKey: "rental_suit", serviceType: "RENTAL_SUIT", label: "Thuê vest", routeKey: "SALE_RENTAL_SUIT" },
  { serviceKey: "rental_other", serviceType: "RENTAL_OTHER", label: "Trang phục lễ và nhóm cho thuê khác", routeKey: "SALE_RENTAL_OTHER" },
];

const WEDDING_GATE_NODES: SaleScriptNode[] = [
  {
    nodeKey: "WEDDING_GATE.DISCOVERY.CONFIRM_SERVICE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 1,
    stage: "DISCOVERY",
    title: "Xac nhan dich vu chup cong",
    replyTemplate: "Dạ có mình nha. Bên em có chụp cổng tại studio với nhiều gói khác nhau. Mình dự định chụp một cổng hay hai cổng ạ?",
    requiredSlots: [],
    dataSources: ["service_key:wedding_gate"],
    validators: ["service_key_is_wedding_gate", "single_question"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.DISCOVERY.EXPLAIN_PENDING",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 1,
    stage: "DISCOVERY",
    title: "Giai thich cau hoi dang cho",
    replyTemplate: "Dạ, em đang hỏi {{PENDING_QUESTION}} để chọn mẫu và gói sát nhu cầu của mình hơn. Mình dự định chụp một cổng hay hai cổng ạ?",
    requiredSlots: [],
    dataSources: ["conversation_state.pending_question"],
    validators: ["pending_question_exists", "no_sample_action"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.DISCOVERY.CAPTURE_STYLE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 1,
    stage: "DISCOVERY",
    title: "Ghi nhan phong cach",
    replyTemplate: "Dạ phong cách {{STYLE}} chụp cổng sẽ sang và lâu lỗi thời đó mình. Em ghi nhận gu này rồi nha. Mình dự định chụp một cổng hay hai cổng để em chọn mẫu phù hợp ạ?",
    requiredSlots: ["style"],
    dataSources: ["conversation_state.style"],
    validators: ["style_captured_this_turn", "single_question", "no_repeat_style_question"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.DISCOVERY.COLLECT_NEXT_SLOT",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 1,
    stage: "DISCOVERY",
    title: "Hoi mot thong tin con thieu",
    replyTemplate: "{{NEXT_QUESTION}}",
    requiredSlots: [],
    dataSources: ["conversation_state.pending_question"],
    validators: ["single_question", "slot_not_previously_answered"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.SAMPLE.SEND_MATCHED",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 2,
    stage: "SEND_SAMPLE",
    title: "Gui mau chup cong dung nhom",
    replyTemplate: "Dạ em gửi mình vài mẫu chụp cổng theo hướng {{STYLE}} để mình tham khảo nha. Mình thấy hướng nào hợp gu nhất thì nói em, em sẽ dựa vào đó để chọn gói phù hợp cho mình.",
    requiredSlots: ["service_intent"],
    dataSources: ["image_store:wedding_gate", "conversation_state.sent_assets"],
    validators: ["service_key_is_wedding_gate", "sample_asset_not_previously_sent", "not_price_request"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.SAMPLE.ASK_CONFIRMATION",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 2,
    stage: "WAIT_SAMPLE_CONFIRMATION",
    title: "Hoi cam nhan sau khi gui mau",
    replyTemplate: "Dạ mình thấy các mẫu em vừa gửi có hợp gu không ạ? Mình ưng hướng nào thì nói em, em dựa vào đó tư vấn gói phù hợp cho mình nha.",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state.sent_assets"],
    validators: ["sample_already_sent", "single_question", "no_duplicate_sample"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.PRICING.SEND_RETAIL_PRICE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 3,
    stage: "SEND_PRICE_SHEET",
    title: "Gui bang gia le chinh thuc",
    replyTemplate: "Dạ em gửi mình bảng giá chụp cổng hiện tại nha. Bên em đang có các gói dành cho khách lẻ: {{RETAIL_PACKAGE_LIST}}. Mình cần một cổng hay hai cổng để em chọn giúp mình gói vừa đủ nhất nha?",
    requiredSlots: ["service_intent"],
    dataSources: ["service_groups", "service_packages", "service_groups.ai_image_url"],
    validators: ["official_price_asset", "asset_group_matches_service", "public_for_customer", "retail_packages_only", "image_before_text"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.PROMOTION.CHECK_ELIGIBILITY",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 5,
    stage: "PROMOTION",
    title: "Kiem tra uu dai hien hanh",
    replyTemplate: "Dạ bên em có chương trình quà riêng cho dâu rể từ 2 dịch vụ cưới trở lên nha 😄 Mình nói em các hạng mục đang tính làm, em kiểm tra đúng mốc cho mình luôn ạ.",
    requiredSlots: ["service_intent"],
    dataSources: ["wedding_gift_programs", "service_groups.discount_*", "service_packages.discount_*"],
    validators: ["promotion_is_current", "service_is_eligible"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.CLOSING.START_BOOKING",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 8,
    stage: "CLOSE_OR_HANDOFF",
    title: "Chuyen sang buoc xac nhan booking",
    replyTemplate: "Dạ em chuyển qua phần xác nhận thông tin và kiểm tra lịch cho mình nha.",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state"],
    validators: ["no_booking_creation", "no_payment_mutation", "no_deposit_mutation"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.CLOSING.COLLECT_MISSING",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 8,
    stage: "CLOSE_OR_HANDOFF",
    title: "Thu tung thong tin con thieu",
    replyTemplate: "Dạ em ghi nhận rồi nha. Em xin thêm đúng một thông tin còn thiếu để nhân viên kiểm tra lịch cho mình ạ.",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state"],
    validators: ["single_question", "no_booking_creation", "no_availability_claim", "no_payment_mutation"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.CLOSING.HUMAN_HANDOFF",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 8,
    stage: "HUMAN_HANDOFF",
    title: "Tom tat va chuyen nhan vien",
    replyTemplate: "Dạ em đã ghi nhận đủ phần mình cung cấp. Em chuyển nhân viên phụ trách kiểm tra và xác nhận lại với mình nha.",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state", "sale_calendar_read_only", "existing_human_handoff"],
    validators: ["human_handoff", "no_booking_creation", "no_availability_claim", "no_payment_mutation", "no_deposit_mutation"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.COMPARE.PACKAGES",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 4,
    stage: "EXPLAIN_PACKAGES",
    title: "So sanh goi theo quyen loi that",
    replyTemplate: "Dạ mình đang cân nhắc hai gói nào ạ? Em đối chiếu ngắn gọn giá và quyền lợi để mình dễ chọn nha.",
    requiredSlots: ["service_intent"],
    dataSources: ["service_packages", "pricing_snapshot"],
    validators: ["not_owned_by_price_step", "verified_package_data_only"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.OBJECTION.PRICE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 6,
    stage: "RECOMMEND_PACKAGE",
    title: "Xu ly khi khach thay gia cao",
    replyTemplate: "Dạ em hiểu phần ngân sách của mình. Em sẽ lùi về gói vừa nhu cầu nhất và giữ đúng các quyền lợi mình cần, không cố đẩy mình lên gói cao nha.",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state", "service_packages"],
    validators: ["not_owned_by_price_step", "no_pressure_sale"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.DECISION.RECOMMEND_PACKAGE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 7,
    stage: "RECOMMEND_PACKAGE",
    title: "De xuat mot goi theo context",
    replyTemplate: "Dạ em dựa đúng nhu cầu mình đã nói để chọn một gói phù hợp nhất nha. Nếu mình thấy ổn thì em chuyển qua kiểm tra lịch cho mình ạ?",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state", "service_packages"],
    validators: ["one_primary_recommendation", "verified_package_data_only", "no_booking_creation", "no_pressure_sale"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.DECISION.PACKAGE_SELECTED",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 8,
    stage: "CLOSE_OR_HANDOFF",
    title: "Ghi nhan goi khach da chon",
    replyTemplate: "Dạ em ghi nhận gói mình chọn rồi nha. Mình cho em xin thông tin liên hệ và ngày dự kiến để bên em kiểm tra lịch giúp mình ạ.",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state", "service_packages"],
    validators: ["package_named_by_customer", "no_repeat_price_sheet"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.CLOSING.CONFIRM_PACKAGE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 8,
    stage: "CLOSE_OR_HANDOFF",
    title: "Xac nhan goi truoc khi chuyen nhan vien",
    replyTemplate: "Dạ, em đã có phần thông tin mình vừa chọn. Mình dự định chụp một cổng hay hai cổng để em đề xuất đúng gói và kiểm tra lịch trước ạ?",
    requiredSlots: ["service_intent"],
    dataSources: ["conversation_state", "service_packages"],
    validators: ["single_question", "no_booking_confirmation"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.CLOSING.COLLECT_PHONE",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 8,
    stage: "CLOSE_OR_HANDOFF",
    title: "Nhan so dien thoai va chuyen nhan vien",
    replyTemplate: "Dạ em đã nhận thông tin của mình. Em chuyển nhân viên phụ trách kiểm tra lịch và liên hệ lại cho mình nha.",
    requiredSlots: ["phone"],
    dataSources: ["customer_message.phone"],
    validators: ["phone_detected", "human_handoff", "no_booking_confirmation"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.FOLLOW_UP.VIEWING_SAMPLES",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 9,
    stage: "FOLLOW_UP",
    title: "Follow-up khi dang xem mau",
    replyTemplate: "Dạ mình xem các mẫu hôm trước thấy hướng nào hợp nhất chưa ạ? Nếu mình thích kiểu tinh tế, em lọc thêm đúng phong cách đó cho mình nha.",
    requiredSlots: [],
    dataSources: ["conversation_state.sent_assets"],
    validators: ["manual_or_approved_scheduler_only", "not_opted_out", "not_human_handoff"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.FOLLOW_UP.COMPARE_PACKAGES",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 9,
    stage: "FOLLOW_UP",
    title: "Follow-up khi so sanh goi",
    replyTemplate: "Dạ giữa các gói mình đang phân vân điểm nào nhất ạ: giá, số lượng ảnh cổng hay phần trang phục và makeup? Mình nói em biết, em so sánh ngắn gọn cho dễ chọn nha.",
    requiredSlots: [],
    dataSources: ["pricing_snapshot"],
    validators: ["manual_or_approved_scheduler_only", "not_opted_out", "not_human_handoff"],
    status: "active",
  },
  {
    nodeKey: "WEDDING_GATE.FOLLOW_UP.ASK_FAMILY",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    stepNumber: 9,
    stage: "FOLLOW_UP",
    title: "Follow-up khi can hoi gia dinh",
    replyTemplate: "Dạ mình đã trao đổi với gia đình về gói chụp cổng chưa ạ? Nếu cần, em tóm tắt lại quyền lợi của gói để mình gửi người nhà xem cho dễ nha.",
    requiredSlots: [],
    dataSources: ["pricing_snapshot"],
    validators: ["manual_or_approved_scheduler_only", "not_opted_out", "not_human_handoff"],
    status: "active",
  },
];

const COMMON_NODES: SaleScriptNode[] = [
  {
    nodeKey: "COMMON.GREETING",
    scriptKey: "SALE_COMMON",
    version: 1,
    stepNumber: 1,
    stage: "GREETING",
    title: "Chào hỏi khách hàng",
    replyTemplate: "Dạ em chào mình ạ 😊 Mình đang quan tâm dịch vụ nào bên Amazing Studio để em hỗ trợ đúng nhu cầu cho mình nha?",
    requiredSlots: [],
    dataSources: [],
    validators: ["single_question", "no_repeat_greeting", "skip_when_service_known"],
    status: "active",
  },
  {
    nodeKey: "COMMON.SERVICE_ROUTING",
    scriptKey: "SALE_COMMON",
    version: 1,
    stepNumber: 1,
    stage: "IDENTIFY_SERVICE",
    title: "Phân loại dịch vụ",
    replyTemplate: "Dạ mình đang quan tâm chụp cổng, album cưới, chụp tiệc, beauty, gia đình, bầu, em bé hay thuê trang phục ạ?",
    requiredSlots: [],
    dataSources: ["conversation_state.service_candidates"],
    validators: ["single_question", "ask_service_once", "no_discovery_question"],
    status: "active",
  },
  {
    nodeKey: "COMMON.SERVICE_ROUTING.WEDDING_CLARIFY",
    scriptKey: "SALE_COMMON",
    version: 1,
    stepNumber: 1,
    stage: "IDENTIFY_SERVICE",
    title: "Làm rõ nhóm chụp cưới",
    replyTemplate: "Dạ mình muốn chụp ảnh cổng, album tại studio hay album ngoại cảnh ạ?",
    requiredSlots: [],
    dataSources: ["conversation_state.service_candidates"],
    validators: ["single_question", "ask_service_once", "no_random_route"],
    status: "active",
  },
  {
    nodeKey: "COMMON.SERVICE_ROUTING.MATCHED",
    scriptKey: "SALE_COMMON",
    version: 1,
    stepNumber: 1,
    stage: "IDENTIFY_SERVICE",
    title: "Chuyển sang kịch bản dịch vụ",
    replyTemplate: "Dạ được mình nha 😊 Mình đang quan tâm {{SERVICE_NAME}} đúng không ạ? Mình cho em xin thêm nhu cầu cụ thể để em tư vấn sát hơn nha.",
    requiredSlots: ["service_type"],
    dataSources: ["conversation_state.service_type", "conversation_state.current_script_group"],
    validators: ["service_route_exists", "no_repeat_service_question", "preserve_customer_context"],
    status: "active",
  },
  {
    nodeKey: "COMMON.HANDOFF.UNMAPPED_REQUEST",
    scriptKey: "SALE_COMMON",
    version: 1,
    stepNumber: 6,
    stage: "HUMAN_HANDOFF",
    title: "Chuyen nhan vien khi khong co node",
    replyTemplate: "Dạ trường hợp này em chuyển nhân viên phụ trách tư vấn kỹ hơn cho mình nha.",
    requiredSlots: [],
    dataSources: [],
    validators: ["no_free_form_reply", "human_handoff"],
    status: "active",
  },
];

export const LULU_SCRIPT_NODES = [...COMMON_NODES, ...WEDDING_GATE_NODES];

const DRAFT_SERVICES: Array<{ serviceKey: string; serviceGroupName: string; scriptKey: string }> = [
  { serviceKey: "studio_album", serviceGroupName: "Album tại studio", scriptKey: "SALE_STUDIO_ALBUM" },
  { serviceKey: "album_outdoor", serviceGroupName: "Album ngoại cảnh", scriptKey: "SALE_OUTDOOR_ALBUM" },
  { serviceKey: "wedding_party", serviceGroupName: "Chụp tiệc cưới", scriptKey: "SALE_WEDDING_DAY" },
  { serviceKey: "beauty", serviceGroupName: "Beauty/Thời trang", scriptKey: "SALE_BEAUTY" },
  { serviceKey: "makeup_combo", serviceGroupName: "Combo có makeup", scriptKey: "SALE_MAKEUP_COMBO" },
  { serviceKey: "wedding_outfit_combo", serviceGroupName: "Combo trang phục cưới", scriptKey: "SALE_WEDDING_OUTFIT_COMBO" },
];

export function getScriptCatalog(extraGroups: Array<{ id: number; name: string }> = []): ScriptCatalogItem[] {
  const known = new Set<string>();
  const active: ScriptCatalogItem = {
    serviceKey: "wedding_gate",
    serviceGroupName: "Chụp cổng tại studio",
    scriptKey: WEDDING_GATE_SCRIPT_KEY,
    version: WEDDING_GATE_SCRIPT_VERSION,
    status: "active",
    active: true,
    // The greeting is shared by every service, but it is the first operational
    // step of the wedding-gate journey and must be visible with its script.
    nodes: [...COMMON_NODES.filter((item) => item.nodeKey === "COMMON.GREETING"), ...WEDDING_GATE_NODES],
  };
  known.add(normalize(active.serviceGroupName));
  const drafts = DRAFT_SERVICES.map((service) => {
    known.add(normalize(service.serviceGroupName));
    return { ...service, version: 1, status: "draft" as const, active: false, nodes: [] };
  });
  const databaseOnly = extraGroups
    .filter((group) => !known.has(normalize(group.name)))
    .map((group) => ({
      serviceKey: `group_${group.id}`,
      serviceGroupName: group.name,
      scriptKey: `SALE_GROUP_${group.id}`,
      version: 1,
      status: "draft" as const,
      active: false,
      nodes: [],
    }));
  return [active, ...drafts, ...databaseOnly];
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const COMMON_ROUTE_PATTERNS: Array<{ serviceKey: string; re: RegExp }> = [
  { serviceKey: "wedding_gate", re: /\b(chup cong|cong cuoi|hinh cong|anh cong)\b/ },
  { serviceKey: "album_outdoor", re: /\b(album ngoai canh|ngoai canh cuoi|chup cuoi ngoai canh)\b/ },
  { serviceKey: "album_studio", re: /\b(album tai studio|album studio|chup cuoi studio)\b/ },
  { serviceKey: "wedding_party", re: /\b(chup ngay cuoi|chup tiec|tiec cuoi|phong su cuoi|dai tiec)\b/ },
  { serviceKey: "beauty", re: /\b(beauty|beaty|thoi trang|nang tho|chan dung|cool boy|cool girl)\b/ },
  { serviceKey: "family", re: /\b(chup gia dinh|anh gia dinh)\b/ },
  { serviceKey: "maternity", re: /\b(chup bau|me bau|mang thai|thai ky|maternity)\b/ },
  { serviceKey: "baby", re: /\b(chup em be|chup be|em be|baby|so sinh|newborn)\b/ },
  { serviceKey: "rental_wedding_dress", re: /\b(thue vay cuoi|thue vay co dau|vay cuoi)\b/ },
  { serviceKey: "rental_aodai", re: /\b(thue ao dai|ao dai|viet phuc|co phuc)\b/ },
  { serviceKey: "rental_suit", re: /\b(thue vest|thue suit|vest cuoi|suit cuoi)\b/ },
  { serviceKey: "rental_other", re: /\b(thue trang phuc|cho thue trang phuc|thue do|trang phuc le)\b/ },
];

function uniqueRoutes(routes: CommonServiceRoute[]): CommonServiceRoute[] {
  return routes.filter(
    (route, index) => routes.findIndex((item) => item.serviceKey === route.serviceKey) === index,
  );
}

export function commonServiceRoute(serviceKey: string | null | undefined): CommonServiceRoute | null {
  if (!serviceKey) return null;
  const aliases: Record<string, string> = {
    studio_album: "album_studio",
    rental_outfit: "rental_other",
  };
  const resolvedKey = aliases[serviceKey] ?? serviceKey;
  return COMMON_SERVICE_ROUTES.find((route) => route.serviceKey === resolvedKey) ?? null;
}

export function resolveCommonServiceRouting(
  message: string,
  fallbackServiceKey?: string | null,
): {
  selected: CommonServiceRoute | null;
  candidates: CommonServiceRoute[];
  confidence: number;
  reason: "matched" | "multiple_services" | "generic_wedding" | "unknown";
} {
  const text = normalize(message);
  let candidates = uniqueRoutes(
    COMMON_ROUTE_PATTERNS.filter((entry) => entry.re.test(text))
      .map((entry) => commonServiceRoute(entry.serviceKey))
      .filter((route): route is CommonServiceRoute => Boolean(route)),
  );
  if (candidates.some((route) => route.serviceKey.startsWith("rental_") && route.serviceKey !== "rental_other")) {
    candidates = candidates.filter((route) => route.serviceKey !== "rental_other");
  }
  if (candidates.length > 1) {
    return { selected: null, candidates, confidence: 0.62, reason: "multiple_services" };
  }
  if (candidates.length === 1) {
    return { selected: candidates[0], candidates, confidence: 0.98, reason: "matched" };
  }
  if (/\b(chup hinh cuoi|chup anh cuoi|chup cuoi|album cuoi|anh cuoi)\b/.test(text)) {
    const weddingCandidates = ["wedding_gate", "album_studio", "album_outdoor"]
      .map((key) => commonServiceRoute(key))
      .filter((route): route is CommonServiceRoute => Boolean(route));
    return { selected: null, candidates: weddingCandidates, confidence: 0.55, reason: "generic_wedding" };
  }
  const fallback = commonServiceRoute(fallbackServiceKey);
  if (fallback) return { selected: fallback, candidates: [fallback], confidence: 0.86, reason: "matched" };
  return { selected: null, candidates: [], confidence: 0.25, reason: "unknown" };
}

function matchableText(value: string): string {
  return normalize(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singleQuestionAnswerScore(message: string, question: string): number {
  const normalizedMessage = matchableText(message);
  const normalizedQuestion = matchableText(question);
  if (!normalizedMessage || !normalizedQuestion) return 0;
  if (normalizedMessage === normalizedQuestion) return 1;
  if (` ${normalizedMessage} `.includes(` ${normalizedQuestion} `)) return 0.94;

  const messageTokens = normalizedMessage.split(" ");
  const questionTokens = Array.from(new Set(normalizedQuestion.split(" ")));
  const messageTokenSet = new Set(messageTokens);
  const shared = questionTokens.filter((token) => messageTokenSet.has(token)).length;
  if (shared === 0) return 0;

  const questionCoverage = shared / questionTokens.length;
  const messageCoverage = shared / new Set(messageTokens).size;
  const inOrder = questionTokens.every((token, index) => {
    const messageIndex = messageTokens.indexOf(token);
    return messageIndex >= 0 && (index === 0 || messageIndex > messageTokens.indexOf(questionTokens[index - 1]));
  });
  if (questionTokens.length === 1 && questionCoverage === 1) {
    return messageTokens.length <= 3 ? 0.84 : 0.68;
  }
  return Math.min(0.93, questionCoverage * 0.72 + messageCoverage * 0.23 + (inOrder ? 0.05 : 0));
}

function questionAnswerScore(message: string, question: string): number {
  // Admin thường gom các cách nói đồng nghĩa trong một ô Excel bằng dấu “/”.
  // Mỗi vế là một utterance của cùng intent, không phải một câu dài bắt khách
  // phải nói đủ toàn bộ nội dung trong ô.
  const variants = question
    .split(/\s*(?:\/|\||\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Math.max(0, ...variants.map((variant) => singleQuestionAnswerScore(message, variant)));
}

function bestQuestionAnswerMatch(
  message: string,
  rows: SaleScriptQuestionAnswerRow[],
): { row: SaleScriptQuestionAnswerRow; score: number } | null {
  let best: { row: SaleScriptQuestionAnswerRow; score: number } | null = null;
  for (const row of rows) {
    if (!row.question.trim() || !row.answer.trim()) continue;
    const score = questionAnswerScore(message, row.question);
    if (!best || score > best.score) best = { row, score };
  }
  return best && best.score >= 0.8 ? best : null;
}

function isRoutingQuestionAnswerRow(row: SaleScriptQuestionAnswerRow): boolean {
  if (row.serviceKey || row.routeKey) return true;
  const routing = resolveCommonServiceRouting(row.question);
  if (routing.reason !== "unknown") return true;
  return /\b(dich vu gi|co dich vu|quan tam dich vu|thue do|thue trang phuc)\b/.test(matchableText(row.question));
}

function commonQuestionAnswerRows(
  sheets: SaleScriptQuestionAnswerSheets | undefined,
  sheetKey: "COMMON.GREETING" | "COMMON.SERVICE_ROUTING",
): SaleScriptQuestionAnswerRow[] {
  if (!sheets) return [];
  const usable = (row: SaleScriptQuestionAnswerRow) =>
    sheetKey !== "COMMON.SERVICE_ROUTING" || Boolean(row.serviceKey && row.routeKey);
  const explicit = (sheets[sheetKey] ?? []).filter(usable);
  const legacy = (sheets.SALE_COMMON ?? []).filter((row) =>
    sheetKey === "COMMON.SERVICE_ROUTING"
      ? isRoutingQuestionAnswerRow(row)
      : !isRoutingQuestionAnswerRow(row),
  ).filter(usable);
  const usedIds = new Set(explicit.map((row) => row.id));
  return [...explicit, ...legacy.filter((row) => !usedIds.has(row.id))];
}

function routeForQuestionAnswerRow(row: SaleScriptQuestionAnswerRow): CommonServiceRoute | null {
  return commonServiceRoute(row.serviceKey)
    ?? COMMON_SERVICE_ROUTES.find((route) => route.routeKey === row.routeKey)
    ?? null;
}

function slotMap(slots: SaleSlot[]): Record<string, string | null> {
  return Object.fromEntries(slots.map((slot) => [slot.key, slot.value]));
}

function stepFor(workflow: SaleWorkflowDecision): number {
  if (!workflow.serviceKey) return 1;
  if (workflow.action === "SEND_SAMPLE" || workflow.action === "ASK_SAMPLE_CONFIRMATION") return 2;
  if (workflow.action === "SEND_PRICE_SHEET") return 3;
  if (workflow.reason === "owner_gate_step_3_package_detail") return 3;
  if (workflow.reason === "owner_gate_step_4_compare") return 4;
  if (workflow.reason === "owner_gate_step_5_promotion") return 5;
  if (workflow.reason === "owner_gate_step_6_objection") return 6;
  if (workflow.reason === "owner_gate_step_7_recommendation") return 7;
  if (workflow.reason === "owner_gate_step_7_unresolved_decision") return 7;
  if (workflow.reason === "owner_gate_step_8_booking" || workflow.stage === "CLOSE_OR_HANDOFF") return 8;
  if (workflow.stage === "FOLLOW_UP") return 9;
  return 1;
}

export function workflowToScriptState(workflow: SaleWorkflowDecision): LuluScriptState {
  const slots = slotMap(workflow.slots);
  const route = commonServiceRoute(workflow.serviceKey);
  const askedServiceQuestion = workflow.askedQuestionKeys.includes("service_type");
  return {
    greeted: workflow.greeted,
    serviceIntent: workflow.serviceKey,
    serviceType: route?.serviceType ?? null,
    serviceCandidates: route ? [route.serviceType] : [],
    askedServiceQuestion,
    currentScriptGroup: route?.routeKey ?? null,
    currentStep: stepFor(workflow),
    lastUserIntent: workflow.detectedIntent ?? workflow.requestedAction,
    completedCommonSteps: [
      ...(workflow.greeted ? ["COMMON.GREETING"] : []),
      ...(route ? ["COMMON.SERVICE_ROUTING"] : []),
    ],
    pendingQuestion: workflow.nextSlot?.key ?? null,
    slots,
    sampleSent: workflow.sampleSent,
    priceSheetSent: workflow.priceSheetSent,
    humanHandoff: false,
    selectedPackageName: workflow.packageDecision.packageHint,
    decisionStatus: workflow.packageDecision.status,
    bookingReady: workflow.packageDecision.bookingReady,
    recommendedPackageName: null,
    recommendationReason: null,
    bookingPhone: workflow.bookingLead.phone,
    bookingCustomerName: workflow.bookingLead.customerName,
    requestedDates: workflow.bookingLead.requestedDates,
    dateUncertain: workflow.bookingLead.dateUncertain,
  };
}

function packageLabel(hint: SaleWorkflowDecision["packageDecision"]["packageHint"]): string | null {
  if (hint === "SAVING") return "Tiết kiệm";
  if (hint === "BASIC") return "Basic";
  if (hint === "PREMIUM") return "Premium";
  if (hint === "LUXURY") return "Luxury";
  return null;
}

function decisionReply(workflow: SaleWorkflowDecision): string {
  const decision = workflow.packageDecision;
  const label = packageLabel(decision.packageHint);
  if (decision.resolution === "UNKNOWN_PRICE") {
    return "Dạ bảng Chụp cổng hiện không có đúng gói 4,5 triệu nha mình. Em kiểm tra lại các gói đang bán để mình chọn đúng, không tự ghép nhầm gói ạ.";
  }
  if (decision.resolution === "AMBIGUOUS_BENEFIT") {
    return "Dạ mình đang nói Premium hay Luxury ạ? Hai gói đều có phương án 2 cổng mica nên em xác nhận đúng gói cho mình nha.";
  }
  if (decision.resolution === "SERVICE_ONLY") {
    return "Dạ mình chọn dịch vụ chụp cổng rồi nha 👍 Còn gói Tiết kiệm, Basic, Premium hay Luxury thì mình đang nghiêng gói nào để em ghi nhận đúng trước khi giữ lịch ạ?";
  }
  if (decision.status === "TENTATIVE") {
    return `Dạ hiện mình đang nghiêng ${label ?? "gói này"} nha. Em chưa tạo booking hay giữ lịch vội; khi mình xác nhận chắc thì em chuyển tiếp đúng lựa chọn này ạ.`;
  }
  if (decision.bookingReady === false) {
    return `Dạ em ghi nhận mình đã chọn ${label ?? "gói này"} nha. Phần booking em chưa làm vội theo ý mình; khi sẵn sàng em tiếp tục đúng từ lựa chọn này ạ.`;
  }
  return `Dạ ${label ?? "gói này"} nha mình 👍 Em ghi nhận đúng lựa chọn này, không đổi hay đẩy mình lên gói khác. Mình qua phần xác nhận thông tin và kiểm tra lịch nha.`;
}

function node(key: string, overrides?: SaleScriptNodeOverrides): SaleScriptNode {
  const found = LULU_SCRIPT_NODES.find((item) => item.nodeKey === key);
  if (!found) throw new Error(`Missing Lulu script node: ${key}`);
  const patch = overrides?.[key];
  return patch ? { ...found, ...patch } : found;
}

function isClarification(text: string): boolean {
  return /\b(nghia la sao|la sao|giai thich|y la sao)\b/.test(normalize(text));
}

function isPromotionRequest(text: string): boolean {
  return /\b(khuyen mai|uu dai|giam gia|qua tang|co qua|qua gi|moc may|moc nao|cong don|quy doi qua|doi qua.*tien)\b|\b[2345]\s*(?:dich vu|goi)\b.{0,24}\b(?:duoc gi|qua|tang)\b|\bbeauty\b.{0,24}\b(?:tinh|cong)\b/.test(normalize(text));
}

function nextQuestion(key: string | null): string {
  switch (key) {
    case "gate_count": return "Dạ mình dự định chụp một cổng hay hai cổng ạ?";
    case "wedding_date": return "Dạ mình đã có ngày chụp hoặc ngày cưới dự kiến chưa ạ?";
    case "style": return "Dạ mình thích chụp cổng theo phong cách nào để em chọn mẫu sát gu hơn ạ?";
    case "outfit_status": return "Dạ mình đã có trang phục chụp cổng chưa ạ?";
    case "makeup_need": return "Dạ mình có cần bên em hỗ trợ makeup cho buổi chụp không ạ?";
    case "priority": return "Dạ mình ưu tiên tiết kiệm hay muốn gói đầy đủ hơn để em tư vấn sát nhất ạ?";
    default: return "Dạ em chuyển nhân viên phụ trách tư vấn kỹ hơn cho mình nha.";
  }
}

function render(nodeKey: string, state: LuluScriptState, workflow: SaleWorkflowDecision): { text: string; variables: LuluResponseTrace["variables"] } {
  const style = state.slots.style ?? "tinh tế";
  switch (nodeKey) {
    case "COMMON.GREETING":
    case "COMMON.SERVICE_ROUTING":
    case "COMMON.SERVICE_ROUTING.WEDDING_CLARIFY":
      return { text: node(nodeKey).replyTemplate, variables: {} };
    case "COMMON.SERVICE_ROUTING.MATCHED":
      return {
        text: renderTemplate(node(nodeKey).replyTemplate, {
          SERVICE_NAME: state.serviceType ?? "dịch vụ phù hợp",
        }),
        variables: { SERVICE_NAME: state.serviceType ?? "dịch vụ phù hợp" },
      };
    case "WEDDING_GATE.DISCOVERY.CONFIRM_SERVICE":
      return { text: node(nodeKey).replyTemplate, variables: { SERVICE_NAME: "chụp cổng tại studio", DISCOVERY_QUESTION: "chụp một cổng hay hai cổng" } };
    case "WEDDING_GATE.DISCOVERY.EXPLAIN_PENDING":
      return {
        text: `Dạ, em đang hỏi ${nextQuestion(state.pendingQuestion).replace(/^Dạ\s*/i, "").replace(/\?$/, "").toLowerCase()} để chọn mẫu và gói sát nhu cầu của mình hơn. ${nextQuestion(state.pendingQuestion)}`,
        variables: { PENDING_QUESTION: state.pendingQuestion ?? "thông tin cần làm rõ" },
      };
    case "WEDDING_GATE.DISCOVERY.CAPTURE_STYLE":
      return {
        text: `Dạ phong cách ${style} chụp cổng sẽ sang và lâu lỗi thời đó mình. Em ghi nhận gu này rồi nha. ${nextQuestion("gate_count")}`,
        variables: { STYLE: style },
      };
    case "WEDDING_GATE.DISCOVERY.COLLECT_NEXT_SLOT":
      return { text: nextQuestion(state.pendingQuestion), variables: { NEXT_QUESTION: nextQuestion(state.pendingQuestion), PENDING_QUESTION: state.pendingQuestion } };
    case "WEDDING_GATE.SAMPLE.SEND_MATCHED":
      return {
        text: `Dạ em gửi mình vài mẫu chụp cổng theo hướng ${style} để mình tham khảo nha. Mình thấy hướng nào hợp gu nhất thì nói em, em sẽ dựa vào đó để chọn gói phù hợp cho mình.`,
        variables: { STYLE: style },
      };
    case "WEDDING_GATE.SAMPLE.ASK_CONFIRMATION":
      return { text: node(nodeKey).replyTemplate, variables: {} };
    case "WEDDING_GATE.PRICING.SEND_RETAIL_PRICE":
      return {
        text: "Dạ được ạ, em gửi mình thông tin và bảng giá chụp cổng nha.",
        variables: { RETAIL_PACKAGE_LIST: [] },
      };
    case "WEDDING_GATE.PROMOTION.CHECK_ELIGIBILITY":
      return {
        text: "Dạ phần ưu đãi em chỉ xác nhận sau khi kiểm tra chương trình đang hiệu lực và đúng điều kiện của gói mình chọn. Em chuyển nhân viên kiểm tra kỹ cho mình nha.",
        variables: { PROMOTION_REPLY: "chờ dữ liệu khuyến mãi được xác minh" },
      };
    case "WEDDING_GATE.CLOSING.CONFIRM_PACKAGE":
      return {
        text: "Dạ, em đã có phần thông tin mình vừa chọn. Mình dự định chụp một cổng hay hai cổng để em đề xuất đúng gói và kiểm tra lịch trước ạ?",
        variables: { GATE_COUNT: state.slots.gate_count },
      };
    case "WEDDING_GATE.CLOSING.COLLECT_PHONE":
      return { text: node(nodeKey).replyTemplate, variables: { PHONE: "provided" } };
    default:
      return { text: node("COMMON.HANDOFF.UNMAPPED_REQUEST").replyTemplate, variables: {} };
  }
}

function renderTemplate(template: string, variables: LuluResponseTrace["variables"]): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value);
  });
}

function makeTrace(input: {
  selected: SaleScriptNode;
  status?: LuluResponseTrace["status"];
  routeKey?: string | null;
  stateBefore: LuluScriptState;
  stateAfter: LuluScriptState;
  workflow: SaleWorkflowDecision;
  decisionRule: string;
  renderedText?: string;
  variables?: LuluResponseTrace["variables"];
}): LuluResponseTrace {
  const rendered = input.renderedText == null || input.variables == null
    ? (() => {
      const defaultRendered = render(input.selected.nodeKey, input.stateAfter, input.workflow);
      const base = LULU_SCRIPT_NODES.find((node) => node.nodeKey === input.selected.nodeKey);
      return base?.replyTemplate !== input.selected.replyTemplate
        ? { text: renderTemplate(input.selected.replyTemplate, defaultRendered.variables), variables: defaultRendered.variables }
        : defaultRendered;
    })()
    : { text: input.renderedText, variables: input.variables };
  return {
    status: input.status ?? "MAPPED",
    scriptKey: input.selected.scriptKey,
    routeKey: input.routeKey ?? (input.selected.scriptKey === "SALE_COMMON" ? null : input.selected.scriptKey),
    scriptVersion: input.selected.version,
    nodeKey: input.selected.nodeKey,
    stepNumber: input.selected.stepNumber,
    stage: input.selected.stage,
    originalTemplate: input.selected.replyTemplate,
    renderedText: rendered.text,
    variables: rendered.variables,
    dataSources: input.selected.dataSources,
    assetIds: [],
    priceSnapshot: [],
    validatorResults: input.selected.validators.map((name) => ({ name, passed: true })),
    stateBefore: input.stateBefore,
    stateAfter: input.stateAfter,
    decisionRule: input.decisionRule,
    matchedIntent: input.workflow.detectedIntent ?? input.workflow.reason ?? null,
    matchedQuestionAnswerId: null,
    responseSource: "STRUCTURAL_FALLBACK",
    aiParaphrase: { used: false, changes: [] },
  };
}

function renderDraftRowTemplate(template: string, trace: LuluResponseTrace): string {
  const variables: LuluResponseTrace["variables"] = {
    ...trace.variables,
    STYLE: trace.stateAfter.slots.style ?? trace.variables.STYLE ?? "phù hợp",
    PENDING_QUESTION: trace.stateAfter.pendingQuestion ?? trace.variables.PENDING_QUESTION,
    SELECTED_PACKAGE: trace.stateAfter.selectedPackageName ?? trace.variables.SELECTED_PACKAGE,
    RECOMMENDED_PACKAGE: trace.stateAfter.recommendedPackageName ?? trace.variables.RECOMMENDED_PACKAGE,
  };
  return renderTemplate(template, variables).trim();
}

/**
 * Bind câu trả lời Wedding Gate vào chính sheet SALE_WEDDING_GATE của version
 * đang test. Hàm này chỉ đọc dữ liệu draft đã được route truyền vào; không có
 * cache và không ghi DB. Các bước có renderer dữ liệu thật (ảnh/giá/so sánh/
 * khuyến mãi/recommendation) vẫn giữ renderer đó, nhưng trace luôn chỉ ra dòng
 * kịch bản nháp đã match thay vì giả vờ dùng một bộ câu hard-code khác.
 */
export function bindWeddingGateDraftRow(
  trace: LuluResponseTrace,
  message: string,
  sheets?: SaleScriptQuestionAnswerSheets,
): LuluResponseTrace {
  if (trace.scriptKey !== WEDDING_GATE_SCRIPT_KEY) return trace;
  const rows = (sheets?.[WEDDING_GATE_SCRIPT_KEY] ?? []).filter((row) => row.stepId === trace.stepNumber);
  const matched = bestQuestionAnswerMatch(message, rows);
  if (!matched) return trace;
  const renderedDraft = renderDraftRowTemplate(matched.row.answer, trace);
  const hasUnresolvedPlaceholder = /\{\{[A-Z0-9_]+\}\}/.test(renderedDraft);
  const dynamicStep = [2, 3, 4, 5, 7].includes(trace.stepNumber);
  return {
    ...trace,
    originalTemplate: matched.row.answer,
    renderedText: dynamicStep || hasUnresolvedPlaceholder ? trace.renderedText : renderedDraft,
    dataSources: Array.from(new Set([`sale_script_draft:${WEDDING_GATE_SCRIPT_KEY}`, ...trace.dataSources])),
    decisionRule: `${trace.decisionRule};draft_row_match:${matched.row.id}:${matched.score.toFixed(2)}`,
    matchedIntent: matched.row.routeKey ?? trace.nodeKey,
    matchedQuestionAnswerId: matched.row.id,
    responseSource: "SALE_SCRIPT_DRAFT_ROW",
    validatorResults: hasUnresolvedPlaceholder
      ? [...trace.validatorResults, { name: "draft_placeholder_resolved", passed: false, detail: "dynamic_renderer_required" }]
      : trace.validatorResults,
  };
}

export function preventRawPlaceholderLeak(trace: LuluResponseTrace): LuluResponseTrace {
  if (!/\{\{[A-Z0-9_]+\}\}/.test(trace.renderedText)) return trace;
  return {
    ...trace,
    renderedText: "Dạ phần này em chưa lấy đủ dữ liệu đã xác minh. Em chuyển nhân viên kiểm tra đúng thông tin cho mình nha.",
    stateAfter: { ...trace.stateAfter, humanHandoff: true },
    validatorResults: [...trace.validatorResults, { name: "no_raw_placeholder", passed: false, detail: "blocked_before_customer_output" }],
  };
}

export function selectSaleScriptResponse(input: {
  message: string;
  workflow: SaleWorkflowDecision;
  workflowBefore: SaleWorkflowDecision;
  overrides?: SaleScriptNodeOverrides;
  questionAnswerSheets?: SaleScriptQuestionAnswerSheets;
}): LuluResponseTrace {
  const before = workflowToScriptState(input.workflowBefore);
  const after = workflowToScriptState(input.workflow);
  const text = normalize(input.message);
  const routing = resolveCommonServiceRouting(input.message, input.workflow.serviceKey);
  const routingQuestionAnswer = bestQuestionAnswerMatch(
    input.message,
    commonQuestionAnswerRows(input.questionAnswerSheets, "COMMON.SERVICE_ROUTING"),
  );
  // A manually taught sentence is an explicit answer rule. Keep it available
  // even when conversation history already carries a service intent; otherwise
  // a stale intent (for example wedding_gate) can mask an exact greeting row.
  const greetingQuestionAnswer = bestQuestionAnswerMatch(
    input.message,
    commonQuestionAnswerRows(input.questionAnswerSheets, "COMMON.GREETING"),
  );

  if (routingQuestionAnswer) {
    const { row, score } = routingQuestionAnswer;
    const matchedRoute = routeForQuestionAnswerRow(row);
    if (matchedRoute) {
      return makeTrace({
        selected: node("COMMON.SERVICE_ROUTING.MATCHED", input.overrides),
        routeKey: matchedRoute.routeKey,
        stateBefore: before,
        stateAfter: {
          ...after,
          serviceIntent: matchedRoute.serviceKey,
          serviceType: matchedRoute.serviceType,
          serviceCandidates: [matchedRoute.serviceType],
          currentScriptGroup: matchedRoute.routeKey,
          completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.SERVICE_ROUTING"])),
        },
        workflow: input.workflow,
        decisionRule: `question_answer_route_match:${row.id}:${score.toFixed(2)}`,
        renderedText: row.answer,
        variables: { SERVICE_NAME: matchedRoute.label },
      });
    }
    if (row.routeKey === "COMMON.HANDOFF.UNMAPPED_REQUEST") {
      return makeTrace({
        selected: node("COMMON.HANDOFF.UNMAPPED_REQUEST", input.overrides),
        status: "UNMAPPED_RESPONSE",
        stateBefore: before,
        stateAfter: { ...after, humanHandoff: true },
        workflow: input.workflow,
        decisionRule: `question_answer_handoff_match:${row.id}:${score.toFixed(2)}`,
        renderedText: row.answer,
        variables: {},
      });
    }
    return makeTrace({
      selected: node("COMMON.SERVICE_ROUTING", input.overrides),
      stateBefore: before,
      stateAfter: {
        ...after,
        askedServiceQuestion: true,
        completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.SERVICE_ROUTING"])),
      },
      workflow: input.workflow,
      decisionRule: `question_answer_clarification_match:${row.id}:${score.toFixed(2)}`,
      renderedText: row.answer,
      variables: {},
    });
  }

  if (greetingQuestionAnswer) {
    const { row, score } = greetingQuestionAnswer;
    return makeTrace({
      selected: node("COMMON.GREETING", input.overrides),
      stateBefore: before,
      stateAfter: {
        ...after,
        greeted: true,
        askedServiceQuestion: true,
        completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.GREETING"])),
      },
      workflow: input.workflow,
      decisionRule: `question_answer_greeting_match:${row.id}:${score.toFixed(2)}`,
      renderedText: row.answer,
      variables: {},
    });
  }

  if (input.workflow.reason === "owner_gate_step_5_promotion" || isPromotionRequest(text)) {
    return makeTrace({
      selected: node("WEDDING_GATE.PROMOTION.CHECK_ELIGIBILITY", input.overrides),
      stateBefore: before,
      stateAfter: { ...after, currentStep: 5 },
      workflow: input.workflow,
      decisionRule: "promotion_question_owned_by_step_5",
    });
  }

  if (!routing.selected) {
    const serviceCandidates = routing.candidates.map((candidate) => candidate.serviceType);
    const alreadyAsked = before.askedServiceQuestion || input.workflow.askedQuestionKeys.includes("service_type");
    if (routing.reason === "generic_wedding" && !alreadyAsked) {
      return makeTrace({
        selected: node("COMMON.SERVICE_ROUTING.WEDDING_CLARIFY", input.overrides),
        stateBefore: before,
        stateAfter: {
          ...after,
          serviceCandidates,
          askedServiceQuestion: true,
          completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.SERVICE_ROUTING"])),
        },
        workflow: input.workflow,
        decisionRule: "generic_wedding_requires_one_clarification",
      });
    }
    if (routing.reason === "multiple_services" && !alreadyAsked) {
      return makeTrace({
        selected: node("COMMON.SERVICE_ROUTING", input.overrides),
        stateBefore: before,
        stateAfter: {
          ...after,
          serviceCandidates,
          askedServiceQuestion: true,
          completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.SERVICE_ROUTING"])),
        },
        workflow: input.workflow,
        decisionRule: "multiple_services_ask_which_to_view_first",
        renderedText: "Dạ mình đang quan tâm nhiều dịch vụ 😊 Mình muốn xem dịch vụ nào trước để em tư vấn kỹ cho mình nha?",
        variables: {},
      });
    }
    if (!input.workflow.greeted && !alreadyAsked) {
      return makeTrace({
        selected: node("COMMON.GREETING", input.overrides),
        stateBefore: before,
        stateAfter: {
          ...after,
          greeted: true,
          askedServiceQuestion: true,
          completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.GREETING"])),
        },
        workflow: input.workflow,
        decisionRule: "new_customer_without_service",
      });
    }
    if (!alreadyAsked) {
      return makeTrace({
        selected: node("COMMON.SERVICE_ROUTING", input.overrides),
        stateBefore: before,
        stateAfter: {
          ...after,
          serviceCandidates,
          askedServiceQuestion: true,
          completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.SERVICE_ROUTING"])),
        },
        workflow: input.workflow,
        decisionRule: "service_unknown_ask_once",
      });
    }
    const selected = node("COMMON.HANDOFF.UNMAPPED_REQUEST", input.overrides);
    return makeTrace({ selected, status: "UNMAPPED_RESPONSE", stateBefore: before, stateAfter: { ...after, serviceCandidates, humanHandoff: true }, workflow: input.workflow, decisionRule: "service_still_unknown_after_one_question" });
  }

  if (routing.selected.serviceKey !== "wedding_gate") {
    const selected = node("COMMON.SERVICE_ROUTING.MATCHED", input.overrides);
    const stateAfter: LuluScriptState = {
      ...after,
      serviceIntent: routing.selected.serviceKey,
      serviceType: routing.selected.serviceType,
      serviceCandidates: [routing.selected.serviceType],
      currentScriptGroup: routing.selected.routeKey,
      completedCommonSteps: Array.from(new Set([...after.completedCommonSteps, "COMMON.SERVICE_ROUTING"])),
    };
    return makeTrace({
      selected,
      routeKey: routing.selected.routeKey,
      stateBefore: before,
      stateAfter,
      workflow: input.workflow,
      decisionRule: "service_identified_route_directly",
      renderedText: `Dạ được mình nha 😊 Mình đang quan tâm ${routing.selected.label.toLocaleLowerCase("vi")} đúng không ạ? Mình cho em xin thêm nhu cầu cụ thể để em tư vấn sát hơn nha.`,
      variables: { SERVICE_NAME: routing.selected.label },
    });
  }

  if (input.workflow.reason === "common_clarify_outdoor") {
    return makeTrace({
      selected: node("COMMON.SERVICE_ROUTING", input.overrides),
      stateBefore: before,
      stateAfter: after,
      workflow: input.workflow,
      decisionRule: "ambiguous_outdoor_requires_clarification",
      renderedText: "Dạ mình đang hỏi gói cổng có chụp thêm ngoại cảnh, hay mình muốn tham khảo riêng album ngoại cảnh ạ?",
      variables: {},
    });
  }
  if (input.workflow.reason === "common_clarify_dress") {
    return makeTrace({
      selected: node("COMMON.SERVICE_ROUTING", input.overrides),
      stateBefore: before,
      stateAfter: after,
      workflow: input.workflow,
      decisionRule: "ambiguous_dress_requires_clarification",
      renderedText: "Dạ mình đang hỏi váy có trong gói chụp cổng, hay mình muốn thuê váy riêng ạ?",
      variables: {},
    });
  }
  if (input.workflow.action === "SEND_PRICE_SHEET") {
    return makeTrace({ selected: node("WEDDING_GATE.PRICING.SEND_RETAIL_PRICE", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 3, priceSheetSent: true }, workflow: input.workflow, decisionRule: "direct_or_confirmed_price_request" });
  }
  if (input.workflow.reason === "owner_gate_step_3_package_detail") {
    return makeTrace({
      selected: node("WEDDING_GATE.PRICING.SEND_RETAIL_PRICE", input.overrides),
      stateBefore: before,
      stateAfter: { ...after, currentStep: 3, priceSheetSent: true },
      workflow: input.workflow,
      decisionRule: "package_detail_owned_by_step_3",
    });
  }
  if (input.workflow.reason === "owner_gate_step_4_compare") {
    return makeTrace({ selected: node("WEDDING_GATE.COMPARE.PACKAGES", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 4 }, workflow: input.workflow, decisionRule: "compare_packages_owned_by_step_4" });
  }
  if (input.workflow.reason === "owner_gate_step_6_objection") {
    return makeTrace({ selected: node("WEDDING_GATE.OBJECTION.PRICE", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 6 }, workflow: input.workflow, decisionRule: "price_objection_owned_by_step_6" });
  }
  if (input.workflow.reason === "owner_gate_step_7_recommendation") {
    return makeTrace({
      selected: node("WEDDING_GATE.DECISION.RECOMMEND_PACKAGE", input.overrides),
      stateBefore: before,
      stateAfter: { ...after, currentStep: 7 },
      workflow: input.workflow,
      decisionRule: "recommendation_owned_by_step_7",
    });
  }
  if (input.workflow.reason === "owner_gate_step_7_decision") {
    return makeTrace({
      selected: node("WEDDING_GATE.DECISION.PACKAGE_SELECTED", input.overrides),
      stateBefore: before,
      stateAfter: { ...after, currentStep: 8 },
      workflow: input.workflow,
      decisionRule: "package_decision_owned_by_step_7",
      renderedText: decisionReply(input.workflow),
      variables: { SELECTED_PACKAGE: packageLabel(input.workflow.packageDecision.packageHint), DECISION_STATUS: input.workflow.packageDecision.status, BOOKING_READY: input.workflow.packageDecision.bookingReady },
    });
  }
  if (input.workflow.reason === "owner_gate_step_8_booking") {
    const lead = input.workflow.bookingLead;
    const packageName = packageLabel(input.workflow.packageDecision.packageHint) ?? after.selectedPackageName;
    const hasDate = lead.requestedDates.length > 0 || Boolean(after.slots.wedding_date);
    const stateAfter = { ...after, currentStep: 8 };
    if (lead.paymentRequested) {
      return makeTrace({
        selected: node("WEDDING_GATE.CLOSING.HUMAN_HANDOFF", input.overrides),
        stateBefore: before,
        stateAfter: { ...stateAfter, humanHandoff: true },
        workflow: input.workflow,
        decisionRule: "payment_or_bank_request_requires_verified_human_handoff",
        renderedText: "Dạ phần cọc hoặc tài khoản thanh toán em chuyển nhân viên phụ trách xác nhận đúng thông tin hiện hành cho mình nha. Em chưa tự ghi cọc hay tạo thanh toán ạ.",
        variables: {},
      });
    }
    if (!packageName) {
      return makeTrace({
        selected: node("WEDDING_GATE.CLOSING.COLLECT_MISSING", input.overrides), stateBefore: before, stateAfter, workflow: input.workflow,
        decisionRule: "step_8_ask_only_missing_package", renderedText: "Dạ mình muốn chốt gói nào trong bảng Chụp cổng để em ghi nhận đúng ạ?", variables: {},
      });
    }
    if (!hasDate && !lead.dateUncertain) {
      return makeTrace({
        selected: node("WEDDING_GATE.CLOSING.COLLECT_MISSING", input.overrides), stateBefore: before, stateAfter, workflow: input.workflow,
        decisionRule: "step_8_ask_only_missing_requested_date", renderedText: "Dạ mình dự kiến chụp ngày nào để nhân viên kiểm tra lịch giúp mình ạ?", variables: { SELECTED_PACKAGE: packageName },
      });
    }
    if (!lead.phone) {
      return makeTrace({
        selected: node("WEDDING_GATE.CLOSING.COLLECT_MISSING", input.overrides), stateBefore: before, stateAfter, workflow: input.workflow,
        decisionRule: "step_8_ask_only_missing_contact", renderedText: "Dạ mình cho em xin số điện thoại liên hệ để nhân viên phản hồi kết quả kiểm tra lịch nha?", variables: { SELECTED_PACKAGE: packageName },
      });
    }
    const dateSummary = lead.requestedDates.length > 0 ? lead.requestedDates.join(", ") : lead.dateUncertain ? "chưa chốt ngày" : (after.slots.wedding_date ?? "đã cung cấp");
    return makeTrace({
      selected: node("WEDDING_GATE.CLOSING.HUMAN_HANDOFF", input.overrides),
      stateBefore: before,
      stateAfter: { ...stateAfter, humanHandoff: true },
      workflow: input.workflow,
      decisionRule: lead.availabilityRequested ? "availability_check_read_only_then_human_handoff" : "step_8_minimum_information_complete_human_handoff",
      renderedText: `Dạ em tóm tắt: ${packageName}, ngày dự kiến ${dateSummary}, số liên hệ ${lead.phone}. Em chuyển nhân viên kiểm tra và xác nhận lại nha; hiện em chưa giữ lịch hay tạo booking ạ.`,
      variables: { SELECTED_PACKAGE: packageName, PHONE: lead.phone, REQUESTED_DATE: dateSummary },
    });
  }
  if (input.workflow.reason === "owner_gate_step_7_unresolved_decision") {
    return makeTrace({
      selected: node("WEDDING_GATE.DECISION.PACKAGE_SELECTED", input.overrides),
      stateBefore: before,
      stateAfter: { ...after, currentStep: 7 },
      workflow: input.workflow,
      decisionRule: "unresolved_package_choice_stays_before_closing",
      renderedText: decisionReply(input.workflow),
      variables: { SELECTED_PACKAGE: packageLabel(input.workflow.packageDecision.packageHint) },
    });
  }
  if (input.workflow.reason === "customer_wants_time_to_consider") {
    return makeTrace({
      selected: node("WEDDING_GATE.FOLLOW_UP.COMPARE_PACKAGES", input.overrides),
      stateBefore: before,
      stateAfter: { ...after, currentStep: 9 },
      workflow: input.workflow,
      decisionRule: "follow_up_policy_simulation_only",
      renderedText: "Dạ mình cứ xem kỹ và cân nhắc thoải mái nha. Khi cần em tiếp tục đúng phần chụp cổng mình đang xem ạ.",
      variables: {},
    });
  }
  if (input.workflow.action === "EXPLAIN_PENDING" || (isClarification(text) && before.pendingQuestion)) {
    return makeTrace({ selected: node("WEDDING_GATE.DISCOVERY.EXPLAIN_PENDING", input.overrides), stateBefore: before, stateAfter: after, workflow: input.workflow, decisionRule: "clarify_current_pending_question" });
  }
  if (input.workflow.action === "SEND_SAMPLE") {
    return makeTrace({ selected: node("WEDDING_GATE.SAMPLE.SEND_MATCHED", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 2 }, workflow: input.workflow, decisionRule: "customer_requested_samples_or_discovery_ready" });
  }
  if (input.workflow.action === "ASK_SAMPLE_CONFIRMATION") {
    return makeTrace({ selected: node("WEDDING_GATE.SAMPLE.ASK_CONFIRMATION", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 2 }, workflow: input.workflow, decisionRule: "sample_sent_wait_for_customer_confirmation" });
  }
  const styleCapturedThisTurn = input.workflow.filledSlots.some((slot) => slot.key === "style" && slot.source === "current_message");
  if (styleCapturedThisTurn) {
    return makeTrace({ selected: node("WEDDING_GATE.DISCOVERY.CAPTURE_STYLE", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 1, pendingQuestion: "gate_count" }, workflow: input.workflow, decisionRule: "style_captured_without_reasking_previous_question" });
  }
  if (input.workflow.action === "ASK_DISCOVERY" && !before.serviceIntent) {
    return makeTrace({ selected: node("WEDDING_GATE.DISCOVERY.CONFIRM_SERVICE", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 1, pendingQuestion: "gate_count" }, workflow: input.workflow, decisionRule: "wedding_gate_service_confirmed" });
  }
  if (input.workflow.action === "ASK_DISCOVERY") {
    return makeTrace({ selected: node("WEDDING_GATE.DISCOVERY.COLLECT_NEXT_SLOT", input.overrides), stateBefore: before, stateAfter: after, workflow: input.workflow, decisionRule: "next_missing_discovery_slot" });
  }
  if (input.workflow.stage === "RECOMMEND_PACKAGE" || input.workflow.stage === "CLOSE_OR_HANDOFF") {
    return makeTrace({ selected: node("WEDDING_GATE.CLOSING.CONFIRM_PACKAGE", input.overrides), stateBefore: before, stateAfter: { ...after, currentStep: 6, pendingQuestion: "gate_count" }, workflow: input.workflow, decisionRule: "continue_after_verified_price_without_free_form_reply" });
  }

  const selected = node("COMMON.HANDOFF.UNMAPPED_REQUEST", input.overrides);
  return makeTrace({ selected, status: "UNMAPPED_RESPONSE", stateBefore: before, stateAfter: { ...after, humanHandoff: true }, workflow: input.workflow, decisionRule: "no_matching_active_node" });
}

export function appendScriptTraceData(trace: LuluResponseTrace, input: {
  renderedText?: string;
  assetIds?: string[];
  dataSources?: string[];
  priceSnapshot?: LuluResponseTrace["priceSnapshot"];
  validatorResults?: LuluResponseTrace["validatorResults"];
  stateAfter?: Partial<LuluScriptState>;
}): LuluResponseTrace {
  return {
    ...trace,
    ...(input.renderedText !== undefined ? { renderedText: input.renderedText } : {}),
    assetIds: input.assetIds ?? trace.assetIds,
    dataSources: input.dataSources ?? trace.dataSources,
    priceSnapshot: input.priceSnapshot ?? trace.priceSnapshot,
    validatorResults: input.validatorResults ?? trace.validatorResults,
    stateAfter: { ...trace.stateAfter, ...input.stateAfter },
  };
}
