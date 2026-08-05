import { parseDescriptionBlocks } from "@/lib/package-description";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * Card 1 gói giá — DÙNG CHUNG cho Kịch bản Lulu, thiết kế giống card ở "Dịch vụ & Bảng giá":
 * tên gói + badge Hậu kỳ + mã + badge loại dịch vụ + photographer, giá lớn (kèm giảm giá),
 * chi phí (In ấn / Vận hành / Cast), và MÔ TẢ ĐẦY ĐỦ trong hộp vàng (không cắt).
 * Dữ liệu đọc realtime từ GET /api/service-packages (discount backend tính sẵn).
 */

export type PricePkg = {
  id: number;
  code?: string | null;
  name: string;
  price: number;
  printCost?: number | null;
  operatingCost?: number | null;
  description?: string | null;
  notes?: string | null;
  serviceType?: string | null;
  photoCount?: number | null;
  isActive?: boolean;
  sortOrder?: number;
  groupId?: number | null;
  requiresPostProduction?: boolean;
  discount?: {
    discountApplied?: boolean;
    finalPrice?: number;
    discountName?: string | null;
    discountEndDate?: string | null;
  } | null;
};

const fmtVND = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString("vi-VN") + "đ" : "liên hệ");
function fmtShort(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}tr`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

// Mô tả gói → khối đẹp (heading/bullet) trong hộp vàng — giống trang Bảng giá.
function DescBlocks({ text }: { text: string }) {
  return (
    <div className="space-y-0.5">
      {parseDescriptionBlocks(text).map((b, i) =>
        b.type === "divider" ? (
          <div key={i} className="border-t border-amber-300/60 my-1.5" aria-hidden />
        ) : b.type === "heading" ? (
          <p key={i} className="text-[11px] text-amber-900 font-bold pt-1 first:pt-0">{b.text}</p>
        ) : b.type === "bullet" ? (
          <p key={i} className="text-[11px] text-amber-700 leading-relaxed pl-3 -indent-3">{b.text}</p>
        ) : (
          <p key={i} className="text-[11px] text-amber-700 leading-relaxed pt-0.5 first:pt-0">{b.text}</p>
        ),
      )}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  tiec: "🎊 Tiệc cưới", tiec_le: "🎊 Tiệc + Lễ",
  phong_su: "📸 Phóng sự", phong_su_luxury: "📸 Phóng sự luxury",
  combo_co_makeup: "💄 Có makeup", combo_khong_makeup: "👗 Không makeup",
  quay_phim: "🎬 Quay phim", beauty: "✨ Beauty",
  gia_dinh: "👨‍👩‍👧 Gia đình", makeup_le: "💋 Makeup lẻ", in_anh: "🖨️ In ảnh",
};

export function PackagePriceCard({ pkg, collapsed = false, onToggle }: { pkg: PricePkg; collapsed?: boolean; onToggle?: () => void }) {
  const hasDiscount = !!pkg.discount?.discountApplied && typeof pkg.discount?.finalPrice === "number";
  const isCombo = pkg.serviceType?.startsWith("combo");
  const isNoPhoto = ["makeup_le", "in_anh"].includes(pkg.serviceType ?? "");
  return (
    <div className={`p-3 rounded-xl border border-gray-200 bg-white ${pkg.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between mb-1 gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm flex items-center gap-1.5 flex-wrap">
            {pkg.name}
            {pkg.requiresPostProduction === false
              ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Không HK</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 font-medium">Hậu kỳ</span>}
          </p>
          {pkg.code && <p className="text-xs text-gray-400">{pkg.code}</p>}
          {!collapsed && pkg.serviceType && (
            <div className="flex flex-wrap gap-1 mt-1">
              <span className="text-[9px] px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded-full font-semibold">{TYPE_LABEL[pkg.serviceType] ?? pkg.serviceType}</span>
              {!isCombo && !isNoPhoto && (pkg.photoCount ?? 0) > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded-full font-semibold">📷 {pkg.photoCount ?? 1} photographer</span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pkg.isActive === false && <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">Ẩn</span>}
          {onToggle && (
            <button onClick={onToggle} title={collapsed ? "Xem chi tiết gói" : "Thu gọn — chỉ tên & giá"}
              className="text-gray-400 hover:text-gray-700 border border-gray-200 rounded p-0.5">
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {hasDiscount ? (
        <div className="mb-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xl font-bold text-rose-600">{fmtVND(pkg.discount!.finalPrice!)}</p>
            <p className="text-sm line-through text-gray-400">{fmtVND(pkg.price)}</p>
          </div>
          {!collapsed && pkg.discount?.discountName && (
            <p className="text-[10px] text-rose-600 mt-0.5">🏷️ {pkg.discount.discountName}{pkg.discount.discountEndDate ? ` · đến ${new Date(pkg.discount.discountEndDate).toLocaleDateString("vi-VN")}` : ""}</p>
          )}
        </div>
      ) : (
        <p className="text-xl font-bold text-violet-700 mb-0.5">{fmtVND(pkg.price)}</p>
      )}

      {!collapsed && ((pkg.printCost ?? 0) > 0 || (pkg.operatingCost ?? 0) > 0) && (
        <div className="mt-1.5 space-y-0.5 text-[11px] text-gray-400">
          {(pkg.printCost ?? 0) > 0 && <p>🖨️ In ấn: {fmtShort(pkg.printCost!)}</p>}
          {(pkg.operatingCost ?? 0) > 0 && <p>⚡ Vận hành: {fmtShort(pkg.operatingCost!)}</p>}
          <p className="text-[10px] text-sky-600">👤 Cast theo nhân sự</p>
        </div>
      )}

      {!collapsed && pkg.description && (
        <div className="mt-2 bg-amber-50 rounded-lg px-2 py-1.5">
          <p className="text-[10px] font-semibold text-amber-800 mb-0.5">📋 Mô tả</p>
          <DescBlocks text={pkg.description} />
          {pkg.notes && (
            <div className="flex gap-1 mt-1 text-orange-700 font-medium">
              <span className="text-[10px] flex-shrink-0">⚠️</span>
              <DescBlocks text={pkg.notes} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
