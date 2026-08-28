import { pool } from "@workspace/db";
import { auditPackages, safePackageDescription, type AuditRow } from "./sale-context";
import { discountWindowStatus, resolveDiscount, type DiscountConfig } from "./pricing-discount";

export type SaleHistoryItem = { direction: "incoming" | "outgoing"; message: string; aiDecision?: string | null };
export type PriceResourceType = "price_sheet" | "portfolio_sample";

type ServiceGroupRow = {
  id: number;
  name: string;
  ai_image_url: string | null;
  public_for_customer: boolean;
  discount_enabled: boolean | null;
  discount_type: string | null;
  discount_value: string | null;
  discount_start_date: string | Date | null;
  discount_end_date: string | Date | null;
  discount_name: string | null;
  discount_description: string | null;
};

export type PriceSheetPackageTrace = {
  id: number;
  name: string;
  code: string | null;
  price: number;
  finalPrice: number;
  benefits: string;
};

export type PriceSheetTrace = {
  intent: "price_sheet";
  resourceType: "price_sheet";
  serviceKey: string | null;
  groupId: number | null;
  groupName: string | null;
  assetId: string | null;
  assetUrl: string | null;
  includedPackages: PriceSheetPackageTrace[];
  excludedPackages: Array<{ id: number; name: string; reason: string }>;
  discount: { status: string; name: string | null; type: string | null; value: number | null };
  actionOrder: string[];
  validator: { passed: boolean; reasons: string[] };
  /** Chỉ được gắn bởi Brain Lab. Production outbound vẫn dùng validator gốc. */
  deliveryMode?: "PRODUCTION_OUTBOUND" | "BRAIN_LAB_PREVIEW";
  simulationStatus?: "SIMULATED_PRICE_SHEET" | "PRICE_ASSET_MISSING" | null;
};

export type PriceSheetResolution = {
  requested: boolean;
  needsClarification: boolean;
  clarificationMessage: string | null;
  escalationReason: string | null;
  group: ServiceGroupRow | null;
  packages: AuditRow[];
  assetUrl: string | null;
  trace: PriceSheetTrace | null;
};

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

const PRICE_REQUEST_RE = /\b(bang gia|bao gia|xin gia|gui gia|cho xem gia|gia sao|gia the nao|gia nhieu|gia bao nhieu|bao nhieu(?: tien)?|chi phi|muc gia|gia goi|gia chup|gia thue)\b/i;

export function isPriceSheetRequest(message: string): boolean {
  const text = norm(message);
  if (!text) return false;
  if (text === "gia") return true;
  if (/\b(gia dinh|giam gia|uu dai|khuyen mai)\b/.test(text)) return false;
  return PRICE_REQUEST_RE.test(text)
    || /\b(?:cho|gui)\b.{0,24}\b(?:bang gia|gia)\b/.test(text)
    || /\bgia\b.{0,12}\b(?:sao|khong|di|nha|nhe)\b/.test(text);
}

const SERVICE_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "wedding_gate", re: /\b(chup cong|cong cuoi|hinh cong|anh cong|goi cong)\b/ },
  { key: "wedding_party", re: /\b(chup tiec|tiec cuoi|phong su|dai tiec)\b/ },
  { key: "album_outdoor", re: /\b(album ngoai canh|ngoai canh cuoi|chup cuoi ngoai canh)\b/ },
  { key: "album_studio", re: /\b(album tai studio|album studio|chup cuoi studio)\b/ },
  { key: "maternity", re: /\b(chup bau|me bau|mang thai|thai ky|maternity)\b/ },
  { key: "beauty", re: /\b(beauty|beaty|cool boy|cool girl|thoi trang|chan dung|ca nhan)\b/ },
  { key: "family", re: /\b(chup gia dinh|gia dinh)\b/ },
  // Chỉ đổi service khi khách gọi rõ dịch vụ makeup riêng. Từ "makeup" trần
  // thường chỉ là quyền lợi nằm trong gói Chụp cổng/Album và không được phép
  // làm mất current service.
  { key: "makeup", re: /\b(?:dich vu\s+)?(?:makeup|make up|trang diem)\s+(?:le|rieng|don le)\b|\b(?:thue|dat)\s+(?:makeup|make up|trang diem)\b/ },
  { key: "video", re: /\b(quay phim|quay phong su|flycam)\b/ },
  { key: "printing", re: /\b(in anh|in hinh)\b/ },
  { key: "rental_outfit", re: /\b(cho thue|thue vay|thue ao dai|thue vest|thue do)\b/ },
  { key: "wedding_album", re: /\b(album cuoi|chup cuoi|anh cuoi)\b/ },
  { key: "wedding_album", re: /\b(album)\b/ },
];

