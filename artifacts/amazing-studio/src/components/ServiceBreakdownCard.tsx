import type { ReactNode } from "react";
import { reflowDescriptionLines } from "@/lib/package-description";

export type ServiceSurcharge = { name?: string; label?: string; amount: number };
export type ServiceDeduction = { label: string; amount: number };

export interface ServicePriceBreakdownProps {
  basePrice: number;
  surcharges?: ServiceSurcharge[];
  deductions?: ServiceDeduction[];
  finalAmount: number;
  formatVND: (n: number) => string;
  basePriceLabel?: string;
  finalLabel?: string;
  className?: string;
}

export function ServicePriceBreakdown({
  basePrice,
  surcharges = [],
  deductions = [],
  finalAmount,
  formatVND,
  basePriceLabel = "Giá niêm yết",
  finalLabel = "Thành tiền dịch vụ",
  className = "px-3 py-2 space-y-1",
}: ServicePriceBreakdownProps) {
  return (
    <div className={className}>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{basePriceLabel}</span>
        <span className="font-medium">{formatVND(basePrice)}</span>
      </div>
      {surcharges.length > 0 && (
        <div className="space-y-0.5">
          {surcharges.map((sc, scIdx) => (
            <div key={scIdx} className="flex justify-between text-[11px] pl-3">
              <span className="text-amber-700 dark:text-amber-400">+ {sc.name || sc.label || "Phụ phí"}</span>
              <span className="text-amber-700 dark:text-amber-400">{formatVND(sc.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {deductions.length > 0 && (
        <div className="space-y-0.5">
          {deductions.map((d, dIdx) => (
            <div key={dIdx} className="flex justify-between text-[11px] pl-3">
              <span className="text-red-600 dark:text-red-400">- {d.label}</span>
              <span className="text-red-600 dark:text-red-400">-{formatVND(d.amount)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-between text-xs pt-1 border-t border-dashed border-border/40">
        <span className="text-muted-foreground font-medium italic">{finalLabel}</span>
        <span className="font-bold">{formatVND(finalAmount)}</span>
      </div>
    </div>
  );
}

export interface ServiceBreakdownCardProps {
  title: string;
  description?: string | null;
  basePrice: number;
  surcharges?: ServiceSurcharge[];
  deductions?: ServiceDeduction[];
  finalAmount: number;
  formatVND: (n: number) => string;
  variant?: "violet" | "blue";
  /** Extra content rendered between description and price block (e.g. addons, staff). */
  beforePrice?: ReactNode;
  /** Extra content rendered after the price block (e.g. notes, concept gallery). */
  afterPrice?: ReactNode;
  /** Hide the inner price breakdown (e.g. non-admin views). */
  hidePrice?: boolean;
  className?: string;
}

const VARIANTS = {
  violet: {
    border: "border-violet-200 dark:border-violet-800",
    headerBg: "bg-violet-50 dark:bg-violet-950/30 border-b border-violet-200 dark:border-violet-800",
    title: "text-violet-700 dark:text-violet-300",
  },
  blue: {
    border: "border-blue-200 dark:border-blue-800",
    headerBg: "bg-blue-50/50 dark:bg-blue-950/20 border-b border-blue-200 dark:border-blue-800",
    title: "text-foreground",
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// HTML string helpers — phải khớp 1-1 với <ServicePriceBreakdown /> và
// <ServiceBreakdownCard /> ở trên, để hoá đơn PDF/in luôn hiển thị giống
// card thanh toán trong app. Khi đổi cấu trúc breakdown, sửa cả 2 chỗ.
// ────────────────────────────────────────────────────────────────────────────

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ServicePriceBreakdownHTMLProps {
  basePrice: number;
  surcharges?: ServiceSurcharge[];
  deductions?: ServiceDeduction[];
  finalAmount: number;
  formatVND: (n: number) => string;
  basePriceLabel?: string;
  finalLabel?: string;
}

/** HTML string version of <ServicePriceBreakdown />. Cùng label, cùng thứ tự dòng. */
export function renderServicePriceBreakdownHTML({
  basePrice,
  surcharges = [],
  deductions = [],
  finalAmount,
  formatVND,
  basePriceLabel = "Giá niêm yết",
  finalLabel = "Thành tiền dịch vụ",
}: ServicePriceBreakdownHTMLProps): string {
  const surchargesHTML = surcharges.length > 0
    ? surcharges.map(sc => `
          <div style="display:flex;justify-content:space-between;font-size:12px;padding-left:10px;margin-bottom:2px;">
            <span style="color:#b45309;">+ ${escapeHTML(sc.name || sc.label || "Phụ phí")}</span>
            <span style="color:#b45309;">${formatVND(sc.amount)}</span>
          </div>`).join("")
    : "";
  const deductionsHTML = deductions.length > 0
    ? deductions.map(d => `
          <div style="display:flex;justify-content:space-between;font-size:12px;padding-left:10px;margin-bottom:2px;">
            <span style="color:#c0392b;">- ${escapeHTML(d.label)}</span>
            <span style="color:#c0392b;">-${formatVND(d.amount)}</span>
          </div>`).join("")
    : "";
  return `
        <div style="padding:12px 16px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span style="color:#666;">${escapeHTML(basePriceLabel)}</span>
            <span style="font-weight:600;">${formatVND(basePrice)}</span>
          </div>${surchargesHTML}${deductionsHTML}
          <div style="display:flex;justify-content:space-between;font-size:13px;border-top:1px dashed #ccc;padding-top:6px;margin-top:6px;">
            <span style="color:#444;font-style:italic;font-weight:500;">${escapeHTML(finalLabel)}</span>
            <span style="font-weight:800;color:#111;">${formatVND(finalAmount)}</span>
          </div>
        </div>`;
}

export interface ServiceBreakdownCardHTMLProps extends ServicePriceBreakdownHTMLProps {
  title: string;
  /** Optional subtitle line under the title (e.g. shoot date). Plain text — sẽ được escape. */
  subtitle?: string | null;
  /** Mô tả gói (nội dung gói) — multi-line dùng "\n". */
  description?: string | null;
  hidePrice?: boolean;
}

/** HTML string version of <ServiceBreakdownCard /> (header + nội dung gói + price block). */
export function renderServiceBreakdownCardHTML({
  title,
  subtitle,
  description,
  hidePrice = false,
  ...priceProps
}: ServiceBreakdownCardHTMLProps): string {
  const descLines = reflowDescriptionLines(description);
  const descHTML = descLines.length > 0
    ? `<div style="padding:8px 16px;border-bottom:1px solid #eee;font-size:11px;color:#222;">
          <div style="font-weight:700;font-size:10px;color:#111;margin-bottom:4px;">Nội dung gói:</div>
          ${descLines.map(l => escapeHTML(l)).join("<br/>")}
        </div>`
    : "";
  const subtitleHTML = subtitle
    ? `<div style="font-size:11px;color:#444;margin-top:2px;">${escapeHTML(subtitle)}</div>`
    : "";
  const priceHTML = hidePrice ? "" : renderServicePriceBreakdownHTML(priceProps);
  return `
      <div style="border:1px solid #ddd;border-radius:10px;overflow:hidden;margin-bottom:12px;background:#fff;">
        <div style="background:#f5f5f5;padding:10px 16px;border-bottom:1px solid #ddd;">
          <div style="font-weight:700;font-size:12px;color:#111;text-transform:uppercase;letter-spacing:0.5px;">${escapeHTML(title)}</div>
          ${subtitleHTML}
        </div>
        ${descHTML}${priceHTML}
      </div>`;
}

export function ServiceBreakdownCard({
  title,
  description,
  basePrice,
  surcharges,
  deductions,
  finalAmount,
  formatVND,
  variant = "violet",
  beforePrice,
  afterPrice,
  hidePrice = false,
  className = "",
}: ServiceBreakdownCardProps) {
  const styles = VARIANTS[variant];
  const descLines = reflowDescriptionLines(description);
  return (
    <div className={`rounded-lg border ${styles.border} overflow-hidden mb-2 last:mb-0 ${className}`}>
      <div className={`px-3 py-2 ${styles.headerBg}`}>
        <span className={`text-[11px] font-bold uppercase tracking-wide ${styles.title}`}>{title}</span>
      </div>
      {descLines.length > 0 && (
        <div className="px-3 py-1.5 border-b border-border/30 bg-gray-50/50 dark:bg-muted/10">
          <p className="text-[10px] font-bold text-muted-foreground mb-1">Nội dung gói:</p>
          {descLines.map((line, i) => (
            <p key={i} className="text-[11px] text-muted-foreground leading-relaxed">{line}</p>
          ))}
        </div>
      )}
      {beforePrice}
      {!hidePrice && (
        <ServicePriceBreakdown
          basePrice={basePrice}
          surcharges={surcharges}
          deductions={deductions}
          finalAmount={finalAmount}
          formatVND={formatVND}
        />
      )}
      {afterPrice}
    </div>
  );
}
