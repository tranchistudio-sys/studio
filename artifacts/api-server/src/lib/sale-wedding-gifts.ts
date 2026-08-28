import { pool } from "@workspace/db";
import type { SaleHistoryItem } from "./sale-price-sheet";

export type WeddingGiftOption = { id: number; name: string; description: string | null };
export type WeddingGiftTier = {
  id: number;
  minimumServiceCount: number;
  name: string;
  chooseCount: number;
  options: WeddingGiftOption[];
};
export type WeddingGiftProgramConfig = {
  id: number | null;
  name: string;
  enabled: boolean;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  eligibleServiceKeys: string[];
  eligibleGroupIds: number[];
  tiers: WeddingGiftTier[];
  accumulationPolicy: "highest_tier_only";
  source: "database" | "structured_template_pending_migration" | "database_not_configured";
};

export type WeddingGiftTrace = {
  programId: number | null;
  programName: string;
  programStatus: "active" | "disabled" | "not_started" | "expired" | "not_configured";
  promotionSource: WeddingGiftProgramConfig["source"];
  interestedWeddingServices: string[];
  confirmedWeddingServices: string[];
  eligibleServiceCount: number;
  giftTier: number | null;
  giftTierName: string | null;
  chooseCount: number | null;
  giftOptions: WeddingGiftOption[];
  packagesExplained: boolean;
  action: "none" | "wait_until_after_quote" | "upsell_second_service" | "introduce_gift_tier";
  reason: string;
};

const TEMPLATE_TIERS: WeddingGiftTier[] = [
  {
    id: -2,
    minimumServiceCount: 2,
    name: "Mốc 2 dịch vụ cưới",
    chooseCount: 1,
    options: [
      { id: -21, name: "10 khung hình mica để bàn", description: null },
      { id: -22, name: "2 tranh cao cấp 60 × 90cm", description: null },
    ],
  },
  {
    id: -3,
    minimumServiceCount: 3,
    name: "Mốc 3 dịch vụ cưới",
    chooseCount: 1,
    options: [
      { id: -31, name: "1 áo đi bàn trị giá 1.200.000đ", description: null },
      { id: -32, name: "Áo dài dành cho chú rể", description: null },
      { id: -33, name: "6 áo dài quả nam", description: null },
    ],
  },
  {
    id: -4,
    minimumServiceCount: 4,
    name: "Mốc 4 dịch vụ cưới",
    chooseCount: 1,
    options: [{ id: -41, name: "1 ảnh 60 × 120cm chất liệu mica cao cấp", description: null }],
  },
  {
    id: -5,
    minimumServiceCount: 5,
    name: "Mốc 5 dịch vụ cưới",
    chooseCount: 1,
    options: [
      { id: -51, name: "May mới 1 cặp áo dài theo mẫu, đúng size dâu rể", description: null },
      { id: -52, name: "May mới 1 bộ saree theo size cô dâu", description: null },
    ],
  },
];

export const WEDDING_GIFT_PROGRAM_TEMPLATE: WeddingGiftProgramConfig = {
  id: null,
  name: "Chương trình quà tặng đặc biệt - Amazing Studio",
  enabled: false,
  startsAt: null,
  endsAt: null,
  eligibleServiceKeys: [
    "wedding_gate", "album_studio", "album_outdoor", "wedding_party",
    "wedding_video", "wedding_combo", "wedding_outfit", "bridal_makeup",
  ],
  eligibleGroupIds: [10, 11, 12, 13, 14, 16, 17, 19, 22, 23, 24],
  tiers: TEMPLATE_TIERS,
  accumulationPolicy: "highest_tier_only",
  source: "structured_template_pending_migration",
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

const WEDDING_SERVICE_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "wedding_gate", re: /\b(chup cong|cong cuoi|hinh cong|anh cong)\b/ },
  { key: "album_studio", re: /\b(album tai studio|album studio|chup cuoi studio)\b/ },
  { key: "album_outdoor", re: /\b(album ngoai canh|ngoai canh cuoi|chup cuoi ngoai canh)\b/ },
  { key: "wedding_party", re: /\b(chup tiec|tiec cuoi|phong su cuoi|dai tiec)\b/ },
  { key: "wedding_video", re: /\b(quay phim cuoi|quay ngay cuoi|video cuoi)\b/ },
  { key: "wedding_combo", re: /\b(combo cuoi|goi ngay cuoi|tron goi cuoi)\b/ },
  { key: "wedding_outfit", re: /\b(thue vay cuoi|vay cuoi|ao dai cuoi|vest cuoi|trang phuc cuoi)\b/ },
  { key: "bridal_makeup", re: /\b(makeup co dau|makeup cuoi|trang diem co dau)\b/ },
];