function serviceKeysInText(message: string): string[] {
  const text = norm(message);
  const keys = SERVICE_PATTERNS.filter((entry) => entry.re.test(text)).map((entry) => entry.key);
  if (keys.includes("maternity")) return ["maternity"];
  const specificAlbum = keys.find((key) => key === "album_studio" || key === "album_outdoor");
  if (specificAlbum) return [specificAlbum];
  if (keys.includes("wedding_gate")) return ["wedding_gate"];
  if (keys.includes("wedding_party")) return ["wedding_party"];
  return Array.from(new Set(keys));
}

export function resolveServiceKeyFromConversation(message: string, prior: SaleHistoryItem[]): { key: string | null; ambiguous: boolean } {
  const current = Array.from(new Set(serviceKeysInText(message)));
  if (current.length > 1) return { key: null, ambiguous: true };
  if (current.length === 1) return { key: current[0], ambiguous: false };

  // Lịch sử đã theo thứ tự thời gian. Quét ngược toàn bộ chuỗi để câu chung
  // như “giá sao?” bám dịch vụ được nhắc gần nhất, bất kể lượt đó là khách
  // hay Lulu xác nhận route. Không gom incoming/outgoing riêng vì sẽ làm một
  // dịch vụ cũ của khách lấn dịch vụ mới vừa được bot xác nhận.
  for (const item of [...prior].reverse()) {
    const keys = Array.from(new Set(serviceKeysInText(item.message)));
    if (keys.length === 1) return { key: keys[0], ambiguous: false };
    if (keys.length > 1) return { key: null, ambiguous: true };
  }
  return { key: null, ambiguous: false };
}

function groupMatchesService(groupName: string, serviceKey: string): boolean {
  const name = norm(groupName);
  switch (serviceKey) {
    case "wedding_gate": return name.includes("chup cong tai studio");
    case "wedding_party": return name === "chup tiec cuoi";
    case "album_outdoor": return name === "album ngoai canh";
    case "album_studio": return name === "album tai studio";
    case "beauty": return name.includes("beauty") || name.includes("beaty");
    case "family": return name === "chup gia dinh";
    case "makeup": return name === "makeup le";
    case "video": return name === "quay phim";
    case "printing": return name === "in anh";
    case "rental_outfit": return name === "cho thue trang phuc le";
    default: return false;
  }
}

function groupDiscount(group: ServiceGroupRow): DiscountConfig {
  return {
    enabled: group.discount_enabled,
    type: group.discount_type,
    value: group.discount_value,
    startDate: group.discount_start_date,
    endDate: group.discount_end_date,
    name: group.discount_name,
    description: group.discount_description,
  };
}

function packageDiscount(pkg: AuditRow): DiscountConfig {
  return {
    enabled: pkg.p_d_enabled,
    type: pkg.p_d_type,
    value: pkg.p_d_value,
    startDate: pkg.p_d_start,
    endDate: pkg.p_d_end,
    name: pkg.p_d_name,
    description: pkg.p_d_desc,
  };
}

function packageTrace(pkg: AuditRow, group: ServiceGroupRow): PriceSheetPackageTrace {
  const discount = resolveDiscount({ basePrice: pkg.price, pkg: packageDiscount(pkg), group: groupDiscount(group) });
  return {
    id: pkg.id,
    name: pkg.pkg_name.trim(),
    code: (pkg.code ?? "").trim() || null,
    price: Number(pkg.price),
    finalPrice: discount.finalPrice,
    benefits: safePackageDescription(pkg.pkg_name, pkg.description),
  };
}

export function validatePriceSheetData(input: {
  groupId: number | null;
  assetGroupId: number | null;
  assetUrl: string | null;
  publicForCustomer: boolean;
  resourceType: PriceResourceType;
  packageGroupIds: number[];
}): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.groupId) reasons.push("service_group_unresolved");
  if (input.resourceType !== "price_sheet") reasons.push("resource_type_mismatch");
  if (!input.assetUrl?.trim()) reasons.push("price_sheet_missing");
  if (input.assetUrl?.trim() && !(/^(https?:\/\/|\/objects\/|\/public-objects\/|\/uploads\/)/i.test(input.assetUrl.trim()))) {
    reasons.push("price_sheet_asset_not_official_storage");
  }
  if (!input.publicForCustomer) reasons.push("price_sheet_not_public");
  if (input.groupId && input.assetGroupId !== input.groupId) reasons.push("price_sheet_group_mismatch");
  if (input.groupId && input.packageGroupIds.some((id) => id !== input.groupId)) reasons.push("package_group_mismatch");
  if (input.packageGroupIds.length === 0) reasons.push("no_retail_packages");
  return { passed: reasons.length === 0, reasons };
}

