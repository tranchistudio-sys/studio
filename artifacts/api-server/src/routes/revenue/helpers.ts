export const SERVICE_LABELS: Record<string, string> = {
  wedding: "Cưới / Ngày cưới",
  prewedding: "Chụp Pre-wedding",
  maternity: "Chụp Bầu",
  baby: "Chụp Em bé",
  birthday: "Sinh nhật",
  family: "Gia đình",
  portrait: "Chân dung",
  event: "Sự kiện",
  other: "Khác",
};

// Gom ngày/tháng theo múi giờ Việt Nam (Asia/Ho_Chi_Minh, +7) để không lệch kỳ ở
// rìa nửa đêm khi server chạy UTC (Replit prod). Cùng kỹ thuật với dashboard.ts.
// toLocaleDateString('sv-SE', { timeZone }) trả "YYYY-MM-DD" theo giờ VN.
const APP_TZ = "Asia/Ho_Chi_Minh";
function toVNDateString(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: APP_TZ });
}

export function getPaymentDate(p: { paidDate: string | null; paidAt: Date }): string {
  if (p.paidDate && p.paidDate.length >= 10) return p.paidDate.slice(0, 10);
  return toVNDateString(p.paidAt);
}

export function getBookingDate(b: { createdAt: Date }): string {
  return toVNDateString(b.createdAt);
}

export function getBookingMonth(b: { createdAt: Date }): string {
  return toVNDateString(b.createdAt).slice(0, 7);
}

export function getPaymentMonth(p: { paidDate: string | null; paidAt: Date }): string {
  if (p.paidDate && p.paidDate.length >= 7) return p.paidDate.slice(0, 7);
  return toVNDateString(p.paidAt).slice(0, 7);
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${m}/${y}`;
}

export function generateMonthRange(startYM: string, endYM: string): string[] {
  const months: string[] = [];
  const [sy, sm] = startYM.split("-").map(Number);
  const [ey, em] = endYM.split("-").map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

export function getCurrentYM(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function dateInRange(dateStr: string, from: string, to: string): boolean {
  return dateStr >= from && dateStr <= to;
}