export function weddingServiceKeysInText(message: string): string[] {
  const text = norm(message);
  return WEDDING_SERVICE_PATTERNS.filter((item) => item.re.test(text)).map((item) => item.key);
}

const CONFIRM_SERVICE_RE = /\b(chot|dat lich|dat coc|book|booking|lay goi|chon dich vu|dong y dat|quyet dinh lay)\b/;
const REMOVE_SERVICE_RE = /\b(bo|khong lay|khong chot|huy|doi sang)\b/;

export function reconstructWeddingServiceState(input: {
  message: string;
  prior?: SaleHistoryItem[];
  currentServiceKey?: string | null;
}): { interested: string[]; confirmed: string[] } {
  const interested = new Set<string>();
  let confirmed: string[] = [];
  const incoming = [
    ...(input.prior ?? []).filter((item) => item.direction === "incoming").map((item) => ({ raw: item.message, isCurrent: false })),
    { raw: input.message, isCurrent: true },
  ];

  for (const { raw, isCurrent } of incoming) {
    const text = norm(raw);
    let keys = weddingServiceKeysInText(raw);
    if (isCurrent && keys.length === 0 && input.currentServiceKey && WEDDING_GIFT_PROGRAM_TEMPLATE.eligibleServiceKeys.includes(input.currentServiceKey)) {
      keys = [input.currentServiceKey];
    }
    for (const key of keys) interested.add(key);
    if (REMOVE_SERVICE_RE.test(text)) {
      for (const key of keys) {
        const index = confirmed.lastIndexOf(key);
        if (index >= 0) confirmed.splice(index, 1);
      }
      continue;
    }
    if (CONFIRM_SERVICE_RE.test(text)) {
      // Một hạng mục bị khách nhắc lại nhiều lần vẫn chỉ là một dịch vụ.
      // Riêng nhiều gói/ngày tiệc tách biệt chỉ được nhân khi khách nói rõ số lượng.
      for (const key of keys) {
        if (!confirmed.includes(key)) confirmed.push(key);
      }
      // Hai gói/ngày tiệc riêng biệt trong cùng hợp đồng được chủ studio xác nhận
      // là hai dịch vụ. Chỉ nhân số khi khách nói rõ số lượng.
      if (keys.includes("wedding_party") && /\b(2|hai)\s+(?:goi|ngay|buoi)\b/.test(text)) {
        confirmed.push("wedding_party");
      }
    }
  }
  return { interested: [...interested], confirmed };
}

function programStatus(program: WeddingGiftProgramConfig, now: Date): WeddingGiftTrace["programStatus"] {
  if (program.source === "database_not_configured") return "not_configured";
  if (!program.enabled) return "disabled";
  const startsAt = program.startsAt ? new Date(program.startsAt) : null;
  const endsAt = program.endsAt ? new Date(program.endsAt) : null;
  if (startsAt && startsAt.getTime() > now.getTime()) return "not_started";
  if (endsAt && endsAt.getTime() < now.getTime()) return "expired";
  return "active";
}

function packagesWereExplained(prior: SaleHistoryItem[]): boolean {
  return prior.some((item) => {
    if (item.direction !== "outgoing") return false;
    if (/price_sheet_replied/i.test(item.aiDecision ?? "")) return true;
    const text = norm(item.message);
    return /\b(goi|bao gia)\b/.test(text) && /\b(d|dong|trieu|000)\b/.test(text);
  });
}

export function evaluateWeddingGiftTrace(input: {
  message: string;
  prior?: SaleHistoryItem[];
  currentServiceKey?: string | null;
  program: WeddingGiftProgramConfig;
  now?: Date;
}): WeddingGiftTrace {
  const prior = input.prior ?? [];
  const state = reconstructWeddingServiceState(input);
  const eligibleConfirmed = state.confirmed.filter((key) => input.program.eligibleServiceKeys.includes(key));
  const count = eligibleConfirmed.length;
  const tier = [...input.program.tiers]
    .filter((item) => item.minimumServiceCount <= count)
    .sort((a, b) => b.minimumServiceCount - a.minimumServiceCount)[0] ?? null;
  const status = programStatus(input.program, input.now ?? new Date());
  const packagesExplained = packagesWereExplained(prior);

  let action: WeddingGiftTrace["action"] = "none";
  let reason = `program_${status}`;
  if (status === "active" && !packagesExplained && state.interested.length > 0) {
    action = "wait_until_after_quote";
    reason = "gift_must_follow_verified_package_explanation";
  } else if (status === "active" && packagesExplained && count < 2 && state.interested.length > 0) {
    action = "upsell_second_service";
    reason = "one_or_zero_confirmed_eligible_services";
  } else if (status === "active" && packagesExplained && tier) {
    action = "introduce_gift_tier";
    reason = `eligible_tier_${tier.minimumServiceCount}`;
  }

  return {
    programId: input.program.id,
    programName: input.program.name,
    programStatus: status,
    promotionSource: input.program.source,
    interestedWeddingServices: state.interested,
    confirmedWeddingServices: state.confirmed,
    eligibleServiceCount: count,
    giftTier: tier?.minimumServiceCount ?? null,
    giftTierName: tier?.name ?? null,
    chooseCount: tier?.chooseCount ?? null,
    giftOptions: tier?.options ?? [],
    packagesExplained,
    action,
    reason,
  };
}