export async function resolvePriceSheetRequest(input: {
  message: string;
  prior?: SaleHistoryItem[];
  force?: boolean;
  serviceKey?: string | null;
}): Promise<PriceSheetResolution> {
  if (!input.force && !isPriceSheetRequest(input.message)) {
    return { requested: false, needsClarification: false, clarificationMessage: null, escalationReason: null, group: null, packages: [], assetUrl: null, trace: null };
  }

  const service = input.serviceKey
    ? { key: input.serviceKey, ambiguous: false }
    : resolveServiceKeyFromConversation(input.message, input.prior ?? []);
  if (!service.key || service.ambiguous || service.key === "wedding_album") {
    const reason = service.ambiguous ? "multiple_services_requested" : "service_group_unresolved";
    return {
      requested: true,
      needsClarification: true,
      clarificationMessage: "Mình muốn xem bảng giá dịch vụ nào ạ: chụp cổng, album studio, ngoại cảnh, tiệc cưới hay beauty?",
      escalationReason: null,
      group: null,
      packages: [],
      assetUrl: null,
      trace: {
        intent: "price_sheet", resourceType: "price_sheet", serviceKey: service.key,
        groupId: null, groupName: null, assetId: null, assetUrl: null,
        includedPackages: [], excludedPackages: [],
        discount: { status: "unknown", name: null, type: null, value: null },
        actionOrder: ["ask_clarification"], validator: { passed: false, reasons: [reason] },
      },
    };
  }

  const [groupsRes, audit] = await Promise.all([
    pool.query(
      `SELECT id, name, ai_image_url, public_for_customer,
              discount_enabled, discount_type, discount_value, discount_start_date, discount_end_date,
              discount_name, discount_description
       FROM service_groups WHERE is_active = 1 ORDER BY sort_order, id`,
    ),
    auditPackages(),
  ]);
  const groups = groupsRes.rows as ServiceGroupRow[];
  const matches = groups.filter((group) => groupMatchesService(group.name, service.key as string));
  const group = matches.length === 1 ? matches[0] : null;
  const included = group ? audit.kept.filter((pkg) => pkg.group_id === group.id) : [];
  const excluded = group ? audit.excluded.filter((pkg) => pkg.group_id === group.id) : [];
  const assetUrl = group?.ai_image_url?.trim() || null;
  const validator = validatePriceSheetData({
    groupId: group?.id ?? null,
    assetGroupId: group?.id ?? null,
    assetUrl,
    publicForCustomer: !!group?.public_for_customer,
    resourceType: "price_sheet",
    packageGroupIds: included.map((pkg) => pkg.group_id),
  });
  const discountStatus = group ? discountWindowStatus(groupDiscount(group)) : "unknown";
  const trace: PriceSheetTrace = {
    intent: "price_sheet",
    resourceType: "price_sheet",
    serviceKey: service.key,
    groupId: group?.id ?? null,
    groupName: group?.name ?? null,
    assetId: group ? `service_groups:${group.id}:ai_image_url` : null,
    assetUrl,
    includedPackages: group ? included.map((pkg) => packageTrace(pkg, group)) : [],
    excludedPackages: excluded.map((pkg) => ({ id: pkg.id, name: pkg.pkg_name.trim(), reason: pkg.reason })),
    discount: {
      status: discountStatus,
      name: group?.discount_name ?? null,
      type: group?.discount_type ?? null,
      value: group?.discount_value == null ? null : Number(group.discount_value),
    },
    actionOrder: validator.passed ? ["send_price_sheet", "send_text"] : ["block", "escalate"],
    validator,
  };

  return {
    requested: true,
    needsClarification: false,
    clarificationMessage: null,
    escalationReason: validator.passed ? null : `Không thể xác minh bảng giá ${group?.name ?? service.key}: ${validator.reasons.join(", ")}`,
    group,
    packages: included,
    assetUrl,
    trace,
  };
}

function formatVnd(value: number): string {
  return Math.round(value).toLocaleString("vi-VN") + "đ";
}

function titleCaseIfShouted(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  const words = trimmed.split(/\s+/).filter(Boolean);
  const uppercaseWords = words.filter((word) => {
    const wordLetters = word.replace(/[^\p{L}]/gu, "");
    return wordLetters.length >= 2 && wordLetters === wordLetters.toLocaleUpperCase("vi-VN");
  });
  if (letters.length < 4 || (letters !== letters.toLocaleUpperCase("vi-VN") && uppercaseWords.length / Math.max(words.length, 1) < 0.6)) return trimmed;
  return trimmed.toLocaleLowerCase("vi-VN").replace(/(^|[\s\-–/])\p{L}/gu, (letter) => letter.toLocaleUpperCase("vi-VN"));
}

