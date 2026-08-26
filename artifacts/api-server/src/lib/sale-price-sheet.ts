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
  { key: "wedding_gate", re: /\b(chup cong|cong cuoi|hinh cong|anh cong)\b/ },
  { key: "wedding_party", re: /\b(chup tiec|tiec cuoi|phong su|dai tiec)\b/ },
  { key: "album_outdoor", re: /\b(album ngoai canh|ngoai canh cuoi|chup cuoi ngoai canh)\b/ },
  { key: "album_studio", re: /\b(album tai studio|album studio|chup cuoi studio)\b/ },
  { key: "maternity", re: /\b(chup bau|me bau|mang thai|thai ky|maternity)\b/ },
  { key: "beauty", re: /\b(beauty|beaty|cool boy|cool girl|thoi trang|chan dung|ca nhan)\b/ },
  { key: "family", re: /\b(chup gia dinh|gia dinh)\b/ },
  { key: "makeup", re: /\b(makeup|make up|trang diem)\b/ },
  { key: "video", re: /\b(quay phim|quay phong su|flycam)\b/ },
  { key: "printing", re: /\b(in anh|in hinh)\b/ },
  { key: "rental_outfit", re: /\b(cho thue|thue vay|thue ao dai|thue vest|thue do)\b/ },
  { key: "wedding_album", re: /\b(album cuoi|chup cuoi|anh cuoi)\b/ },
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

  const incoming = prior.filter((item) => item.direction === "incoming").reverse();
  const outgoing = prior.filter((item) => item.direction === "outgoing").reverse();
  for (const item of [...incoming, ...outgoing]) {
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

export function buildPriceSheetReply(resolution: PriceSheetResolution, customerMessage = ""): string[] {
  if (!resolution.group || !resolution.trace?.validator.passed) return [];
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
    return [
      `Dạ em gửi mình bảng giá chụp cổng hiện tại nha.\n\nBên em đang có các gói dành cho khách lẻ:\n\n${blocks.join("\n\n")}\n\nMỗi gói sẽ khác nhau về số lượng ảnh cổng, trang phục, makeup và sản phẩm đi kèm. Mình cần một cổng hay hai cổng để em chọn giúp mình gói vừa đủ nhất nha?`,
    ];
  }
  return [
    `Dạ, ${titleCaseIfShouted(resolution.group.name)} hiện có các gói bán lẻ sau nha:\n\n${blocks.join("\n\n")}\n\n${recommendationText}\n\nMình ưu tiên tiết kiệm hay muốn hình ảnh chỉn chu hơn để em tư vấn sát hơn nha?`,
  ];
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
