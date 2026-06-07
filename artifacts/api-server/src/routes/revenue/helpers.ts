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

export function getPaymentDate(p: { paidDate: string | null; paidAt: Date }): string {
  if (p.paidDate && p.paidDate.length >= 10) return p.paidDate.slice(0, 10);
  const d = p.paidAt;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getBookingDate(b: { createdAt: Date }): string {
  const d = b.createdAt;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getBookingMonth(b: { createdAt: Date }): string {
  const d = b.createdAt;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getPaymentMonth(p: { paidDate: string | null; paidAt: Date }): string {
  if (p.paidDate && p.paidDate.length >= 7) return p.paidDate.slice(0, 7);
  const d = p.paidAt;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
