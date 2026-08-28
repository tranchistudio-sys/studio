import { isExplicitSampleRequest } from "./sale-samples";
import { isPriceSheetRequest, resolveServiceKeyFromConversation, type SaleHistoryItem } from "./sale-price-sheet";

export type SaleStage =
  | "GREETING"
  | "IDENTIFY_SERVICE"
  | "DISCOVERY"
  | "SEND_SAMPLE"
  | "WAIT_SAMPLE_CONFIRMATION"
  | "SEND_PRICE_SHEET"
  | "EXPLAIN_PACKAGES"
  | "RECOMMEND_PACKAGE"
  | "FOLLOW_UP"
  | "CLOSE_OR_HANDOFF";

export type SaleWorkflowAction =
  | "ASK_SERVICE"
  | "ASK_DISCOVERY"
  | "EXPLAIN_PENDING"
  | "SEND_SAMPLE"
  | "ASK_SAMPLE_CONFIRMATION"
  | "SEND_PRICE_SHEET"
  | "CONTINUE_CONVERSATION";

export type RequestedSaleAction =
  | "price_sheet"
  | "sample"
  | "sample_confirmation"
  | "clarification"
  | "discovery_answer"
  | "service_switch"
  | "none";

export type SaleSlot = { key: string; label: string; value: string | null; source: string | null };

export type SaleWorkflowDecision = {
  stage: SaleStage;
  action: SaleWorkflowAction;
  reason: string;
  greeted: boolean;
  serviceKey: string | null;
  slots: SaleSlot[];
  filledSlots: SaleSlot[];
  missingSlots: SaleSlot[];
  nextSlot: SaleSlot | null;
  quoteRequested: boolean;
  forcedPrice: boolean;
  sampleRequired: boolean;
  sampleSent: boolean;
  sampleConfirmed: boolean;
  priceSheetSent: boolean;
  sampleAsset: string | null;
  style: string | null;
  detectedIntent: string | null;
  requestedAction: RequestedSaleAction;
  priceRequested: boolean;
  askedQuestionKeys: string[];
  lastAskedQuestionKey: string | null;
  answeredSlots: string[];
  selectedAction: SaleWorkflowAction;
  actionPriorityReason: string;
  packageDecision: {
    status: "NONE" | "TENTATIVE" | "CONFIRMED";
    packageHint: "SAVING" | "BASIC" | "PREMIUM" | "LUXURY" | null;
    resolution: "EXACT" | "CONTEXT" | "AMBIGUOUS_BENEFIT" | "UNKNOWN_PRICE" | "SERVICE_ONLY" | null;
    bookingReady: boolean | null;
  };
  recommendationRequested: boolean;
  bookingLead: {
    phone: string | null;
    customerName: string | null;
    requestedDates: string[];
    dateUncertain: boolean;
    availabilityRequested: boolean;
    paymentRequested: boolean;
  };
};

type SlotConfig = { key: string; label: string };
type TextEvidence = { text: string; source: string; index: number; direction: "incoming" | "outgoing"; aiDecision?: string | null };

const DISCOVERY_SLOTS: Record<string, SlotConfig[]> = {
  wedding_album: [
    { key: "wedding_kind", label: "album/prewedding hay chup ngay cuoi/tiec cuoi" },
    { key: "album_location_type", label: "album tai studio hay ngoai canh" },
  ],
  wedding_gate: [
    { key: "gate_count", label: "so luong cong can chup" },
    { key: "wedding_date", label: "ngay chup/ngay cuoi du kien" },
    { key: "style", label: "phong cach/gu anh cong" },
    { key: "outfit_status", label: "trang phuc chup cong" },
    { key: "makeup_need", label: "nhu cau makeup" },
    { key: "priority", label: "uu tien tiet kiem hay day du" },
  ],
  album_studio: [{ key: "style", label: "phong cach album studio" }],
  album_outdoor: [
    { key: "location_need", label: "boi canh that tai Tay Ninh" },
    { key: "style", label: "phong cach anh" },
  ],
  beauty: [
    { key: "beauty_type", label: "the loai beauty/thoi trang" },
    { key: "style", label: "gu/tone anh" },
  ],
  maternity: [
    { key: "pregnancy_month", label: "thang thai ky" },
    { key: "participants", label: "chup ca nhan hay cung gia dinh" },
    { key: "style", label: "phong cach anh bau" },
  ],
  wedding_party: [
    { key: "wedding_date", label: "ngay cuoi duong lich" },
    { key: "bride_location", label: "khu vuc nha co dau" },
    { key: "groom_location", label: "khu vuc nha chu re" },
    { key: "venue_format", label: "tiec tai nha hay nha hang" },
    { key: "table_count", label: "so ban du kien" },
  ],
  rental_outfit: [
    { key: "use_date", label: "ngay su dung" },
    { key: "outfit_type", label: "loai trang phuc" },
    { key: "size_need", label: "size hoac nhu cau thu do" },
  ],
  family: [{ key: "primary_need", label: "nhu cau chinh cua buoi chup" }],
  makeup: [{ key: "primary_need", label: "dip va nhu cau makeup" }],
  video: [{ key: "primary_need", label: "nhu cau quay chinh" }],
  printing: [{ key: "primary_need", label: "kich thuoc va so luong can in" }],
};

const SAMPLE_REQUIRED_SERVICES = new Set([
  "wedding_gate",
  "album_studio",
  "album_outdoor",
  "beauty",
  "maternity",
]);

function norm(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function allEvidence(message: string, prior: SaleHistoryItem[]): TextEvidence[] {
  return [
    ...prior.map((item, index) => ({
      text: item.message,
      source: `prior_${item.direction}_${index}`,
      index,
      direction: item.direction,
      aiDecision: item.aiDecision,
    })),
    { text: message, source: "current_message", index: prior.length, direction: "incoming" as const, aiDecision: null },
  ].filter((item) => item.text.trim());
}

function incomingTexts(evidence: TextEvidence[]): TextEvidence[] {
  return evidence.filter((item) => item.direction === "incoming" && !item.text.startsWith("[image:"));
}

function lastMatch(
  texts: TextEvidence[],
  matcher: (text: string, normalized: string) => string | null,
): { value: string; source: string } | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const value = matcher(texts[i].text, norm(texts[i].text));
    if (value) return { value, source: texts[i].source };
  }
  return null;
}