function sentenceCaseIfShouted(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  const words = trimmed.split(/\s+/).filter(Boolean);
  const uppercaseWords = words.filter((word) => {
    const wordLetters = word.replace(/[^\p{L}]/gu, "");
    return wordLetters.length >= 2 && wordLetters === wordLetters.toLocaleUpperCase("vi-VN");
  });
  if (letters.length < 4 || (letters !== letters.toLocaleUpperCase("vi-VN") && uppercaseWords.length / Math.max(words.length, 1) < 0.6)) return trimmed;
  const lowered = trimmed.toLocaleLowerCase("vi-VN");
  return lowered.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("vi-VN"));
}

function collapseDuplicateWords(text: string): string {
  const words = text.trim().split(/\s+/);
  const compact: string[] = [];
  for (const word of words) {
    if (norm(word) && norm(word) === norm(compact[compact.length - 1])) continue;
    compact.push(word);
  }
  for (let size = Math.floor(compact.length / 2); size >= 1; size--) {
    const left = compact.slice(0, size).map(norm).join(" ");
    const right = compact.slice(size, size * 2).map(norm).join(" ");
    if (left && left === right) return [...compact.slice(0, size), ...compact.slice(size * 2)].join(" ");
  }
  return compact.join(" ");
}

function cleanPackageLabel(name: string): string {
  return titleCaseIfShouted(collapseDuplicateWords(name));
}

const BENEFIT_LABEL_RE = /\b(?:bao\s+g(?:ồm|om)|g(?:ồm|om)|quyền\s+lợi|quyen\s+loi)\b\s*:?\s*/gi;

function cleanBenefitText(value: string): string {
  const cleaned = collapseDuplicateWords(value
    .replace(BENEFIT_LABEL_RE, "")
    .replace(/[,:;\-\s]+$/, "")
    .replace(/^[\s•*\-–:;]+/, "")
    .replace(/\s+/g, " ")
    .trim())
    .replace(/^gói\s+([^\s:]+)\s+gói\s*:/i, "Gói $1:")
    .replace(/^g(?:ói|oi)\s+(?:basic|premium|luxury|tiết kiệm|tiet kiem)\s*:\s*/i, "");
  return sentenceCaseIfShouted(cleaned);
}