type ProgramRow = {
  id: number;
  name: string;
  enabled: boolean;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
};
type EligibleRow = { group_id: number; service_key: string };
type TierRow = { id: number; minimum_service_count: number; name: string; choose_count: number };
type OptionRow = { id: number; tier_id: number; name: string; description: string | null };

let cachedProgram: { value: WeddingGiftProgramConfig; expiresAt: number } | null = null;

export async function loadWeddingGiftProgram(): Promise<WeddingGiftProgramConfig> {
  if (cachedProgram && cachedProgram.expiresAt > Date.now()) return cachedProgram.value;
  try {
    const programRes = await pool.query(
      `SELECT id, name, enabled, starts_at, ends_at
       FROM wedding_gift_programs
       ORDER BY enabled DESC, id DESC
       LIMIT 1`,
    );
    const program = programRes.rows[0] as ProgramRow | undefined;
    if (!program) {
      const value = { ...WEDDING_GIFT_PROGRAM_TEMPLATE, source: "database_not_configured" as const };
      cachedProgram = { value, expiresAt: Date.now() + 60_000 };
      return value;
    }
    const [eligibleRes, tierRes] = await Promise.all([
      pool.query(
        `SELECT group_id, service_key FROM wedding_gift_eligible_groups
         WHERE program_id = $1 AND is_active = true ORDER BY id`,
        [program.id],
      ),
      pool.query(
        `SELECT id, minimum_service_count, name, choose_count FROM wedding_gift_tiers
         WHERE program_id = $1 AND is_active = true ORDER BY minimum_service_count, sort_order, id`,
        [program.id],
      ),
    ]);
    const tierRows = tierRes.rows as TierRow[];
    const tierIds = tierRows.map((row) => row.id);
    const optionRes = tierIds.length
      ? await pool.query(
          `SELECT id, tier_id, name, description FROM wedding_gift_options
           WHERE tier_id = ANY($1::int[]) AND is_active = true ORDER BY sort_order, id`,
          [tierIds],
        )
      : { rows: [] };
    const options = optionRes.rows as OptionRow[];
    const value: WeddingGiftProgramConfig = {
      id: program.id,
      name: program.name,
      enabled: program.enabled,
      startsAt: program.starts_at,
      endsAt: program.ends_at,
      eligibleServiceKeys: [...new Set((eligibleRes.rows as EligibleRow[]).map((row) =>
        row.service_key.startsWith("wedding_combo_") ? "wedding_combo" : row.service_key,
      ))],
      eligibleGroupIds: (eligibleRes.rows as EligibleRow[]).map((row) => row.group_id),
      tiers: tierRows.map((row) => ({
        id: row.id,
        minimumServiceCount: row.minimum_service_count,
        name: row.name,
        chooseCount: row.choose_count,
        options: options.filter((option) => option.tier_id === row.id).map((option) => ({
          id: option.id,
          name: option.name,
          description: option.description,
        })),
      })),
      accumulationPolicy: "highest_tier_only",
      source: "database",
    };
    cachedProgram = { value, expiresAt: Date.now() + 60_000 };
    return value;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code !== "42P01") console.error("[WeddingGift] load failed:", String(error).slice(0, 160));
    cachedProgram = { value: WEDDING_GIFT_PROGRAM_TEMPLATE, expiresAt: Date.now() + 60_000 };
    return WEDDING_GIFT_PROGRAM_TEMPLATE;
  }
}

function tierByCount(program: WeddingGiftProgramConfig, count: number): WeddingGiftTier | null {
  return [...program.tiers]
    .filter((tier) => tier.minimumServiceCount <= count)
    .sort((a, b) => b.minimumServiceCount - a.minimumServiceCount)[0] ?? null;
}

function tierText(tier: WeddingGiftTier): string {
  const options = tier.options.map((option) => option.name);
  if (options.length === 1) return `Mốc ${tier.minimumServiceCount} dịch vụ cưới được tặng ${options[0]} nha mình 😄`;
  return `Mốc ${tier.minimumServiceCount} dịch vụ cưới mình được chọn 1 trong ${options.length}: ${options.join("; ")} nha mình 😄`;
}