const STYLE_KEYWORDS = [
  "nhe nhang", "sang trong", "nang tho", "ngot ngao", "sexy", "quyen ru", "luxury",
  "cool boy", "cool girl", "ca tinh", "tu nhien", "han quoc", "co dien", "hien dai",
  "tinh te", "toi gian", "chinh chu", "cao cap", "premium", "viet phuc", "co trang", "truyen thong",
  "tre trung", "fashion", "editorial", "nen sang", "nen toi", "nhieu hoa", "it hoa", "trang tinh", "de thuong",
];

function styleSlot(texts: TextEvidence[]) {
  return lastMatch(texts, (raw, text) => {
    const found = STYLE_KEYWORDS.find((keyword) => text.includes(keyword));
    if (found) return found;
    if (/\b(thich|ung|chon)\b.{0,24}\b(mau|hinh|phong cach|kieu|tone|gu)\b/.test(text)) return raw.trim();
    return null;
  });
}

function beautyTypeSlot(texts: TextEvidence[]) {
  const types: Array<{ value: string; pattern: RegExp; specificity: number }> = [
    { value: "maternity", pattern: /\b(chup bau|me bau|mang thai|thai ky|maternity)\b/, specificity: 3 },
    { value: "birthday", pattern: /\b(sinh nhat|birthday)\b/, specificity: 2 },
    { value: "couple", pattern: /\b(couple|tinh yeu|cap doi)\b/, specificity: 2 },
    { value: "historical", pattern: /\b(co trang|viet phuc|co phuc|ao dai)\b/, specificity: 2 },
    { value: "cool_boy", pattern: /\b(cool boy|nam tinh|chup nam)\b/, specificity: 2 },
    { value: "sexy", pattern: /\b(sexy|quyen ru)\b/, specificity: 2 },
    { value: "luxury", pattern: /\b(sang trong|luxury|sang chanh)\b/, specificity: 1 },
    { value: "sweet", pattern: /\b(nang tho|ngot ngao|nhe nhang)\b/, specificity: 1 },
    { value: "personal", pattern: /\b(beauty|beaty|ca nhan|chan dung|profile|thoi trang)\b/, specificity: 0 },
  ];
  let best: { value: string; source: string; specificity: number; index: number } | null = null;
  for (let index = 0; index < texts.length; index++) {
    const type = types.find((candidate) => candidate.pattern.test(norm(texts[index].text)));
    if (!type || (best && type.specificity < best.specificity)) continue;
    best = { value: type.value, source: texts[index].source, specificity: type.specificity, index };
  }
  return best ? { value: best.value, source: best.source } : null;
}

function dateSlot(texts: TextEvidence[], unknownAllowed = true) {
  return lastMatch(texts, (raw, text) => {
    if (unknownAllowed && /\b(chua biet ngay|chua chot ngay|chua co ngay|khong biet ngay)\b/.test(text)) return "unknown_date";
    const date = raw.match(/\b([0-3]?\d)[\/.\-]([01]?\d)(?:[\/.\-](20\d{2}|\d{2}))?\b/);
    if (date) return date[0];
    const written = text.match(/\bngay\s+([0-3]?\d)\s+thang\s+([01]?\d)(?:\s+nam\s+(20\d{2}))?/);
    return written?.[0] ?? null;
  });
}

function simpleKeywordSlot(texts: TextEvidence[], patterns: RegExp[], fallbackRaw = false) {
  return lastMatch(texts, (raw, text) => patterns.some((pattern) => pattern.test(text)) ? (fallbackRaw ? raw.trim() : text) : null);
}

function locationSlot(texts: TextEvidence[], who: "bride" | "groom") {
  const marker = who === "bride" ? /(nha co dau|co dau)/ : /(nha chu re|chu re)/;
  return lastMatch(texts, (raw, text) => marker.test(text) && /\b(o|tai|khu vuc|quan|huyen|tinh|tp|thanh pho|q\d+)\b/.test(text) ? raw.trim() : null);
}

function outdoorLocationSlot(texts: TextEvidence[]) {
  return lastMatch(texts, (raw, text) => {
    const allowed = /\b(tay ninh|nui ba den|nui ba|ho dau tieng|duong minh chau|ho nuoc|quan ca phe|cafe|coffee|chua go ken|toa thanh cao dai|dong co|bo ho|thien nhien|kien truc|vu garden|maison)\b/;
    const outside = /\b(vung tau|da lat|sai gon|tp hcm|ho chi minh|nha trang|phu quoc|mui ne)\b/;
    if (outside.test(text) || !allowed.test(text)) return null;
    return raw.trim();
  });
}

