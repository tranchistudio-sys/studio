/**
 * business-snapshot.ts — GÓI SỐ LIỆU "bức tranh kinh doanh" cho câu hỏi tổng quan
 * ("Tháng này studio kinh doanh thế nào?").
 *
 * NGUYÊN TẮC (chủ chốt): App/engine là NGUỒN SỐ và MÁY TÍNH chính xác. Mọi con số
 * cần độ chính xác tuyệt đối (doanh thu, thực thu, chi phí, lợi nhuận, công nợ, số
 * booking) VÀ các số dẫn xuất (trung bình/booking, biên lợi nhuận, % tăng giảm)
 * đều được TÍNH SẴN ở đây bằng engine hiện có. ChatGPT chỉ ĐỌC gói JSON này để
 * phân tích/khuyến nghị — KHÔNG tự tính lại số.
 *
 * Vì snapshot chứa sẵn mọi số tiền cỡ lớn, khoá số aiNumbersWithinSources
 * (copilot-composer) giữ NGUYÊN vẫn cho ChatGPT phân tích thoải mái: mọi số nó
 * trích đều nằm trong JSON; chỉ số BỊA (không có trong snapshot) mới bị chặn.
 *
 * KHÔNG viết SQL mới, KHÔNG đụng engine: dùng lại getSimpleFinance (đồng bộ
 * /dashboard/simple) + computeBucketStats/deriveMoney của /revenue/v2/monthly.
 */
import { getSimpleFinance } from "./finance-summary";
import { COPILOT_SYSTEM_PROMPT } from "./studio-copilot";
import { loadAllData } from "../routes/revenue/data";
import { computeBucketStats } from "../routes/revenue/monthly-core";

// ─── Kiểu dữ liệu ─────────────────────────────────────────────────────────────

/** Số liệu THÔ (đã do engine tính chính xác) của một kỳ. */
export type PeriodFigures = {
  /** Doanh thu HĐ ký mới trong kỳ (NET, theo ngày tạo đơn). */
  contractValue: number;
  /** Tiền thực thu trong kỳ (payments theo paid_at, loại refund/voided/cha rỗng). */
  collected: number;
  /** Chi phí trực tiếp (expenses approved/paid). */
  directExpense: number;
  /** Chi phí cố định/tháng đang active. */
  fixedCostMonthly: number;
  /** Tổng chi = trực tiếp + cố định. */
  totalSpent: number;
  /** Lợi nhuận thực = thực thu − tổng chi. */
  realProfit: number;
  /** Số booking chốt mới trong kỳ. */
  bookingCount: number;
};

/** Số dẫn xuất — APP tự tính, ChatGPT khỏi tính lại. */
export type DerivedFigures = {
  /** Thực thu trung bình mỗi booking (VND, làm tròn). null nếu 0 booking. */
  avgCollectedPerBooking: number | null;
  /** Giá trị HĐ trung bình mỗi booking (VND, làm tròn). null nếu 0 booking. */
  avgContractPerBooking: number | null;
  /** Biên lợi nhuận thực = realProfit / thực thu (%). null nếu thực thu = 0. */
  profitMarginPct: number | null;
  /** Tỉ lệ thu = thực thu / doanh thu HĐ (%). null nếu doanh thu HĐ = 0. */
  collectionRatePct: number | null;
};

/** % và mức thay đổi kỳ này so kỳ trước (null nếu kỳ trước = 0). */
export type DeltaFigures = {
  collectedPct: number | null;
  contractValuePct: number | null;
  realProfitPct: number | null;
  bookingCountPct: number | null;
  collectedAbs: number;
  realProfitAbs: number;
  bookingCountAbs: number;
};

export type BusinessSnapshot = {
  /** Tháng đang phân tích, dạng YYYY-MM. */
  month: string;
  currency: "VND";
  period: { from: string; to: string; label: string };
  previousPeriod: { from: string; to: string; label: string };
  current: PeriodFigures & { breakeven: { status: "over" | "under"; delta: number } };
  previous: PeriodFigures;
  derived: DerivedFigures;
  deltaVsPrevious: DeltaFigures;
  /** Công nợ khách TOÀN HỆ THỐNG hiện tại (điểm-thời-gian, không theo kỳ). */
  customerDebtNow: number;
  /** Ràng buộc/độ tin của số liệu — ChatGPT phải nói đúng phạm vi, không giấu. */
  caveats: string[];
  /** Ghi chú phạm vi từng số để ChatGPT diễn giải đúng. */
  scopeNotes: Record<string, string>;
};