function packageHighlights(pkg: PriceSheetPackageTrace): string[] {
  const source = (pkg.benefits ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[•*▪►➤]+/g, "\n")
    .replace(/\s*⸻\s*trang\s*phục\s*(?:&|và)\s*makeup\s*:?\s*/gi, "\n")
    .replace(/\s+sản\s*phẩm\s*:?\s*/gi, "\n")
    .replace(BENEFIT_LABEL_RE, "\n");
  const segments = source
    .split(/\n+|;|(?<=[.!?])\s+/)
    .flatMap((segment) => segment.split(/,(?=\s*(?:\d|có\b|tặng\b|photo\b|makeup\b|trang phục\b|ảnh\b|album\b))/i))
    .map(cleanBenefitText)
    .filter((segment) => segment.length >= 3);
  const seen = new Set<string>();
  const packageName = norm(pkg.name);
  return segments.filter((segment) => {
    const key = norm(segment);
    if (!key || key === packageName || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

type ComparablePackageFacts = {
  gateCount: number | null;
  gateMaterial: string | null;
  smallPrintCount: number | null;
  smallPrintSize: string | null;
  smallPrintFramed: boolean | null;
  photoLevel: "Master" | "chuyên viên" | null;
  makeupLevel: "Master" | "chuyên viên" | null;
  outfits: string | null;
};

function comparableFacts(pkg: PriceSheetPackageTrace): ComparablePackageFacts {
  const text = norm(pkg.benefits);
  const gateCount = Number(text.match(/\b([12])\s+(?:hinh|anh|tam)\s+cong\b/)?.[1] ?? 0) || null;
  const small = text.match(/\b(\d+)\s+(?:hinh|anh)\s+(?:nho|khung|ban)?\s*(\d{2})\s*[xX]\s*(\d{2})/i);
  const outfits = pkg.benefits.match(/\b\d+\s+(?:saree?|soiree?|soire|váy|vay)(?:\s*\+\s*\d+\s+(?:áo\s+)?vest)?/i)?.[0] ?? null;
  return {
    gateCount,
    gateMaterial: /mica guong/.test(text) ? "mica gương" : /(ep go|in lua)/.test(text) ? "ép gỗ/in lụa" : null,
    smallPrintCount: small ? Number(small[1]) : null,
    smallPrintSize: small ? `${small[2]}x${small[3]}cm` : null,
    smallPrintFramed: /(?:co khung|có khung)/i.test(pkg.benefits) ? true : /(?:chua khung|không khung|khong khung)/i.test(pkg.benefits) ? false : null,
    photoLevel: /photo master/.test(text) ? "Master" : /photo chuyen vien/.test(text) ? "chuyên viên" : null,
    makeupLevel: /make ?up master/.test(text) ? "Master" : /make ?up chuyen vien/.test(text) ? "chuyên viên" : null,
    outfits,
  };
}

function packageAlias(pkg: PriceSheetPackageTrace): string {
  const text = norm(`${pkg.name} ${pkg.code ?? ""}`);
  if (text.includes("tiet kiem") || pkg.finalPrice === 1_900_000) return "Tiết kiệm";
  if (text.includes("basic") || pkg.finalPrice === 2_900_000) return "Basic";
  if (text.includes("premium") || pkg.finalPrice === 3_900_000) return "Premium";
  if (text.includes("luxury") || pkg.finalPrice === 5_900_000) return "Luxury";
  return cleanPackageLabel(pkg.name);
}

function packagesMentioned(message: string, packages: PriceSheetPackageTrace[]): PriceSheetPackageTrace[] {
  const text = norm(message);
  const aliases: Array<[RegExp, string]> = [
    [/\b(?:tiet kiem|1[.,]9|1900000)\b/, "Tiết kiệm"],
    [/\b(?:basic|2[.,]9|2900000)\b/, "Basic"],
    [/\b(?:premium|3[.,]9|3900000)\b/, "Premium"],
    [/\b(?:luxury|5[.,]9|5900000)\b/, "Luxury"],
  ];
  if (/goi thap nhat/.test(text) && /goi cao nhat/.test(text)) return [packages[0], packages[packages.length - 1]].filter(Boolean);
  return aliases.flatMap(([re, alias]) => re.test(text) ? packages.filter((pkg) => packageAlias(pkg) === alias) : []);
}

function comparisonDelta(lower: PriceSheetPackageTrace, higher: PriceSheetPackageTrace): string[] {
  const a = comparableFacts(lower);
  const b = comparableFacts(higher);
  const changes: string[] = [];
  if (a.outfits && b.outfits && norm(a.outfits) !== norm(b.outfits)) changes.push(`trang phục từ ${a.outfits} lên ${b.outfits}`);
  if (a.gateCount !== b.gateCount || a.gateMaterial !== b.gateMaterial) {
    const before = [a.gateCount ? `${a.gateCount} cổng` : null, a.gateMaterial].filter(Boolean).join(" ");
    const after = [b.gateCount ? `${b.gateCount} cổng` : null, b.gateMaterial].filter(Boolean).join(" ");
    if (before && after) changes.push(`phần cổng từ ${before} lên ${after}`);
  }
  if (a.photoLevel && b.photoLevel && a.photoLevel !== b.photoLevel) changes.push(`Photo từ ${a.photoLevel} lên ${b.photoLevel}`);
  if (a.makeupLevel && b.makeupLevel && a.makeupLevel !== b.makeupLevel) changes.push(`Makeup từ ${a.makeupLevel} lên ${b.makeupLevel}`);
  if (a.smallPrintCount !== b.smallPrintCount || a.smallPrintSize !== b.smallPrintSize || a.smallPrintFramed !== b.smallPrintFramed) {
    const before = [a.smallPrintCount ? `${a.smallPrintCount} ảnh nhỏ` : null, a.smallPrintSize, a.smallPrintFramed === true ? "có khung" : a.smallPrintFramed === false ? "chưa khung" : null].filter(Boolean).join(" ");
    const after = [b.smallPrintCount ? `${b.smallPrintCount} ảnh nhỏ` : null, b.smallPrintSize, b.smallPrintFramed === true ? "có khung" : b.smallPrintFramed === false ? "chưa khung" : null].filter(Boolean).join(" ");
    if (before && after) changes.push(`sản phẩm phụ từ ${before} lên ${after}`);
  }
  return changes;
}

function recentCustomerContext(prior: SaleHistoryItem[]): string {
  return norm(prior.filter((item) => item.direction === "incoming").slice(-8).map((item) => item.message).join(" "));
}

/** So sánh package từ snapshot DB đã xác minh; không đọc lại catalogue và không mặc định upsell. */
export function buildPackageComparisonReply(
  resolution: PriceSheetResolution,
  customerMessage: string,
  prior: SaleHistoryItem[] = [],
): string {
  const packages = [...(resolution.trace?.includedPackages ?? [])].sort((a, b) => a.finalPrice - b.finalPrice);
  if (packages.length < 2) return "Dạ em chưa đủ dữ liệu package đã xác minh để so chính xác, em chuyển nhân viên kiểm tra giúp mình nha.";
  const text = norm(customerMessage);
  const context = `${recentCustomerContext(prior)} ${text}`;
  let mentioned = packagesMentioned(customerMessage, packages);
  if (mentioned.length < 2 && /(?:them|chenh)\s+\d/.test(text)) {
    const current = packagesMentioned(recentCustomerContext(prior), packages).at(-1) ?? packages[0];
    const index = packages.findIndex((pkg) => pkg.id === current.id);
    if (index >= 0 && packages[index + 1]) mentioned = [current, packages[index + 1]];
  }
  if (mentioned.length >= 2) {
    const [lower, higher] = mentioned.slice(0, 2).sort((a, b) => a.finalPrice - b.finalPrice);
    const difference = higher.finalPrice - lower.finalPrice;
    const changes = comparisonDelta(lower, higher);
    const higherFacts = comparableFacts(higher);
    const lowerFacts = comparableFacts(lower);
    const needsTwoMica = /(?:hai|2)\s+cong|mica/.test(context);
    const needsMaster = /master|ekip|tho chup|makeup/.test(context);
    const lowerMeetsTwoMica = (lowerFacts.gateCount ?? 0) >= 2 && lowerFacts.gateMaterial === "mica gương";
    const higherMeetsTwoMica = (higherFacts.gateCount ?? 0) >= 2 && higherFacts.gateMaterial === "mica gương";
    const lowerMeetsMaster = lowerFacts.photoLevel === "Master" || lowerFacts.makeupLevel === "Master";
    const higherMeetsMaster = higherFacts.photoLevel === "Master" || higherFacts.makeupLevel === "Master";
    const recommendHigher = (needsTwoMica && !lowerMeetsTwoMica && higherMeetsTwoMica)
      || (needsMaster && !lowerMeetsMaster && higherMeetsMaster);
    const lowerAlreadyFits = (needsTwoMica && lowerMeetsTwoMica) || (needsMaster && lowerMeetsMaster);
    const lowerEnough = /(?:mot|1)\s+cong|don gian|tiet kiem/.test(context)
      && (lowerFacts.gateCount ?? 1) <= 1;
    const recommendation = recommendHigher
      ? `Với nhu cầu mình đã nói, em nghiêng ${packageAlias(higher)} vì mình dùng đúng phần quyền lợi tăng thêm.`
      : lowerAlreadyFits
        ? `${packageAlias(lower)} đã đáp ứng đúng phần mình cần rồi, không nhất thiết nâng lên ${packageAlias(higher)} để dư quyền lợi nha 😄`
      : lowerEnough
        ? `Nhu cầu mình đang gọn thì ${packageAlias(lower)} đã vừa đẹp, không cần nâng chỉ để dư quyền lợi nha 😄`
        : `Nếu mình dùng đúng các phần tăng thêm thì ${packageAlias(higher)} đáng cân; còn không thì ${packageAlias(lower)} vẫn rất ổn.`;
    return `Dạ ${packageAlias(lower)} ${formatVnd(lower.finalPrice)} lên ${packageAlias(higher)} ${formatVnd(higher.finalPrice)} chênh ${formatVnd(difference)} nha mình. ${changes.length ? `Phần chênh nằm ở ${changes.slice(0, 3).join(", ")}.` : "Em chỉ đối chiếu những quyền lợi đang có trong package hiện hành."} ${recommendation}`;
  }
  const oneGate = /(?:mot|1)\s+cong/.test(context);
  const twoGates = /(?:hai|2)\s+cong/.test(context);
  const wantsMica = /mica/.test(context);
  const prioritizesTeam = /(?:uu tien|quan trong).{0,20}(?:ekip|tho chup|makeup)|master/.test(context);
  const prioritizesProducts = /(?:uu tien|quan trong).{0,20}(?:san pham|anh cong)/.test(context);
  const budget = Number(text.match(/(?:toi da|khoang|tam)\s*(\d+(?:[.,]\d+)?)\s*(?:trieu|tr)/)?.[1]?.replace(",", ".") ?? 0) * 1_000_000;
  const affordable = budget ? packages.filter((pkg) => pkg.finalPrice <= budget) : packages;
  let recommendation = affordable[0] ?? packages[0];
  if (prioritizesTeam) recommendation = [...affordable].reverse().find((pkg) => {
    const facts = comparableFacts(pkg); return facts.photoLevel === "Master" || facts.makeupLevel === "Master";
  }) ?? affordable.at(-1) ?? recommendation;
  else if (twoGates || wantsMica || prioritizesProducts) recommendation = affordable.find((pkg) => {
    const facts = comparableFacts(pkg); return (facts.gateCount ?? 0) >= 2 && (!wantsMica || facts.gateMaterial === "mica gương");
  }) ?? affordable.at(-1) ?? recommendation;
  else if (oneGate) recommendation = affordable.find((pkg) => (comparableFacts(pkg).gateCount ?? 1) === 1) ?? recommendation;
  else recommendation = affordable[Math.min(1, affordable.length - 1)] ?? recommendation;
  if (/nhieu nguoi chon/.test(text)) return `Dạ em không nói đại gói nào nhiều người chọn nhất khi chưa có số booking xác minh nha 😄 Theo nhu cầu hiện tại, em nghiêng ${packageAlias(recommendation)} ở mức ${formatVnd(recommendation.finalPrice)}.`;
  if (/doc bang/.test(text)) return "Dạ để em nói kiểu dễ hiểu nha 😄 Các gói khác nhau chủ yếu ở trang phục, số/chất liệu cổng, sản phẩm đi kèm và cấp ekip. Mình đang ngắm hai gói nào, em bóc đúng phần chênh trong vài dòng thôi.";
  return `Dạ theo nhu cầu mình đã nói, em nghiêng ${packageAlias(recommendation)} ở mức ${formatVnd(recommendation.finalPrice)} nha. Đây là gói dùng đúng quyền lợi mình cần; không nhất thiết lấy gói cao nhất mới là tốt nhất 😄`;
}

export function hasVerifiedPackageData(resolution: PriceSheetResolution): boolean {
  const trace = resolution.trace;
  if (!resolution.group || !trace || trace.includedPackages.length === 0) return false;
  const unsafeReasons = trace.validator.reasons.filter((reason) => ![
    "price_sheet_missing",
    "price_sheet_asset_not_official_storage",
    "price_sheet_not_public",
  ].includes(reason));
  return unsafeReasons.length === 0;
}

export function buildPriceSheetReply(
  resolution: PriceSheetResolution,
  customerMessage = "",
  options: { allowPackageCardFallback?: boolean } = {},
): string[] {
  const packageFallback = options.allowPackageCardFallback && hasVerifiedPackageData(resolution);
  if (!resolution.group || !resolution.trace || (!resolution.trace.validator.passed && !packageFallback)) return [];
  const packages = resolution.trace.includedPackages;
  const blocks = packages.map((pkg) => {
    const price = pkg.finalPrice < pkg.price
      ? `${formatVnd(pkg.finalPrice)} (giá gốc ${formatVnd(pkg.price)})`
      : formatVnd(pkg.price);
    const highlights = packageHighlights(pkg);
    const body = highlights.length > 0
      ? `\n${highlights.map((highlight) => `• ${highlight}`).join("\n")}`
      : "\n• Quyền lợi chi tiết theo ảnh bảng giá chính thức.";
    return `${cleanPackageLabel(pkg.name)} – ${price}${body}`;
  });
  const normalizedMessage = norm(customerMessage);
  const recommendation = /\b(tiet kiem|ngan sach it|gia mem)\b/.test(normalizedMessage)
    ? packages[0]
    : packages[Math.min(1, packages.length - 1)] ?? packages[0];
  const recommendationText = recommendation
    ? `Nếu mình chưa có yêu cầu đặc biệt, em đề xuất ${cleanPackageLabel(recommendation.name)} ở mức ${formatVnd(recommendation.finalPrice)} để cân bằng chi phí và sản phẩm.`
    : "";
  if (resolution.trace.serviceKey === "wedding_gate") {
    // Ảnh bảng giá luôn được gửi trước bởi sale-brain-runner. Phần chữ chỉ tóm
    // tắt đúng trọng tâm, không lặp lại cả catalogue dài bên dưới ảnh.
    const concise = packages.map((pkg) => {
      const price = pkg.finalPrice < pkg.price
        ? `${formatVnd(pkg.finalPrice)} (gốc ${formatVnd(pkg.price)})`
        : formatVnd(pkg.price);
      const highlight = packageHighlights(pkg)[0];
      return `• ${packageAlias(pkg)} – ${price}${highlight ? `: ${highlight}` : ""}`;
    });
    return [
      `Dạ em gửi bảng Chụp cổng bên em nha 😄\n${concise.join("\n")}\nMỗi gói tăng dần ở phần trang phục, sản phẩm và ekip. Mình đang nhắm khoảng ngân sách nào, em chỉ đúng gói đáng xem nhất cho mình nha?`,
    ];
  }
  return [
    `Dạ, ${titleCaseIfShouted(resolution.group.name)} hiện có các gói bán lẻ sau nha:\n\n${blocks.join("\n\n")}\n\n${recommendationText}\n\nMình ưu tiên tiết kiệm hay muốn hình ảnh chỉn chu hơn để em tư vấn sát hơn nha?`,
  ];
}

export function buildPackageDetailReply(
  resolution: PriceSheetResolution,
  customerMessage: string,
): string {
  if (!hasVerifiedPackageData(resolution)) {
    return "Dạ em chưa đủ dữ liệu package đã xác minh để giải thích chính xác, em nhờ nhân viên kiểm tra giúp mình nha.";
  }
  const packages = resolution.trace?.includedPackages ?? [];
  const selected = packagesMentioned(customerMessage, packages)[0]
    ?? decisionPackageByAlias(customerMessage, packages);
  if (!selected) {
    return "Dạ mình đang hỏi gói Tiết kiệm, Basic, Premium hay Luxury ạ? Em giải thích đúng gói cho mình nha.";
  }
  const price = formatVnd(selected.finalPrice);
  const highlights = packageHighlights(selected).slice(0, 3);
  const detail = highlights.length ? ` ${highlights.join("; ")}.` : "";
  return `Dạ ${packageAlias(selected)} hiện là ${price} nha mình.${detail} Mình muốn em nói kỹ thêm phần nào của gói này ạ?`;
}

function decisionPackageByAlias(message: string, packages: PriceSheetPackageTrace[]): PriceSheetPackageTrace | null {
  const text = norm(message);
  const alias = /\btiet kiem\b/.test(text) ? "Tiết kiệm"
    : /\bbasic\b/.test(text) ? "Basic"
      : /\bpremium\b/.test(text) ? "Premium"
        : /\bluxury\b/.test(text) ? "Luxury"
          : null;
  return alias ? packages.find((pkg) => packageAlias(pkg) === alias) ?? null : null;
}

export function buildPriceSheetAiBlock(resolution: PriceSheetResolution): string {
  if (!resolution.group || !resolution.trace?.validator.passed) return "";
  const packages = resolution.trace.includedPackages.map((pkg) => ({
    id: pkg.id,
    code: pkg.code,
    name: pkg.name,
    basePrice: pkg.price,
    finalPrice: pkg.finalPrice,
    benefits: pkg.benefits,
  }));
  return `DỮ LIỆU BÁO GIÁ ĐÃ ĐƯỢC BACKEND XÁC MINH:
- Nhóm: ${resolution.group.name} (id=${resolution.group.id})
- Ảnh bảng giá chính thức đã được backend gửi thành công trước phần chữ.
- Các gói bán lẻ phải giải thích đầy đủ: ${JSON.stringify(packages)}
- Trạng thái giảm giá cấp nhóm: ${resolution.trace.discount.status}

Nhiệm vụ diễn đạt:
- Giải thích TẤT CẢ gói trên bằng tiếng Việt tự nhiên, đúng giá và quyền lợi; không thêm gói khác.
- So sánh khác biệt quan trọng giữa các gói dựa trên dữ liệu có thật.
- Dựa vào slot discovery trong WORKFLOW SALE để đề xuất đúng một gói phù hợp nhất và nói ngắn gọn lý do.
- Tối đa một câu hỏi tiếp theo để chốt/tư vấn.
- Không chào lại, không nói đang gửi/sẽ gửi ảnh, không đặt marker <<PRICE_IMAGE>> hoặc <<SAMPLE>>.`;
}

export function priceExplanationCoversPackages(text: string, resolution: PriceSheetResolution): boolean {
  const trace = resolution.trace;
  if (!trace?.validator.passed || trace.includedPackages.length === 0) return false;
  const normalized = norm(text);
  return trace.includedPackages.every((pkg) => {
    const price = formatVnd(pkg.finalPrice).replace(/\D/g, "");
    const digits = text.replace(/\D/g, "");
    const nameTokens = norm(pkg.name).split(" ").filter((token) => token.length >= 4);
    return digits.includes(price) && nameTokens.some((token) => normalized.includes(token));
  });
}

export const PRICE_SHEET_SEND_FAILED_MESSAGE =
  "Hiện em chưa gửi được ảnh bảng giá chính thức nên em chưa báo giá bằng chữ để tránh sai thông tin. Em chuyển nhân viên kiểm tra và gửi lại cho mình ngay ạ.";