function inferSlotValue(key: string, texts: TextEvidence[]) {
  switch (key) {
    case "gate_count": return lastMatch(texts, (_raw, text) => {
      if (/\b(2|hai)\s*cong\b/.test(text)) return "two_gates";
      if (/\b(1|mot)\s*cong\b/.test(text)) return "one_gate";
      return null;
    });
    case "style": return styleSlot(texts);
    case "outfit_status": return lastMatch(texts, (_raw, text) => {
      if (/\b(chua co|chua chon|can thue)\b.{0,24}\b(trang phuc|vay|ao dai|vest)\b|\b(chua co do)\b/.test(text)) return "needs_outfit";
      if (/\b(da co|tu chuan bi)\b.{0,24}\b(trang phuc|vay|ao dai|vest)\b|\bda co do\b/.test(text)) return "has_outfit";
      return null;
    });
    case "makeup_need": return lastMatch(texts, (_raw, text) => {
      if (/\b(khong can|tu makeup|tu trang diem)\b/.test(text)) return "no_makeup";
      if (/\b(can|co)\b.{0,20}\b(makeup|make up|trang diem)\b/.test(text)) return "needs_makeup";
      return null;
    });
    case "priority": return lastMatch(texts, (_raw, text) => {
      if (/\b(tiet kiem|ngan sach|gia mem|re)\b/.test(text)) return "budget";
      if (/\b(day du|chinh chu|cao cap|tot nhat)\b/.test(text)) return "full_service";
      return null;
    });
    case "beauty_type": return beautyTypeSlot(texts);
    case "wedding_date":
    case "use_date": return dateSlot(texts);
    case "bride_location": return locationSlot(texts, "bride");
    case "groom_location": return locationSlot(texts, "groom");
    case "venue_format": return simpleKeywordSlot(texts, [/\bnha hang\b/, /\btiec tai nha\b/, /\blam tai nha\b/, /\bchi lam nha hang\b/], true);
    case "table_count": return lastMatch(texts, (_raw, text) => text.match(/\b\d{1,3}\s*ban\b/)?.[0] ?? null);
    case "pregnancy_month": return lastMatch(texts, (_raw, text) => text.match(/\b(?:bau|thai|mang thai)?\s*(\d{1,2})\s*thang\b/)?.[0] ?? null);
    case "participants": return simpleKeywordSlot(texts, [/\bchup mot minh\b/, /\bchup ca nhan\b/, /\bmot minh\b/, /\bchup cung chong\b/, /\bcung chong\b/, /\bchup gia dinh\b/, /\bcung gia dinh\b/], true);
    case "outfit_type": return simpleKeywordSlot(texts, [/\bvay cuoi\b/, /\bao dai\b/, /\bvest\b/, /\bsuit\b/, /\btrang phuc\b/], true);
    case "size_need": return simpleKeywordSlot(texts, [/\bsize\b/, /\bthu do\b/, /\bthu vay\b/, /\bthu trang phuc\b/], true);
    case "location_need": return outdoorLocationSlot(texts);
    case "wedding_kind": return simpleKeywordSlot(texts, [/\balbum\b/, /\bprewedding\b/, /\bpre wedding\b/, /\bngay cuoi\b/, /\btiec cuoi\b/], true);
    case "album_location_type": return simpleKeywordSlot(texts, [/\bstudio\b/, /\bngoai canh\b/], true);
    case "primary_need": return texts.length > 0 ? { value: texts[texts.length - 1].text.trim(), source: texts[texts.length - 1].source } : null;
    default: return null;
  }
}

const QUESTION_KEY_PATTERNS: Record<string, RegExp> = {
  service_type: /\b(dich vu nao|quan tam dich vu|chup cong,? album|chup anh cong,? album|muon xem dich vu nao truoc|studio hay album ngoai canh)\b/,
  gate_count: /\b(mot cong hay hai cong|1 cong hay 2 cong|so luong cong)\b/,
  sample_confirmation: /\bmau\b.{0,60}\b(hop gu|ung huong|ung mau|thich huong|on khong)\b/,
  style: /\b(thich huong|thich phong cach|thich tone|phong cach nao|huong nao|tone nao)\b/,
  location_need: /\b(canh thien nhien|nui ba den|quan ca phe|kien truc nao|boi canh nao)\b/,
  beauty_type: /\b(chup sinh nhat|beauty ca nhan|cool boy|co trang hay chup bau|the loai beauty)\b/,
  pregnancy_month: /\b(thang thai ky|mang thai may thang|bau may thang)\b/,
  participants: /\b(chup ca nhan hay cung gia dinh|chup mot minh hay)\b/,
  wedding_date: /\b(ngay cuoi|ngay duong lich)\b/,
  bride_location: /\b(nha co dau|khu vuc co dau)\b/,
  groom_location: /\b(nha chu re|khu vuc chu re)\b/,
  venue_format: /\b(tiec tai nha hay nha hang|lam tai nha hay nha hang)\b/,
  table_count: /\b(bao nhieu ban|so ban du kien)\b/,
  use_date: /\b(ngay su dung|can dung vao ngay nao)\b/,
  outfit_type: /\b(loai trang phuc|can thue loai)\b/,
  size_need: /\b(size nao|thu do|ghe thu do)\b/,
  wedding_kind: /\b(album prewedding|album\/prewedding|chup ngay cuoi)\b/,
  album_location_type: /\b(album tai studio hay ngoai canh|studio hay ngoai canh)\b/,
  primary_need: /\b(nhu cau chinh|nhu cau quan trong nhat)\b/,
};

function askedQuestionState(evidence: TextEvidence[], serviceStart: number): { keys: string[]; last: string | null } {
  const keys: string[] = [];
  let last: string | null = null;
  for (const item of evidence) {
    if (item.index < serviceStart || item.direction !== "outgoing" || item.text.startsWith("[image:")) continue;
    const text = norm(item.text);
    const key = Object.entries(QUESTION_KEY_PATTERNS).find(([, pattern]) => pattern.test(text))?.[0] ?? null;
    if (!key) continue;
    if (!keys.includes(key)) keys.push(key);
    last = key;
  }
  return { keys, last };
}