/** Câu Step 5 cố định từ policy có cấu trúc; không giao AI tự bịa quyền lợi. */
export function buildWeddingGiftReply(input: {
  message: string;
  trace: WeddingGiftTrace;
  program: WeddingGiftProgramConfig;
}): string {
  const text = norm(input.message);
  const { trace, program } = input;
  if (trace.programStatus !== "active") {
    return "Dạ chương trình quà hiện chưa được bật nên em chưa dám hứa sai quyền lợi cho mình ạ.";
  }
  if (/beauty|ca nhan|fashion|chup bau|gia dinh|sinh nhat/.test(text) && /tinh|cong|dich vu|qua/.test(text)) {
    return "Dạ Beauty và các dịch vụ cá nhân ngoài cưới không được tính vào chương trình quà cưới nha mình ạ.";
  }
  if (/cong don|duoc luon|tat ca.*moc|moc 2.*moc 3|2.*3.*4.*5/.test(text)) {
    return "Dạ quà không cộng dồn tất cả các mốc nha mình. Hợp đồng hiện có bao nhiêu dịch vụ cưới đủ điều kiện thì mình áp đúng phần quà của mốc cao nhất đang đạt ạ.";
  }
  if (/doi.*tien|quy doi.*tien|lay tien/.test(text)) {
    return "Dạ chương trình hiện áp dụng theo quà tặng, không quy đổi thành tiền mặt nha mình ạ.";
  }
  if (/duoc chon|studio chon|tu chon|ai chon/.test(text)) {
    return "Dạ đúng rồi mình nha 😄 Những mốc ghi ‘chọn 1 trong…’ thì dâu rể tự chọn món hợp nhu cầu, bên em không chọn giùm ạ.";
  }
  if (/dich vu nao|nhung gi.*tinh|tinh.*dich vu/.test(text)) {
    return "Dạ chương trình tính các hạng mục cưới như chụp cổng, album/prewedding, ngày cưới, tiệc cưới, quay phim, combo, makeup và trang phục cưới đủ điều kiện. Beauty và dịch vụ cá nhân ngoài cưới không tính ạ.";
  }
  if (/co nen|lay them|them mot.*len moc|chay qua/.test(text)) {
    return "Dạ nếu mình vốn đã cần thêm hạng mục cưới thì làm chung sẽ lợi hơn nha 😄 Còn nếu không cần thì em không khuyên mình lấy thêm chỉ để chạy quà đâu ạ.";
  }
  if (/day du|toan bo|tat ca.*chuong trinh/.test(text)) {
    return `Dạ em gửi mình chương trình đầy đủ nha 💕 ${program.tiers.map(tierText).join(" ")} Beauty và dịch vụ ngoài cưới không tính; quà áp theo mốc cao nhất hiện đạt và không cộng dồn các mốc ạ.`;
  }
  const explicitTier = [5, 4, 3, 2].find((count) => new RegExp(`\\b${count}\\s*(?:dich vu|goi)|moc\\s*${count}\\b`).test(text));
  if (explicitTier) {
    const tier = program.tiers.find((item) => item.minimumServiceCount === explicitTier);
    if (tier) return tierText(tier);
  }
  if (/moc nao|moc may|duoc gi|co qua khong|qua gi/.test(text) && trace.eligibleServiceCount > 0) {
    const current = tierByCount(program, trace.eligibleServiceCount);
    if (current) return `Dạ hiện hợp đồng mình có ${trace.eligibleServiceCount} dịch vụ cưới đủ điều kiện nên đang ở mốc ${current.minimumServiceCount} nha 😄 ${tierText(current)}`;
    return `Dạ hiện mình có ${trace.eligibleServiceCount} dịch vụ cưới đủ điều kiện. Chương trình bắt đầu có quà từ 2 dịch vụ nha mình.`;
  }
  return "Dạ bên em có chương trình quà riêng cho dâu rể từ 2 dịch vụ cưới trở lên nha 😄 Quà tăng theo mốc 2–3–4–5 dịch vụ. Mình nói em các hạng mục đang tính làm, em kiểm tra đúng mốc cho mình luôn ạ.";
}

export function buildWeddingGiftPromptBlock(trace: WeddingGiftTrace): string {
  if (trace.programStatus !== "active" || trace.action === "none" || trace.action === "wait_until_after_quote") return "";
  if (trace.action === "upsell_second_service") {
    return `WEDDING GIFT PROGRAM (structured runtime data): the customer is not yet eligible. After the quote, gently explain that choosing a second eligible wedding service starts the gift program. Never say they already qualify.`;
  }
  return `WEDDING GIFT PROGRAM (structured runtime data):
- Confirmed eligible services: ${trace.confirmedWeddingServices.join(", ")}
- Eligible count: ${trace.eligibleServiceCount}
- Tier: ${trace.giftTier}
- Customer may choose exactly ${trace.chooseCount} option(s): ${JSON.stringify(trace.giftOptions.map((option) => option.name))}
Explain the exact tier and ask the customer to choose. Never imply they receive every option.`;
}