// ─── Helper tính toán thuần ───────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n);
}

/** Làm tròn % về 1 chữ số thập phân. */
function pct1(n: number): number {
  return Math.round(n * 10) / 10;
}

function deltaPct(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return pct1(((cur - prev) / prev) * 100);
}

function avgPerBooking(total: number, count: number): number | null {
  return count > 0 ? round(total / count) : null;
}

/**
 * Lõi THUẦN: từ số thô 2 kỳ → snapshot đầy đủ (mọi số dẫn xuất). Tách riêng để
 * test không cần DB (giống pattern test finance khác trong repo).
 */
export function deriveSnapshot(input: {
  month: string;
  period: { from: string; to: string; label: string };
  previousPeriod: { from: string; to: string; label: string };
  current: PeriodFigures & { breakeven: { status: "over" | "under"; delta: number } };
  previous: PeriodFigures;
  customerDebtNow: number;
  caveats: string[];
}): BusinessSnapshot {
  const c = input.current;
  const p = input.previous;
  const derived: DerivedFigures = {
    avgCollectedPerBooking: avgPerBooking(c.collected, c.bookingCount),
    avgContractPerBooking: avgPerBooking(c.contractValue, c.bookingCount),
    profitMarginPct: c.collected === 0 ? null : pct1((c.realProfit / c.collected) * 100),
    collectionRatePct: c.contractValue === 0 ? null : pct1((c.collected / c.contractValue) * 100),
  };
  const deltaVsPrevious: DeltaFigures = {
    collectedPct: deltaPct(c.collected, p.collected),
    contractValuePct: deltaPct(c.contractValue, p.contractValue),
    realProfitPct: deltaPct(c.realProfit, p.realProfit),
    bookingCountPct: deltaPct(c.bookingCount, p.bookingCount),
    collectedAbs: round(c.collected - p.collected),
    realProfitAbs: round(c.realProfit - p.realProfit),
    bookingCountAbs: c.bookingCount - p.bookingCount,
  };
  return {
    month: input.month,
    currency: "VND",
    period: input.period,
    previousPeriod: input.previousPeriod,
    current: c,
    previous: p,
    derived,
    deltaVsPrevious,
    customerDebtNow: round(input.customerDebtNow),
    caveats: input.caveats,
    scopeNotes: {
      collected: "Tiền THỰC THU trong kỳ, theo ngày thu (paid_at); đã loại hoàn tiền/huỷ.",
      contractValue: "Doanh thu HỢP ĐỒNG ký mới trong kỳ (NET, theo ngày tạo đơn) — chỉ số bán hàng, KHÁC tiền thực thu.",
      realProfit: "Lợi nhuận thực = thực thu − (chi trực tiếp + chi cố định). Chưa trừ hết cast nếu coverage partial; chưa gồm hoa hồng sale chưa ghi sổ.",
      customerDebtNow: "Công nợ khách TOÀN HỆ THỐNG tại thời điểm hiện tại (không theo kỳ) — không so sánh tháng.",
    },
  };
}

// ─── Nhãn tháng tiếng Việt ─────────────────────────────────────────────────────

function ymLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `Tháng ${Number(m)}/${y}`;
}

// ─── Gom snapshot từ engine (đường chạy thật) ─────────────────────────────────

/**
 * Dựng snapshot cho kỳ hiện tại (đầu tháng → hôm nay) so với tháng trước (đủ tháng).
 *
 * Số tiền lấy từ getSimpleFinance (ĐỒNG BỘ /dashboard/simple — cùng công thức);
 * doanh thu HĐ + số booking lấy từ computeBucketStats của /revenue/v2/monthly.
 * Gọi loadAllData() MỘT lần, dùng cho cả 2 kỳ.
 *
 * @param now cho phép test tiêm mốc thời gian; mặc định thời điểm gọi.
 */