const FORCE_PRICE_RE = /\b(cu|cho|gui)\b.{0,28}\b(bang gia|gia)\b.{0,18}\b(truoc|di)|\bkhong can hoi|cu xem gia/i;
const SAMPLE_CONFIRM_RE = /\b(ung|thich|chon|dung gu|hop gu|mau nay ok|kieu nay ok|kieu nay duoc|cai nay duoc|lay phong cach nay|tam (?:so |thu )?[123]|cai dau|cai giua|cai cuoi|bao gia di|gui bang gia)\b/;
const SAMPLE_REJECT_RE = /\b(khong ung|khong thich|chua ung|doi mau|mau khac|kieu khac|khong hop)\b/;
const CUSTOMER_DEFERS_RE = /\b(de|cho)\s+(minh|anh|chi|em|toi)\s+(xem|coi|tham khao|suy nghi)(\s+them|\s+ky)?\b|\b(chua quyet dinh|chua chot|de tinh|suy nghi them|xem ky them)\b|\b(?:lien he|nhan lai|goi lai).{0,24}(?:tuan sau|ngay mai|vai ngay nua|thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|chu nhat)\b/;
const DISCOVERY_SKIP_RE = /\b(khong biet|chua biet|chua xac dinh|khong muon tra loi|bo qua|hoi sau|cu bao gia|bao gia truoc|gui gia truoc|cu cho .{0,12} xem truoc)\b/;
const CLARIFICATION_RE = /\b(nghia la sao|y la sao|la sao|giai thich)\b/;
const PACKAGE_COMPARE_RE = /\b(?:basic|premium|luxury|tiet kiem)\b.{0,28}\b(?:khac gi|so voi|loi hon|hon nhau)\b|\bso sanh\b.{0,28}\bgoi\b/;
const PACKAGE_COMPARE_EXTENDED_RE = /(?:\b1[.,]9\b|\b2[.,]9\b|\b3[.,]9\b|\b5[.,]9\b).{0,28}(?:\bvoi\b|\bva\b).{0,28}(?:\b1[.,]9\b|\b2[.,]9\b|\b3[.,]9\b|\b5[.,]9\b)|\b(?:tiet kiem|basic|premium|luxury)\b.{0,18}\b(?:hay|voi|va)\b.{0,18}\b(?:tiet kiem|basic|premium|luxury)\b|\bgoi thap nhat\b.{0,24}\bgoi cao nhat\b|\b(?:them|chenh)\s+\d+(?:[.,]\d+)?\s*(?:trieu|tr)\b.{0,18}\b(?:duoc gi|de lam gi)\b|\bgoi cang cao\b.{0,24}\b(?:hon|khac|duoc)\b|\bdoc bang\b.{0,30}\bkhong hieu\b/;
const PACKAGE_ADVICE_AFTER_PRICE_RE = /\bgoi nao\b.{0,24}\b(?:dang tien|ngon nhat|hop|nen chon|nhieu nguoi chon)\b|\b(?:chi can|can)\s+(?:dung\s+)?(?:mot|hai|1|2)\s+cong\b|\b(?:muon|thich|uu tien)\b.{0,20}\b(?:mica|san pham|ekip|tho chup|makeup)\b|\b(?:co can|nen)\b.{0,12}\blen luxury\b|\bmaster\b.{0,20}\b(?:dang|can|khac)\b|\bbasic\b.{0,12}\bvan on\b|\btoi da\s+\d+(?:[.,]\d+)?\s*(?:trieu|tr)\b/;
const PROMOTION_RE = /\b(khuyen mai|uu dai|giam gia|qua tang|co qua|qua gi|moc may|moc nao|cong don|quy doi qua|doi qua.*tien)\b|\b[2345]\s*(?:dich vu|goi)\b.{0,24}\b(?:duoc gi|qua|tang)\b|\bbeauty\b.{0,24}\b(?:tinh|cong)\b/;
const GATE_OBJECTION_RE = /\b(mac qua|cao qua|gia cao|hoi cao|vuot ngan sach|khong du ngan sach|ngan sach.*khong toi|goi.*re hon|re hon khong|bot duoc|giam (?:chi|em|minh)|giam them|gia chot|cho khac re hon|studio khac|tham khao.*studio|de .*suy nghi|suy nghi.*ngay|ngay.*suy nghi|hoi chong|hoi vo|hoi me|hoi gia dinh|chua muon coc|chua du tien coc|so phat sinh|so chup khong dep|chup chac khong dep|em map|em thap|mat tron|khong thich chup|khong co thoi gian|ban qua|chua chot ngay|du quyen loi|khong dung het|bo bot.*giam|cat bot.*giam|khong giong mau|co chinh hinh|chinh hinh dep|co dang tien|dang tien khong|khong chup nua|chon studio khac|khong con nhu cau)\b/;
const PACKAGE_DECISION_RE = /\b(chot|lay|chon|quyet|lam|doi sang)\b.{0,24}\b(tiet kiem|basic|premium|luxury)\b|\b(tiet kiem|basic|premium|luxury)\b\s*(?:nha|nhe|luon|di|thoi|la duoc|hop .+ hon)\b|\b(?:lay|chon|chot)\s+(?:goi\s+)?(?:1[.,]9|2[.,]9|3[.,]9|5[.,]9)\b|\b(?:lay|chon)\b.{0,20}\b(?:photo master|2 cong mica|goi nay|cai nay)\b/;
const BOOKING_PROCEED_RE = /\b(dat lich|giu lich|gio chot sao|lam sao dat lich|coc|tai khoan|chuyen khoan)\b/;
const AVAILABILITY_RE = /\b(con lich|trong lich|kiem tra lich|check lich|lich trong|ngay .* con khong)\b/;
const PAYMENT_RE = /\b(coc|tien coc|tai khoan|so tai khoan|chuyen khoan|thanh toan)\b/;
const NOT_READY_TO_BOOK_RE = /\b(chua dat lich|chua giu lich|chua booking|chua coc)\b/;
const TENTATIVE_DECISION_RE = /\b(chac|co le|nghieng|tam chon|de tam|gan chon)\b/;
const DECISION_CONCERN_RE = /\b(van|nhung)\b.{0,30}\b(mac|cao|ngan sach|khong du)\b/;
const PACKAGE_RECOMMENDATION_RE = /\b(theo em|em thay|em chon giup|chon giup|nen lay|nen chon|hop (?:chi|anh|em|minh)|hop nhat|chua biet chon|khong biet chon|hieu roi|em thay sao lam vay|co can len goi cao|basic du khong|quan trong cong|quan trong san pham|quan trong tho chup|quan trong makeup)\b/;

