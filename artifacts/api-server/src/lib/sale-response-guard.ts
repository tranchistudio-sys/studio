import {
  detectServiceDrift,
  inferKnownIntent,
  type ConversationTurn,
} from "./sale-conversation-discipline";

export type CustomerAddress = "male" | "female" | "neutral";

export type SaleResponseGuardResult = {
  text: string;
  blocked: boolean;
  escalationReason: string | null;
  violations: string[];
  address: CustomerAddress;
};

const OFFICIAL_PRICING_MARKER = "BẢNG GIÁ BÁN LẺ CHÍNH THỨC";
const MONEY_RE = /(?:\d{1,3}(?:[.\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:triệu|tr|nghìn|ngàn|k|đ|vnđ|vnd)(?=$|[\s,.;:!?()])/giu;
const MILLION_RE = /(\d+(?:[.,]\d+)?)\s*(?:triệu|tr)(?:\s*(\d{1,3}))?/giu;
const THOUSAND_RE = /(\d+(?:[.,]\d+)?)\s*(?:nghìn|ngàn|k)\b/giu;
const VND_RE = /(\d{1,3}(?:[.\s]\d{3})+|\d+)\s*(?:đ|vnđ|vnd)(?=$|[\s,.;:!?()])/giu;
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s*%/g;

function normalizeVi(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function parseDecimal(raw: string): number {
  return Number(raw.replace(/,/g, "."));
}

function millionRemainder(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (raw.length === 1) return n * 100_000;
  if (raw.length === 2) return n * 10_000;
  return n * 1_000;
}

/** Extract monetary claims as integer VND values. */
export function extractMoneyValues(text: string): number[] {
  const values: Array<{ value: number; start: number }> = [];
  const occupied: Array<[number, number]> = [];
  const add = (value: number, start: number, end: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    values.push({ value: Math.round(value), start });
    occupied.push([start, end]);
  };
  const overlaps = (start: number, end: number) => occupied.some(([a, b]) => start < b && end > a);

  for (const m of text.matchAll(MILLION_RE)) {
    add(parseDecimal(m[1]) * 1_000_000 + millionRemainder(m[2]), m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
  for (const m of text.matchAll(THOUSAND_RE)) {
    const start = m.index ?? 0;
    if (!overlaps(start, start + m[0].length)) add(parseDecimal(m[1]) * 1_000, start, start + m[0].length);
  }
  for (const m of text.matchAll(VND_RE)) {
    const start = m.index ?? 0;
    if (!overlaps(start, start + m[0].length)) {
      add(Number(m[1].replace(/[.\s]/g, "")), start, start + m[0].length);
    }
  }
  values.sort((a, b) => a.start - b.start);
  return [...new Set(values.map((x) => x.value))];
}

function extractPercentValues(text: string): number[] {
  return [...new Set([...text.matchAll(PERCENT_RE)].map((m) => parseDecimal(m[1])).filter(Number.isFinite))];
}

function incomingMessages(history: ConversationTurn[], currentMessage: string): string[] {
  return [
    currentMessage,
    ...[...history].reverse().filter((h) => h.direction === "incoming").map((h) => h.message),
  ].filter(Boolean);
}

export function inferCustomerAddress(history: ConversationTurn[], currentMessage: string): CustomerAddress {
  for (const raw of incomingMessages(history, currentMessage)) {
    const text = normalizeVi(raw);
    if (/\b(bau|mang thai|me bau|co dau)\b/.test(text)) return "female";
    if (/\bchi\s+(muon|can|dang|da|hoi|xem|chup|thue)\b/.test(text)) return "female";
    if (/\b(chu re)\b/.test(text)) return "male";
    if (/\banh\s+(muon|can|dang|da|hoi|xem|chup|thue)\b/.test(text)) return "male";
  }
  return "neutral";
}

function replaceAddressWord(text: string, word: "anh" | "chị", replacement: string): string {
  const re = new RegExp(`(^|[\\s,.;:!?()])${word}(?=$|[\\s,.;:!?()])`, "giu");
  return text.replace(re, (_m, prefix: string) => `${prefix}${replacement}`);
}

export function applyCustomerAddress(text: string, address: CustomerAddress): string {
  let out = text.replace(/anh\s*\/\s*chị/giu, address === "male" ? "anh" : address === "female" ? "chị" : "mình");
  if (address === "female") out = replaceAddressWord(out, "anh", "chị");
  else if (address === "male") out = replaceAddressWord(out, "chị", "anh");
  else {
    out = replaceAddressWord(out, "anh", "mình");
    out = replaceAddressWord(out, "chị", "mình");
  }
  return out;
}

export function buildCustomerAddressRule(history: ConversationTurn[], currentMessage: string): string {
  const address = inferCustomerAddress(history, currentMessage);
  if (address === "female") return "XƯNG HÔ LƯỢT NÀY: khách đã có tín hiệu là nữ. Xưng em, gọi khách là chị hoặc mình; tuyệt đối không gọi anh.";
  if (address === "male") return "XƯNG HÔ LƯỢT NÀY: khách tự xưng anh/có tín hiệu là nam. Xưng em, có thể gọi khách là anh hoặc mình.";
  return "XƯNG HÔ LƯỢT NÀY: chưa xác định giới tính. Xưng em và gọi trung tính là mình; không tự đoán anh/chị.";
}

function removeMarkdown(text: string): string {
  return text
    .replace(/\*\*|__/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s*|[-*•]\s+)/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeFakeLinkPlaceholders(text: string): { text: string; removed: boolean } {
  const cleaned = text.replace(/\[\s*(?:link|url|đường dẫn)\s*\]/giu, "").replace(/ {2,}/g, " ").trim();
  return { text: cleaned, removed: cleaned !== text };
}

function normalizeMoneyTypography(text: string): string {
  return text.replace(
    /\b\d{1,3}(?:\.\s+\d{3}){1,2}(?=\s*(?:đ|vnđ|vnd)(?:$|[\s,.;:!?()]))/giu,
    (value) => value.replace(/\.\s+/g, "."),
  );
}

function formatVnd(value: number): string {
  return `${Math.round(value).toLocaleString("vi-VN")}đ`;
}

type ContextSection = { name: string; lines: string[] };

function parseContextSections(context: string): ContextSection[] {
  const sections: ContextSection[] = [];
  let current: ContextSection | null = null;
  for (const line of context.split(/\r?\n/)) {
    if (/^(LINK|CHÍNH SÁCH|ƯU ĐÃI)/iu.test(line.trim())) {
      if (current) sections.push(current);
      current = null;
      break;
    }
    const header = line.trim().match(/^\[([^\]]+)\](?:\s+\(.*\))?$/u);
    if (header && !/^[A-Z]{2,}[A-Z0-9]*-/i.test(header[1])) {
      if (current) sections.push(current);
      current = { name: header[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function canonicalStartingPrice(
  context: string,
  history: ConversationTurn[],
  customerMessage: string,
): { label: string; price: number } | null {
  const customerMessages = [
    customerMessage,
    ...[...history].reverse().filter((item) => item.direction === "incoming").map((item) => item.message),
  ];
  const targets = [
    { test: /\b(chup cong|cong cuoi)\b/, group: /chup cong/, label: "chụp cổng" },
    { test: /\b(beauty|cool boy|nang tho|chup ca nhan|thoi trang)\b/, group: /(beauty|thoi trang)/, label: "beauty" },
    { test: /\b(gia dinh|ca nha|family)\b/, group: /gia dinh/, label: "chụp gia đình" },
    { test: /\bngoai canh\b/, group: /album ngoai canh/, label: "album ngoại cảnh" },
    { test: /\b(tiec cuoi|phong su cuoi)\b/, group: /chup tiec cuoi/, label: "chụp tiệc cưới" },
    { test: /\b(quay phim|video|flycam)\b/, group: /quay phim/, label: "quay phim" },
  ];
  let target: (typeof targets)[number] | null = null;
  for (const raw of customerMessages) {
    const normalized = normalizeVi(raw);
    target = targets.find((item) => item.test.test(normalized)) ?? null;
    if (target) break;
    // A newer, unsupported/ambiguous service must stop lookup so an older service cannot leak forward.
    if (inferKnownIntent([], raw)) return null;
  }
  if (!target) return null;

  const section = parseContextSections(context).find((item) => target.group.test(normalizeVi(item.name)));
  if (!section) return null;
  const prices = extractMoneyValues(section.lines.join("\n"));
  if (prices.length === 0) return null;
  return { label: target.label, price: Math.min(...prices) };
}

function normalizeBroadPriceAnswer(
  text: string,
  context: string,
  history: ConversationTurn[],
  customerMessage: string,
): { text: string; normalized: boolean } {
  const customer = normalizeVi(customerMessage);
  const asksPrice = /\b(gia|bao nhieu|may tien|chi phi)\b/.test(customer);
  const asksFullList = /\b(bang gia|tat ca|cac goi|moi goi|tung goi|bao nhieu goi)\b/.test(customer);
  if (!asksPrice || asksFullList) return { text, normalized: false };

  const canonical = canonicalStartingPrice(context, history, customerMessage);
  if (!canonical) return { text, normalized: false };
  const claims = extractMoneyValues(text);
  if (claims.length === 1) return { text, normalized: false };

  return {
    text: `Dạ ${canonical.label} hiện có gói từ ${formatVnd(canonical.price)}. Mình ưu tiên ngân sách khoảng bao nhiêu để em chọn đúng một gói phù hợp ạ?`,
    normalized: true,
  };
}

function normalizeBudgetAnswer(
  text: string,
  context: string,
  history: ConversationTurn[],
  customerMessage: string,
): { text: string; normalized: boolean } {
  const customer = normalizeVi(customerMessage);
  if (!/\b(ngan sach (it|thap|han hep)|tiet kiem)\b/.test(customer)) return { text, normalized: false };
  const canonical = canonicalStartingPrice(context, history, customerMessage);
  if (!canonical || extractMoneyValues(text).length === 1) return { text, normalized: false };
  return {
    text: `Dạ ${canonical.label} có gói từ ${formatVnd(canonical.price)}; đây là lựa chọn tiết kiệm nhất trong nhóm hiện tại. Mình thích phong cách nhẹ nhàng tự nhiên hay sang trọng hơn ạ?`,
    normalized: true,
  };
}

function normalizeNoDiscountAnswer(
  text: string,
  context: string,
  customerMessage: string,
): { text: string; normalized: boolean } {
  const customer = normalizeVi(customerMessage);
  if (!/\b(giam gia|khuyen mai|uu dai|discount)\b/.test(customer)) return { text, normalized: false };
  const priceStart = context.indexOf(OFFICIAL_PRICING_MARKER);
  const linkStart = context.indexOf("\nLINK", priceStart);
  const officialCatalog = priceStart >= 0 ? context.slice(priceStart, linkStart >= 0 ? linkStart : undefined) : "";
  if (/⟹\s*ĐANG GIẢM|CHƯƠNG TRÌNH NHÓM/iu.test(officialCatalog)) return { text, normalized: false };
  return {
    text: "Dạ hiện em chưa thấy chương trình giảm nào đang bật trong bảng giá. Em gửi mình giá hiện tại trước nha.",
    normalized: true,
  };
}

function historyHasKnownDate(history: ConversationTurn[]): boolean {
  return history.some((h) => h.direction === "incoming" && (
    /\b\d{1,2}\s*[\/-]\s*\d{1,2}(?:\s*[\/-]\s*\d{2,4})?\b/.test(h.message)
    || /\bngày\s+\d{1,2}\b/iu.test(h.message)
    || /\b(thứ\s+(hai|ba|tư|năm|sáu|bảy)|chủ nhật)\b/iu.test(h.message)
  ));
}

function isDateQuestion(text: string): boolean {
  const t = normalizeVi(text);
  return /\b(ngay nao|khi nao|du dinh chup|chup khoang khi nao|thang may)\b/.test(t);
}

function removeRepeatedDateQuestion(text: string, history: ConversationTurn[]): { text: string; removed: boolean } {
  if (!historyHasKnownDate(history) || !isDateQuestion(text)) return { text, removed: false };
  const parts = text.split(/(?<=[.?!])\s+|\n+/).filter(Boolean);
  const kept = parts.filter((part) => !isDateQuestion(part));
  return {
    text: kept.join(" ").trim() || "Dạ em đã ghi nhận ngày mình nói rồi nha. Em sẽ bám theo ngày đó để tư vấn tiếp ạ.",
    removed: true,
  };
}

function removeSalesCliches(text: string): { text: string; removed: boolean } {
  let next = text;
  next = next.replace(/\b(?:là\s+)?(?:một\s+)?lựa chọn\s+(?:rất\s+)?(?:tuyệt vời|hoàn hảo)\b/giu, "phù hợp hơn");
  next = next.replace(/\brất\s+phù hợp\b/giu, "phù hợp");
  next = next.replace(/(?:^|(?<=[.!?])\s+)(?:Dạ[,\s]*)?(?:Tuyệt vời|Quá tuyệt|Chắc chắn rồi)[!.\s]*/giu, "");
  next = next.replace(/(?:^|(?<=[.!?])\s+)Em rất vui(?: khi| vì)?[^.!?]*[.!?]?/giu, "");
  next = next.replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return { text: next, removed: next !== text };
}

function questionKey(raw: string): string | null {
  const text = normalizeVi(raw);
  const patterns: Array<[string, RegExp]> = [
    ["sample_confirmation", /\bmau\b.{0,60}\b(hop gu|ung huong|ung mau|thich huong|on khong)\b/],
    ["style", /\b(thich huong|thich phong cach|thich tone|phong cach nao|huong nao|tone nao|nhe nhang hay|sang trong hon)\b/],
    ["service", /\b(can chup gi|dich vu nao|chup cong|album studio|album ngoai canh|tiec cuoi|beauty hay)\b.{0,24}\b(khong|nao|a)\b/],
    ["wedding_date", /\b(ngay cuoi|ngay duong lich|chup ngay nao|du dinh chup khi nao)\b/],
    ["bride_location", /\b(nha co dau|khu vuc co dau)\b/],
    ["groom_location", /\b(nha chu re|khu vuc chu re)\b/],
    ["venue_format", /\b(tiec tai nha hay nha hang|lam tai nha hay nha hang)\b/],
    ["table_count", /\b(bao nhieu ban|so ban du kien)\b/],
    ["participants", /\b(chup mot minh hay|chup ca nhan hay|cung gia dinh)\b/],
    ["budget", /\b(ngan sach|uu tien tiet kiem)\b/],
    ["booking_close", /\b(giu lich|chot lich|dat lich|dat coc|coc giu cho)\b/],
    ["more_samples", /\b(gui them|xem them|mau khac|hinh khac)\b/],
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function questionTokens(raw: string): Set<string> {
  const ignored = new Set(["da", "minh", "anh", "chi", "em", "a", "nha", "nhe", "khong", "co", "muon"]);
  return new Set(normalizeVi(raw).split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !ignored.has(token)));
}

function similarQuestion(a: string, b: string): boolean {
  const keyA = questionKey(a);
  const keyB = questionKey(b);
  if (keyA && keyA === keyB) return true;
  const left = questionTokens(a);
  const right = questionTokens(b);
  if (left.size < 3 || right.size < 3) return false;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size) >= 0.7;
}

function removeRepeatedQuestions(text: string, history: ConversationTurn[]): { text: string; removed: boolean } {
  const priorQuestions = history
    .filter((item) => item.direction === "outgoing" && !item.message.startsWith("[image:"))
    .flatMap((item) => item.message.split(/(?<=[.?!])\s+|\n+/).filter((part) => part.includes("?")))
    .slice(-12);
  if (priorQuestions.length === 0) return { text, removed: false };

  let removed = false;
  const parts = text.split(/(?<=[.?!])\s+|\n+/).filter(Boolean);
  const kept = parts.filter((part) => {
    if (!part.includes("?")) return true;
    if (!priorQuestions.some((prior) => similarQuestion(part, prior))) return true;
    removed = true;
    return false;
  });
  if (!removed) return { text, removed: false };
  return { text: kept.join(" ").trim() || "Em nhớ phần mình đã trao đổi rồi nha.", removed: true };
}

function removePrematureCloseQuestion(text: string, customerMessage: string): { text: string; removed: boolean } {
  const customer = normalizeVi(customerMessage);
  const customerAskedToBook = /\b(giu lich|chot lich|dat lich|dat coc|coc|con lich|lich trong)\b/.test(customer);
  if (customerAskedToBook) return { text, removed: false };

  let removed = false;
  const parts = text.split(/(?<=[.?!])\s+|\n+/).filter(Boolean);
  const kept = parts.filter((part) => {
    const normalized = normalizeVi(part);
    const pushesBooking = questionKey(part) === "booking_close"
      || /\b(neu dong y|neu minh ung|em co the|minh co the)\b.{0,40}\b(giu lich|chot lich|dat lich|dat coc)\b/.test(normalized);
    if (!pushesBooking) return true;
    removed = true;
    return false;
  });
  return { text: kept.join(" ").trim() || "Em đã ghi nhận nhu cầu của mình nha.", removed };
}

function removeQuestionsWhenWorkflowDoesNotNeedOne(text: string, context: string): { text: string; removed: boolean } {
  const recommendationOnly = /- Stage:\s*RECOMMEND_PACKAGE\b/i.test(context)
    && /- Action this turn:\s*CONTINUE_CONVERSATION\b/i.test(context);
  if (!recommendationOnly) return { text, removed: false };
  const parts = text.split(/(?<=[.?!])\s+|\n+/).filter(Boolean);
  const kept = parts.filter((part) => !part.includes("?"));
  const removed = kept.length !== parts.length;
  return { text: kept.join(" ").trim() || "Em đã ghi nhận lựa chọn của mình nha.", removed };
}

function removeRedundantIntentQuestion(
  text: string,
  history: ConversationTurn[],
  customerMessage: string,
): { text: string; removed: boolean } {
  const knownIntent = inferKnownIntent(history, customerMessage);
  if (!knownIntent) return { text, removed: false };
  const intentPattern: Record<NonNullable<typeof knownIntent>, RegExp> = {
    wedding_gate: /\b(chup cong|cong cuoi)\b/,
    wedding: /\b(chup cuoi|anh cuoi|album|ngoai canh|tiec cuoi|wedding)\b/,
    beauty: /\b(beauty|cool boy|nang tho|chup ca nhan|chup chan dung)\b/,
    rental: /\b(thue|vay cuoi|ao dai|vest|trang phuc)\b/,
    maternity: /\b(chup bau|anh bau|me bau|mang thai)\b/,
    family: /\b(chup gia dinh|anh gia dinh|ca nha|family)\b/,
  };
  const parts = text.split(/(?<=[.?!])\s+|\n+/).filter(Boolean);
  let removed = false;
  const kept = parts.filter((part) => {
    if (!part.includes("?")) return true;
    const normalized = normalizeVi(part);
    const repeatsIntent = intentPattern[knownIntent].test(normalized);
    const confirmsKnownFact = /\b(dung khong|phai khong|dung chu|co phai)\b/.test(normalized)
      || /\b(dang muon|muon|can)\b/.test(normalized);
    if (repeatsIntent && confirmsKnownFact) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return { text, removed: false };

  let next = kept.join(" ").trim();
  if (!next.includes("?")) {
    const followUp: Record<NonNullable<typeof knownIntent>, string> = {
      wedding_gate: "Mình thích tone nhẹ nhàng hiện đại hay sang trọng hơn ạ?",
      wedding: "Mình đang ưu tiên album studio, ngoại cảnh hay chụp tiệc ạ?",
      beauty: "Mình thích phong cách nhẹ nhàng, cá tính hay sang trọng hơn ạ?",
      rental: "Mình đang tìm kiểu váy hoặc trang phục theo phong cách nào ạ?",
      maternity: "Mình thích bộ ảnh nhẹ nhàng tự nhiên hay sang trọng hơn ạ?",
      family: "Mình dự định chụp khoảng bao nhiêu người ạ?",
    };
    next = `${next}${next ? " " : ""}${followUp[knownIntent]}`;
  }
  return { text: next, removed: true };
}

function limitQuestions(text: string): { text: string; limited: boolean } {
  let seen = 0;
  let limited = false;
  const parts = text.split(/(?<=[.?!])\s+|\n+/).filter(Boolean);
  const kept = parts.filter((part) => {
    const questions = (part.match(/\?/g) ?? []).length;
    if (questions === 0) return true;
    if (seen === 0) {
      seen += questions;
      if (questions > 1) {
        limited = true;
        const first = part.indexOf("?");
        return part.slice(0, first + 1);
      }
      return true;
    }
    limited = true;
    return false;
  });
  return { text: kept.join(" ").trim(), limited };
}

function quantityClaims(text: string): string[] {
  if (!/\b(gói|gồm|bao gồm|quyền lợi|tặng|phụ thu)\b/iu.test(text)) return [];
  const normalized = normalizeVi(text);
  const re = /\b(\d+)\s*(anh|tam|file|trang|gio|may|nguoi|vay|vest|ao dai|album|photobook)\b/g;
  return [...normalized.matchAll(re)].map((m) => `${m[1]}:${m[2]}`);
}

function packageScopedQuantityViolations(
  reply: string,
  context: string,
  knownIntent: ReturnType<typeof inferKnownIntent>,
): string[] {
  const claims = quantityClaims(reply);
  if (claims.length === 0 || !knownIntent) return [];
  const tier = normalizeVi(reply).match(/\b(basic|normal|standard|premium|luxury|silver|gold|diamond)\b/)?.[1];
  if (!tier) return [];
  const groupPattern: Partial<Record<NonNullable<typeof knownIntent>, RegExp>> = {
    wedding_gate: /chup cong/,
    beauty: /(beauty|thoi trang)/,
    family: /gia dinh/,
  };
  const matcher = groupPattern[knownIntent];
  if (!matcher) return [];
  const section = parseContextSections(context).find((item) => matcher.test(normalizeVi(item.name)));
  if (!section) return claims.map((claim) => `unverified_package_quantity:${claim}`);
  const packageLines = section.lines.filter((line) => new RegExp(`\\b${tier}\\b`).test(normalizeVi(line)));
  const allowed = new Set(quantityClaims(packageLines.join("\n")));
  return claims.filter((claim) => !allowed.has(claim)).map((claim) => `unverified_package_quantity:${claim}`);
}

function unsafeGroundingViolations(reply: string, context: string): string[] {
  const violations: string[] = [];
  const officialPricingAvailable = context.includes(OFFICIAL_PRICING_MARKER);
  const claimedMoney = extractMoneyValues(reply);
  const allowedMoney = new Set(extractMoneyValues(context));
  if (claimedMoney.length > 0 && !officialPricingAvailable) violations.push("pricing_context_unavailable");
  for (const value of claimedMoney) if (!allowedMoney.has(value)) violations.push(`unverified_money:${value}`);

  const claimedPercents = extractPercentValues(reply);
  const allowedPercents = new Set(extractPercentValues(context));
  for (const value of claimedPercents) if (!allowedPercents.has(value)) violations.push(`unverified_discount_percent:${value}`);

  const promoClaim = /(đang giảm|khuyến mãi|ưu đãi|giảm giá)/iu.test(reply);
  if (promoClaim && !context.includes("ĐANG GIẢM")) violations.push("inactive_or_unverified_promotion");

  const allowedQuantities = new Set(quantityClaims(context));
  for (const claim of quantityClaims(reply)) if (!allowedQuantities.has(claim)) violations.push(`unverified_package_quantity:${claim}`);

  return violations;
}

export function guardSaleResponse(input: {
  text: string;
  context: string;
  history: ConversationTurn[];
  customerMessage: string;
}): SaleResponseGuardResult {
  const address = inferCustomerAddress(input.history, input.customerMessage);
  let text = applyCustomerAddress(removeMarkdown(normalizeMoneyTypography(input.text)), address);
  const cliches = removeSalesCliches(text);
  text = cliches.text;
  const fakeLinks = removeFakeLinkPlaceholders(text);
  text = fakeLinks.text;
  const broadPrice = normalizeBroadPriceAnswer(text, input.context, input.history, input.customerMessage);
  text = broadPrice.text;
  const budget = normalizeBudgetAnswer(text, input.context, input.history, input.customerMessage);
  text = budget.text;
  const discount = normalizeNoDiscountAnswer(text, input.context, input.customerMessage);
  text = discount.text;
  const violations = unsafeGroundingViolations(text, input.context);
  if (cliches.removed) violations.push("sales_cliche_removed");
  if (broadPrice.normalized) violations.push("broad_price_answer_normalized");
  if (budget.normalized) violations.push("budget_answer_normalized");
  if (discount.normalized) violations.push("inactive_discount_answer_normalized");

  const knownIntent = inferKnownIntent(input.history, input.customerMessage);
  for (const drift of detectServiceDrift(text, knownIntent)) violations.push(`service_drift:${drift}`);
  violations.push(...packageScopedQuantityViolations(text, input.context, knownIntent));
  if (fakeLinks.removed) violations.push("fake_link_placeholder_removed");

  const repeated = removeRepeatedDateQuestion(text, input.history);
  text = repeated.text;
  if (repeated.removed) violations.push("repeated_date_question_removed");

  const redundantIntent = removeRedundantIntentQuestion(text, input.history, input.customerMessage);
  text = redundantIntent.text;
  if (redundantIntent.removed) violations.push("redundant_intent_question_removed");

  const repeatedQuestion = removeRepeatedQuestions(text, input.history);
  text = repeatedQuestion.text;
  if (repeatedQuestion.removed) violations.push("repeated_question_removed");

  const prematureClose = removePrematureCloseQuestion(text, input.customerMessage);
  text = prematureClose.text;
  if (prematureClose.removed) violations.push("premature_close_question_removed");

  const unnecessaryQuestion = removeQuestionsWhenWorkflowDoesNotNeedOne(text, input.context);
  text = unnecessaryQuestion.text;
  if (unnecessaryQuestion.removed) violations.push("unnecessary_question_removed");

  const limited = limitQuestions(text);
  text = limited.text;
  if (limited.limited) violations.push("excess_questions_removed");

  const blocking = violations.filter((v) =>
    v.startsWith("unverified_")
    || v === "pricing_context_unavailable"
    || v === "inactive_or_unverified_promotion"
    || v.startsWith("service_drift:"),
  );
  if (blocking.length > 0) {
    const safe = applyCustomerAddress(
      "Dạ phần thông tin này em chưa xác minh đủ từ hệ thống nên em không đoán ạ. Em chuyển nhân viên kiểm tra chính xác cho mình nha.",
      address,
    );
    return {
      text: safe,
      blocked: true,
      escalationReason: `Hậu kiểm Lulu chặn câu trả lời: ${blocking.join(", ")}`,
      violations: [...new Set(violations)],
      address,
    };
  }

  return {
    text,
    blocked: false,
    escalationReason: null,
    violations: [...new Set(violations)],
    address,
  };
}

export function containsMoneyClaim(text: string): boolean {
  MONEY_RE.lastIndex = 0;
  return MONEY_RE.test(text);
}