export async function buildBusinessSnapshot(now: Date = new Date()): Promise<BusinessSnapshot> {
  // Mốc ngày: mirror ĐÚNG /dashboard/simple (today theo ISO, đầu tháng theo local).
  const today = now.toISOString().slice(0, 10);
  const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const firstOfMonth = `${curYm}-01`;

  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYm = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
  const prevFirst = `${prevYm}-01`;
  const prevLastDay = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate();
  const prevLast = `${prevYm}-${String(prevLastDay).padStart(2, "0")}`;

  const [curFin, prevFin, data] = await Promise.all([
    getSimpleFinance(firstOfMonth, today),
    getSimpleFinance(prevFirst, prevLast),
    loadAllData(),
  ]);

  const curBucket = computeBucketStats(data, firstOfMonth, today);
  const prevBucket = computeBucketStats(data, prevFirst, prevLast);

  const current: PeriodFigures & { breakeven: { status: "over" | "under"; delta: number } } = {
    contractValue: round(curBucket.contractValue),
    collected: round(curFin.totalIncome),
    directExpense: round(curFin.directExpense),
    fixedCostMonthly: round(curFin.fixedCostMonthly),
    totalSpent: round(curFin.totalSpent),
    realProfit: round(curFin.realProfit),
    bookingCount: curBucket.bookingCount,
    breakeven: { status: curFin.breakeven.status, delta: round(curFin.breakeven.delta) },
  };
  const previous: PeriodFigures = {
    contractValue: round(prevBucket.contractValue),
    collected: round(prevFin.totalIncome),
    directExpense: round(prevFin.directExpense),
    fixedCostMonthly: round(prevFin.fixedCostMonthly),
    totalSpent: round(prevFin.totalSpent),
    realProfit: round(prevFin.realProfit),
    bookingCount: prevBucket.bookingCount,
  };

  return deriveSnapshot({
    month: curYm,
    period: { from: firstOfMonth, to: today, label: `${ymLabel(curYm)} (tới ${today.slice(8)}/${today.slice(5, 7)})` },
    previousPeriod: { from: prevFirst, to: prevLast, label: ymLabel(prevYm) },
    current,
    previous,
    // Công nợ toàn hệ thống (getSimpleFinance trả cùng giá trị mọi kỳ) — lấy 1 lần.
    customerDebtNow: curFin.customerDebt,
    caveats: [
      "Lợi nhuận chưa trừ hết cast nếu coverage nhân sự còn thiếu, và CHƯA gồm hoa hồng sale chưa ghi sổ.",
      "Thực thu (theo ngày thu) và doanh thu hợp đồng (theo ngày ký) là hai phạm vi khác nhau — không cộng gộp.",
      "Công nợ là số toàn hệ thống hiện tại, không phải phát sinh riêng trong tháng.",
      "Kỳ hiện tại tính tới hôm nay (chưa đủ tháng), nên khi so với tháng trước ĐỦ tháng cần lưu ý chưa cùng độ dài.",
    ],
  });
}

// ─── Câu trả lời DETERMINISTIC (dự phòng + nguồn allow cho khoá số) ────────────

function vnd(n: number): string {
  return `${Math.round(n).toLocaleString("vi-VN")}đ`;
}

function signPct(p: number | null): string {
  if (p == null) return "—";
  const s = p > 0 ? "+" : "";
  return `${s}${p}%`;
}

/**
 * Câu tóm tắt chính xác 100% từ snapshot — dùng khi CHƯA cấu hình LLM, OpenAI lỗi,
 * hoặc câu AI bị khoá số chặn. Mọi số ở đây đều từ engine.
 */
export function renderBusinessSummary(s: BusinessSnapshot): string {
  const c = s.current;
  const lines: string[] = [];
  lines.push(`Tình hình kinh doanh ${s.period.label}:`);
  lines.push(`• Thực thu: ${vnd(c.collected)} (${signPct(s.deltaVsPrevious.collectedPct)} so với ${s.previousPeriod.label})`);
  lines.push(`• Doanh thu hợp đồng ký mới: ${vnd(c.contractValue)}`);
  lines.push(`• Tổng chi: ${vnd(c.totalSpent)} (trực tiếp ${vnd(c.directExpense)} + cố định ${vnd(c.fixedCostMonthly)})`);
  lines.push(`• Lợi nhuận thực: ${vnd(c.realProfit)} (${signPct(s.deltaVsPrevious.realProfitPct)}), ${c.breakeven.status === "over" ? "đã qua hoà vốn" : "chưa hoà vốn"}`);
  lines.push(`• Số booking: ${c.bookingCount} (${signPct(s.deltaVsPrevious.bookingCountPct)})`);
  if (s.derived.avgCollectedPerBooking != null) {
    lines.push(`• Thực thu trung bình/booking: ${vnd(s.derived.avgCollectedPerBooking)}`);
  }
  if (s.derived.profitMarginPct != null) {
    lines.push(`• Biên lợi nhuận: ${s.derived.profitMarginPct}%`);
  }
  lines.push(`• Công nợ khách (toàn hệ thống): ${vnd(s.customerDebtNow)}`);
  lines.push(`Lưu ý: ${s.caveats[0]}`);
  return lines.join("\n");
}