function bookingLeadFromEvidence(evidence: TextEvidence[]) {
  const incoming = incomingTexts(evidence);
  let phone: string | null = null;
  let customerName: string | null = null;
  const requestedDates: string[] = [];
  let dateUncertain = false;
  let availabilityRequested = false;
  let paymentRequested = false;
  for (const item of incoming) {
    const raw = item.text.trim();
    const text = norm(raw);
    const phoneMatch = raw.match(/(?:\+?84|0)(?:[\s.-]*\d){8,10}\b/);
    const digits = phoneMatch?.[0].replace(/\D/g, "") ?? "";
    if (/^(?:0|84)\d{8,10}$/.test(digits)) phone = digits;
    const nameMatch = raw.match(/(?:em|anh|chị|chi|mình|minh)\s+(?:tên|ten)\s+(?:là|la)\s+([\p{L}][\p{L}\s]{1,50})/iu);
    if (nameMatch) customerName = nameMatch[1].trim().replace(/[.!?,]+$/, "");
    const dates = raw.match(/\b(?:0?[1-9]|[12]\d|3[01])[\/-](?:0?[1-9]|1[0-2])(?:[\/-](?:20)?\d{2})?\b/g) ?? [];
    for (const date of dates) if (!requestedDates.includes(date)) requestedDates.push(date);
    if (/\b(chua biet ngay|chua chot ngay|chua co ngay|de xem ngay|khong biet ngay)\b/.test(text)) dateUncertain = true;
    availabilityRequested ||= AVAILABILITY_RE.test(text);
    paymentRequested ||= PAYMENT_RE.test(text);
  }
  return { phone, customerName, requestedDates, dateUncertain, availabilityRequested, paymentRequested };
}

function packageHintFromText(text: string): SaleWorkflowDecision["packageDecision"]["packageHint"] {
  if (/\b(?:tiet kiem|1[.,]9|goi thap nhat)\b/.test(text)) return "SAVING";
  if (/\b(?:basic|2[.,]9)\b/.test(text)) return "BASIC";
  if (/\b(?:premium|3[.,]9)\b/.test(text)) return "PREMIUM";
  if (/\b(?:luxury|5[.,]9|photo master|ekip master)\b/.test(text)) return "LUXURY";
  return null;
}

function lastPackageHint(prior: SaleHistoryItem[]): SaleWorkflowDecision["packageDecision"]["packageHint"] {
  for (let index = prior.length - 1; index >= 0; index--) {
    const hint = packageHintFromText(norm(prior[index].message));
    if (hint) return hint;
  }
  return null;
}

function classifyPackageDecision(message: string, prior: SaleHistoryItem[]): SaleWorkflowDecision["packageDecision"] {
  const text = norm(message);
  const tentative = TENTATIVE_DECISION_RE.test(text);
  const notReady = NOT_READY_TO_BOOK_RE.test(text);
  const explicitHint = packageHintFromText(text);
  const contextReference = /\b(goi nay|cai nay|goi do|cai do)\b/.test(text);
  const unknownPrice = /\b(?:lay|chon|chot)\b.{0,16}\b4[.,]5\b/.test(text);
  const ambiguousBenefit = /\b2 cong mica\b/.test(text);
  const serviceOnly = /\b(?:lay|chon|chot)\s+(?:dich vu\s+)?chup cong\b/.test(text) && !explicitHint;
  const decisionWording = PACKAGE_DECISION_RE.test(text) || contextReference || (tentative && Boolean(explicitHint));
  // Keep the customer's last explicit package choice available while Step 8
  // collects date/contact details. This is conversation context only; it does
  // not create or update a booking.
  const packageHint = explicitHint ?? lastPackageHint(prior);
  const resolution = unknownPrice ? "UNKNOWN_PRICE"
    : ambiguousBenefit ? "AMBIGUOUS_BENEFIT"
      : serviceOnly ? "SERVICE_ONLY"
        : explicitHint ? "EXACT"
          : contextReference && packageHint ? "CONTEXT"
            : null;
  const status = decisionWording && !unknownPrice && !ambiguousBenefit && !serviceOnly
    ? (tentative ? "TENTATIVE" : "CONFIRMED")
    : "NONE";
  return {
    status,
    packageHint,
    resolution,
    bookingReady: notReady ? false : status === "CONFIRMED" ? true : null,
  };
}
const AMBIGUOUS_OUTDOOR_RE = /^\s*(co\s+)?ngoai canh\s*(khong|ko|hong)?\s*\??\s*$/;
const AMBIGUOUS_DRESS_RE = /^\s*(co\s+)?vay\s*(khong|ko|hong)?\s*\??\s*$/;

export function contextualIntentOwner(message: string): string | null {
  const text = norm(message);
  if (PACKAGE_COMPARE_RE.test(text) || PACKAGE_COMPARE_EXTENDED_RE.test(text)) return "GATE_STEP_4_COMPARE";
  if (GATE_OBJECTION_RE.test(text)) return "GATE_STEP_6_OBJECTION";
  if (PROMOTION_RE.test(text)) return "GATE_STEP_5_PROMOTION";
  if (PACKAGE_DECISION_RE.test(text)) return "GATE_STEP_7_DECISION";
  if (AMBIGUOUS_OUTDOOR_RE.test(text)) return "COMMON_CLARIFY_OUTDOOR";
  if (AMBIGUOUS_DRESS_RE.test(text)) return "COMMON_CLARIFY_DRESS";
  return null;
}

function imageUrlFromMessage(message: string): string | null {
  return message.match(/^\s*\[image:(.+?)\]\s*$/)?.[1]?.trim() ?? null;
}

function findServiceStartIndex(evidence: TextEvidence[], serviceKey: string): number {
  let start = 0;
  let previousExplicitService: string | null = null;
  for (const item of evidence) {
    if (item.direction !== "incoming") continue;
    const resolved = resolveServiceKeyFromConversation(item.text, []);
    if (resolved.ambiguous || !resolved.key) continue;
    if (resolved.key === serviceKey && previousExplicitService !== serviceKey) start = item.index;
    previousExplicitService = resolved.key;
  }
  return start;
}

function sampleEvidence(evidence: TextEvidence[], serviceKey: string): { sent: boolean; asset: string | null; index: number } {
  const serviceStart = findServiceStartIndex(evidence, serviceKey);
  for (let i = evidence.length - 1; i >= 0; i--) {
    const item = evidence[i];
    if (item.index < serviceStart || item.direction !== "outgoing") continue;
    const asset = imageUrlFromMessage(item.text);
    const explicitlySample = /sample/i.test(item.aiDecision ?? "");
    const explicitlyPrice = /price_sheet/i.test(item.aiDecision ?? "");
    if (explicitlyPrice) continue;
    if (asset && (explicitlySample || !item.aiDecision)) return { sent: true, asset, index: item.index };
  }
  return { sent: false, asset: null, index: -1 };
}

function priceSheetEvidence(evidence: TextEvidence[], serviceStart: number): { sent: boolean; index: number } {
  for (let i = evidence.length - 1; i >= 0; i--) {
    const item = evidence[i];
    if (item.index < serviceStart || item.direction !== "outgoing") continue;
    if (/price_sheet/i.test(item.aiDecision ?? "")) return { sent: true, index: item.index };
  }
  return { sent: false, index: -1 };
}

function sampleConfirmedAfter(evidence: TextEvidence[], sampleIndex: number): boolean {
  if (sampleIndex < 0) return false;
  return evidence.some((item) => {
    if (item.direction !== "incoming" || item.index <= sampleIndex) return false;
    const text = norm(item.text);
    return SAMPLE_CONFIRM_RE.test(text) && !SAMPLE_REJECT_RE.test(text);
  });
}

type SaleWorkflowBase = Omit<
  SaleWorkflowDecision,
  "stage" | "action" | "reason" | "selectedAction" | "actionPriorityReason"
>;

function decisionBase(input: SaleWorkflowBase) {
  return input;
}

function selectDecision(
  base: SaleWorkflowBase,
  stage: SaleStage,
  action: SaleWorkflowAction,
  reason: string,
  nextSlot: SaleSlot | null = base.nextSlot,
): SaleWorkflowDecision {
  return { ...base, stage, action, reason, nextSlot, selectedAction: action, actionPriorityReason: reason };
}