// ─── Prompt gửi ChatGPT (phân tích, KHÔNG tính lại số) ─────────────────────────

export function buildBusinessAnalysisPrompt(s: BusinessSnapshot): string {
  return `${COPILOT_SYSTEM_PROMPT}

## VAI TRÒ
Bạn là chuyên viên phân tích kinh doanh của studio. Dưới đây là SỐ LIỆU ĐÃ ĐƯỢC HỆ THỐNG TÍNH CHÍNH XÁC (JSON). Nhiệm vụ của bạn là PHÂN TÍCH và KHUYẾN NGHỊ — KHÔNG phải tính lại số.

## VIỆC CẦN LÀM
1. Nhận định tổng quan tháng này kinh doanh thế nào (tốt/ổn/đáng lo) dựa trên số.
2. So sánh với kỳ trước (dùng các trường deltaVsPrevious đã có sẵn).
3. Phát hiện điểm bất thường (vd thực thu giảm mạnh, chi vượt thu, công nợ cao, biên lợi nhuận thấp, tỉ lệ thu thấp).
4. Chỉ ra 1–3 vấn đề ưu tiên xử lý.
5. Giải thích nguyên nhân CÓ THỂ dựa trên chính dữ liệu (không bịa nguyên nhân ngoài số).
6. Đề xuất 2–3 hành động cụ thể cho chủ studio.

## QUY TẮC BẮT BUỘC
1. CHỈ dùng những con số CÓ SẴN trong JSON. TUYỆT ĐỐI không tự cộng/trừ/nhân/chia ra con số tiền mới; các số dẫn xuất (trung bình, biên lợi nhuận, % tăng giảm) đã có sẵn trong "derived"/"deltaVsPrevious" — trích dùng, đừng tự tính.
2. Không dự báo ra con số tiền cụ thể (vd "quý tới đạt X đồng"); nhận định xu hướng bằng lời.
3. Nói ĐÚNG phạm vi theo "scopeNotes" và nêu các "caveats" liên quan — không giấu, không phóng đại.
4. Tiếng Việt tự nhiên, xưng "em", gọi người dùng là "anh". Ngắn gọn, đi thẳng vấn đề.
5. KHÔNG markdown (không **, không #). Hạn chế emoji (tối đa 1). Có thể dùng dòng bắt đầu "• " để liệt kê.
6. Nếu một trường là null (vd chưa có booking, kỳ trước = 0) thì nói rõ "chưa đủ dữ liệu để so sánh", không bịa.

## SỐ LIỆU (JSON — nguồn số DUY NHẤT)
${JSON.stringify(s, null, 2)}`;
}

// ─── Nhận diện câu hỏi tổng quan kinh doanh ───────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/**
 * Câu hỏi có phải kiểu "tháng này studio kinh doanh thế nào?" không.
 * MVP: bắt đúng nhóm câu tổng quan tình hình kinh doanh; các câu cụ thể
 * (khách nào nợ, hôm nay mấy show...) KHÔNG khớp → đi đường Copilot cũ.
 */
export function isBusinessOverviewQuestion(q: string): boolean {
  const t = stripAccents((q ?? "").toLowerCase());
  if (!t.trim()) return false;
  // Cụm rõ ràng về "kinh doanh / buôn bán / làm ăn".
  if (/(kinh doanh|buon ban|lam an)/.test(t)) return true;
  // "tình hình / tổng quan" gắn với tháng/studio/thế nào.
  const overviewWord = /(tinh hinh|tong quan|toan canh)/.test(t);
  const businessCtx = /(thang|studio|kinh te|tai chinh|the nao|ra sao|sao roi)/.test(t);
  if (overviewWord && businessCtx) return true;
  return false;
}