export function evaluateSaleWorkflow(input: { message: string; prior?: SaleHistoryItem[] }): SaleWorkflowDecision {
  const prior = input.prior ?? [];
  const packageDecision = classifyPackageDecision(input.message, prior);
  const recommendationRequested = PACKAGE_RECOMMENDATION_RE.test(norm(input.message));
  const service = resolveServiceKeyFromConversation(input.message, prior);
  const serviceKey = service.ambiguous ? null : service.key;
  const evidence = allEvidence(input.message, prior);
  const serviceStart = serviceKey ? findServiceStartIndex(evidence, serviceKey) : 0;
  const bookingLead = bookingLeadFromEvidence(evidence.filter((item) => item.index >= serviceStart));
  // A service switch starts a fresh discovery scope; never reuse a prior service's preferences.
  const texts = incomingTexts(evidence).filter((item) => item.index >= serviceStart);
  const configs = serviceKey ? (DISCOVERY_SLOTS[serviceKey] ?? [{ key: "primary_need", label: "nhu cau quan trong nhat" }]) : [];
  const slots: SaleSlot[] = configs.map((config) => {
    const found = inferSlotValue(config.key, texts);
    return { ...config, value: found?.value ?? null, source: found?.source ?? null };
  });
  const filledSlots = slots.filter((slot) => slot.value);
  const missingSlots = slots.filter((slot) => !slot.value);
  const priceRequested = isPriceSheetRequest(input.message);
  const quoteRequested = priceRequested;
  const forcedPrice = FORCE_PRICE_RE.test(norm(input.message)) && isPriceSheetRequest(input.message);
  const alternateSampleRequested = isExplicitSampleRequest(input.message) && !isPriceSheetRequest(input.message);
  const greeted = prior.some((item) => item.direction === "outgoing" && !item.message.startsWith("[image:"));
  const sampleRequired = !!serviceKey && SAMPLE_REQUIRED_SERVICES.has(serviceKey);
  const sample = serviceKey ? sampleEvidence(evidence, serviceKey) : { sent: false, asset: null, index: -1 };
  const priceSheet = priceSheetEvidence(evidence, serviceStart);
  const sampleConfirmed = sampleConfirmedAfter(evidence, sample.index);
  const sampleConfirmedNow = sample.sent && SAMPLE_CONFIRM_RE.test(norm(input.message)) && !SAMPLE_REJECT_RE.test(norm(input.message));
  const customerDefers = CUSTOMER_DEFERS_RE.test(norm(input.message));
  const discoverySkipped = DISCOVERY_SKIP_RE.test(norm(input.message));
  const clarificationRequested = CLARIFICATION_RE.test(norm(input.message));
  const intentOwner = contextualIntentOwner(input.message);
  const adviceAfterPrice = priceSheet.sent && PACKAGE_ADVICE_AFTER_PRICE_RE.test(norm(input.message));
  const style = slots.find((slot) => slot.key === "style")?.value ?? null;
  const questions = askedQuestionState(evidence, serviceStart);
  const explicitCurrentService = resolveServiceKeyFromConversation(input.message, []);
  const previousService = resolveServiceKeyFromConversation("", prior);
  const serviceSwitched = !explicitCurrentService.ambiguous && !!explicitCurrentService.key
    && !previousService.ambiguous && !!previousService.key && explicitCurrentService.key !== previousService.key;
  const answeredCurrentSlot = filledSlots.some((slot) => slot.source === "current_message");
  const requestedAction: RequestedSaleAction = serviceSwitched
    ? "service_switch"
    : priceRequested
    ? "price_sheet"
    : alternateSampleRequested
      ? "sample"
      : sampleConfirmedNow
        ? "sample_confirmation"
        : clarificationRequested
          ? "clarification"
        : answeredCurrentSlot
          ? "discovery_answer"
          : "none";
  const base = decisionBase({
    greeted,
    serviceKey,
    slots,
    filledSlots,
    missingSlots,
    nextSlot: missingSlots[0] ?? null,
    quoteRequested,
    forcedPrice,
    sampleRequired,
    sampleSent: sample.sent,
    sampleConfirmed,
    priceSheetSent: priceSheet.sent,
    sampleAsset: sample.asset,
    style,
    detectedIntent: priceRequested ? "price_sheet" : serviceKey,
    requestedAction,
    priceRequested,
    askedQuestionKeys: questions.keys,
    lastAskedQuestionKey: questions.last,
    answeredSlots: filledSlots.map((slot) => slot.key),
    packageDecision,
    recommendationRequested,
    bookingLead,
  });

  const asksAnotherDecisionMaker = /hỏi\s+(?:chồng|vợ|mẹ|gia đình)/i.test(input.message)
    || /\bhoi\s+(?:chong|vo|me|gia dinh)\b/.test(norm(input.message));
  const priorMentionsWeddingGate = prior.some((item) => /\b(chup cong|cong cuoi|hinh cong|anh cong)\b/.test(norm(item.message)));
  // Promotion policy is owned by Step 5 even before a service has been chosen,
  // and even when the question mentions Beauty only to ask if it is eligible.
  if (intentOwner === "GATE_STEP_5_PROMOTION" && !serviceSwitched) {
    return selectDecision(base, "FOLLOW_UP", "CONTINUE_CONVERSATION", "owner_gate_step_5_promotion", null);
  }
  if (DECISION_CONCERN_RE.test(norm(input.message)) && packageDecision.status !== "NONE") {
    return selectDecision(base, "RECOMMEND_PACKAGE", "CONTINUE_CONVERSATION", "owner_gate_step_6_objection", null);
  }
  // "hỏi gia đình" không phải yêu cầu báo giá dịch vụ Gia đình. Giữ owner Step 6
  // theo ngữ cảnh chụp cổng trước đó, trước khi bộ nhận diện giá chạy.
  if (
    (intentOwner === "GATE_STEP_6_OBJECTION" || asksAnotherDecisionMaker)
    && (serviceKey === "wedding_gate" || previousService.key === "wedding_gate" || (asksAnotherDecisionMaker && priorMentionsWeddingGate))
  ) {
    return selectDecision(base, "RECOMMEND_PACKAGE", "CONTINUE_CONVERSATION", "owner_gate_step_6_objection", null);
  }
  if (!serviceKey) {
    return selectDecision(base, greeted ? "IDENTIFY_SERVICE" : "GREETING", "ASK_SERVICE", service.ambiguous ? "multiple_services" : "service_unknown", null);
  }
  // Direct customer actions always outrank incomplete discovery slots.
  if (priceRequested) {
    return selectDecision(base, "SEND_PRICE_SHEET", "SEND_PRICE_SHEET", forcedPrice ? "customer_insists_on_price_first" : "direct_price_request", null);
  }
  if (alternateSampleRequested && sampleRequired) {
    return selectDecision(base, "SEND_SAMPLE", "SEND_SAMPLE", sample.sent ? "customer_requested_another_sample" : "direct_sample_request", null);
  }
  if (sampleConfirmedNow) {
    return selectDecision(base, "SEND_PRICE_SHEET", "SEND_PRICE_SHEET", "sample_confirmed_ready_to_quote", null);
  }
  if (clarificationRequested && base.nextSlot) {
    return selectDecision(base, "DISCOVERY", "EXPLAIN_PENDING", `clarify_pending_slot:${base.nextSlot.key}`);
  }
  if (
    serviceKey === "wedding_gate"
    && discoverySkipped
    && base.nextSlot
    && questions.keys.includes(base.nextSlot.key)
  ) {
    return selectDecision(
      base,
      "SEND_PRICE_SHEET",
      "SEND_PRICE_SHEET",
      `discovery_question_skipped_provisional_quote:${base.nextSlot.key}`,
      null,
    );
  }
  // Step 6 xử lý sự phân vân ngay tại lượt hiện tại. Nếu khách thật sự cần thời
  // gian, câu trả lời Step 6 sẽ tôn trọng và lưu ngữ cảnh để Step 9 chăm sau.
  if (customerDefers) {
    return selectDecision(base, "FOLLOW_UP", "CONTINUE_CONVERSATION", "customer_wants_time_to_consider", null);
  }
  if (
    (serviceKey === "wedding_gate" || !serviceKey)
    && (intentOwner === "COMMON_CLARIFY_OUTDOOR" || intentOwner === "COMMON_CLARIFY_DRESS")
  ) {
    return selectDecision(base, "IDENTIFY_SERVICE", "CONTINUE_CONVERSATION", intentOwner.toLowerCase(), null);
  }
  // Các owner dưới đây chỉ thuộc kịch bản Chụp cổng. Không để một câu có tên
  // package ở Album/Beauty vô tình bị kéo ngược về workflow Chụp cổng.
  if (serviceKey === "wedding_gate" && recommendationRequested) {
    return selectDecision(base, "RECOMMEND_PACKAGE", "CONTINUE_CONVERSATION", "owner_gate_step_7_recommendation", null);
  }
  if (serviceKey === "wedding_gate" && (intentOwner === "GATE_STEP_4_COMPARE" || adviceAfterPrice)) {
    return selectDecision(base, "EXPLAIN_PACKAGES", "CONTINUE_CONVERSATION", "owner_gate_step_4_compare", null);
  }
  if (serviceKey === "wedding_gate" && intentOwner === "GATE_STEP_7_DECISION") {
    return selectDecision(base, "CLOSE_OR_HANDOFF", "CONTINUE_CONVERSATION", "owner_gate_step_8_booking", null);
  }
  if (serviceKey === "wedding_gate" && packageDecision.resolution) {
    return selectDecision(base, "CLOSE_OR_HANDOFF", "CONTINUE_CONVERSATION", "owner_gate_step_8_booking", null);
  }
  if (serviceKey === "wedding_gate" && BOOKING_PROCEED_RE.test(norm(input.message))) {
    return selectDecision(base, "CLOSE_OR_HANDOFF", "CONTINUE_CONVERSATION", "owner_gate_step_8_booking", null);
  }
  if (serviceKey === "wedding_gate" && (bookingLead.phone || bookingLead.customerName || bookingLead.requestedDates.length > 0 || bookingLead.dateUncertain || bookingLead.availabilityRequested || bookingLead.paymentRequested)) {
    return selectDecision(base, "CLOSE_OR_HANDOFF", "CONTINUE_CONVERSATION", "owner_gate_step_8_booking", null);
  }
  if (priceSheet.sent) {
    return selectDecision(base, "RECOMMEND_PACKAGE", "CONTINUE_CONVERSATION", "price_sheet_already_sent_follow_latest_preference", null);
  }
  if (sampleRequired && sample.sent && !sampleConfirmed) {
    if (questions.keys.includes("sample_confirmation")) {
      return selectDecision(base, "FOLLOW_UP", "CONTINUE_CONVERSATION", "repeat_sample_confirmation_guard", null);
    }
    return selectDecision(base, "WAIT_SAMPLE_CONFIRMATION", "ASK_SAMPLE_CONFIRMATION", "waiting_for_customer_style_confirmation", null);
  }
  if (missingSlots.length > 0) {
    if (serviceKey === "wedding_gate" && questions.keys.includes(missingSlots[0].key)) {
      // Discovery is advisory, not a hard gate. Once Lulu has asked this
      // question, do not ask it again or block the customer from seeing the
      // current packages. Quote with the information already known and let the
      // conversation continue naturally from there.
      return selectDecision(
        base,
        "SEND_PRICE_SHEET",
        "SEND_PRICE_SHEET",
        `discovery_question_skipped_provisional_quote:${missingSlots[0].key}`,
        null,
      );
    }
    if (sampleRequired && !sample.sent && questions.last === missingSlots[0].key) {
      return selectDecision(base, "SEND_SAMPLE", "SEND_SAMPLE", `repeat_question_guard:${missingSlots[0].key}`, null);
    }
    return selectDecision(base, "DISCOVERY", "ASK_DISCOVERY", `missing_required_slot:${missingSlots[0].key}`);
  }
  if (sampleRequired && !sample.sent) {
    return selectDecision(base, "SEND_SAMPLE", "SEND_SAMPLE", "discovery_complete_send_correct_portfolio");
  }
  return selectDecision(
    base,
    "SEND_PRICE_SHEET",
    "SEND_PRICE_SHEET",
    sampleRequired ? "sample_confirmed" : quoteRequested ? "discovery_complete_and_price_requested" : "discovery_complete",
    null,
  );
}

export function buildSaleWorkflowBlock(decision: SaleWorkflowDecision): string {
  const filled = decision.filledSlots.map((slot) => `${slot.key}=${slot.value}`).join("; ") || "none";
  const missing = decision.missingSlots.map((slot) => `${slot.key} (${slot.label})`).join("; ") || "none";
  const next = decision.nextSlot ? `${decision.nextSlot.key}: ${decision.nextSlot.label}` : "none";
  return `WORKFLOW SALE BAT BUOC (backend decided; AI only writes natural Vietnamese):
- Stage: ${decision.stage}
- Service: ${decision.serviceKey ?? "unknown"}
- Detected intent: ${decision.detectedIntent ?? "unknown"}
- Requested action: ${decision.requestedAction}; price requested: ${decision.priceRequested}
- Filled slots: ${filled}
- Missing slots: ${missing}
- Asked question keys: ${decision.askedQuestionKeys.join(", ") || "none"}; last: ${decision.lastAskedQuestionKey ?? "none"}
- Sample required: ${decision.sampleRequired}; sent: ${decision.sampleSent}; confirmed: ${decision.sampleConfirmed}
- Price sheet already sent: ${decision.priceSheetSent}
- Action this turn: ${decision.action}
- Reason: ${decision.reason}
- Next slot: ${next}

Rules:
- Perform exactly ONE action above and ask at most ONE main question.
- Never ask for a filled slot again.
- Do not repeat a question already listed in Asked question keys or already visible in the conversation.
- Avoid empty sales praise such as "tuyệt vời", "hoàn hảo", "lựa chọn tuyệt vời", or "em rất vui". State the useful recommendation and reason directly.
- Do not end every reply with a question. Ask only when one concrete missing answer is needed for the next action.
- ASK_DISCOVERY: briefly acknowledge, then ask only the next slot. Do not quote or promise a price sheet.
- ASK_SERVICE: ask which service the customer needs. Do not guess and do not send an image.
- SEND_SAMPLE: say briefly that the correct portfolio samples are being sent, then ask whether the customer likes that direction. Do not quote and do not use a price marker.
- ASK_SAMPLE_CONFIRMATION: ask whether the customer likes the samples already sent. Do not send another sample or quote yet.
- CONTINUE_CONVERSATION: answer the latest customer message in the current context. Do not repeat any question listed in Asked question keys. If the price sheet was already sent and the customer states a preference, recommend the closest verified package or explain the trade-off without restarting discovery.
- When Reason is customer_wants_time_to_consider, acknowledge briefly and do not ask another question or offer more samples.
- Album outdoor suggestions must stay in Tay Ninh and must not invent a location outside configured data.
- Maternity uses neutral/female address; never address a pregnant customer as \"anh\".
- Do not greet again when greeted=${decision.greeted}.`;
}

// Compatibility router retained from the production workflow foundation.
// The newer draft evaluator above and the deterministic V1 router serve
// different callers, so keep both exports available during the transition.
export { routeSaleAction, SALE_PLAYBOOK_V1 } from "./sale-workflow-router-v1";
export type { SaleAction, RouterInput, RouterDecision } from "./sale-workflow-router-v1";
