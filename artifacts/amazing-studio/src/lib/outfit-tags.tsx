export type OutfitTagKey =
  | "HANG_MOI_100"
  | "HANG_MOI"
  | "SIEU_MOI"
  | "HOT_PICK"
  | "FORM_DEP"
  | "GIA_TIET_KIEM"
  | "GIA_SIEU_TIET_KIEM"
  | "VAY_NUOC_1"
  | "VAY_NUOC_2"
  | "VAY_NUOC_3"
  | "VAY_NUOC_4";

export interface OutfitTagDef {
  key: OutfitTagKey;
  label: string;
  className: string;
}

export const OUTFIT_TAGS: OutfitTagDef[] = [
  {
    key: "HANG_MOI_100",
    label: "HÀNG MỚI 100%",
    className: "bg-black text-white border border-amber-300/70 shadow-sm",
  },
  {
    key: "HANG_MOI",
    label: "HÀNG MỚI",
    className: "bg-green-50 text-green-800 border border-green-200",
  },
  {
    key: "SIEU_MOI",
    label: "SIÊU MỚI",
    className: "bg-sky-50 text-sky-800 border border-sky-200",
  },
  {
    key: "HOT_PICK",
    label: "HOT PICK",
    className: "bg-pink-50 text-pink-700 border border-pink-200",
  },
  {
    key: "FORM_DEP",
    label: "FORM ĐẸP",
    className: "bg-neutral-100 text-neutral-700 border border-neutral-300",
  },
  {
    key: "GIA_TIET_KIEM",
    label: "GIÁ TIẾT KIỆM",
    className: "bg-orange-50 text-orange-700 border border-orange-200",
  },
  {
    key: "GIA_SIEU_TIET_KIEM",
    label: "GIÁ SIÊU TIẾT KIỆM",
    className: "bg-red-50 text-red-700 border border-red-200",
  },
  {
    key: "VAY_NUOC_1",
    label: "VÁY NƯỚC 1",
    className: "bg-green-50 text-green-800 border border-green-200",
  },
  {
    key: "VAY_NUOC_2",
    label: "VÁY NƯỚC 2",
    className: "bg-green-50 text-green-800 border border-green-200",
  },
  {
    key: "VAY_NUOC_3",
    label: "VÁY NƯỚC 3",
    className: "bg-green-50 text-green-800 border border-green-200",
  },
  {
    key: "VAY_NUOC_4",
    label: "VÁY NƯỚC 4",
    className: "bg-green-50 text-green-800 border border-green-200",
  },
];

const TAG_MAP: Record<string, OutfitTagDef> = Object.fromEntries(
  OUTFIT_TAGS.map((t) => [t.key, t])
);

export function getOutfitTag(key: string | null | undefined): OutfitTagDef | null {
  if (!key) return null;
  return TAG_MAP[key] ?? null;
}

export function OutfitTagBadge({
  tag,
  size = "sm",
  className = "",
}: {
  tag: string | null | undefined;
  size?: "xs" | "sm";
  className?: string;
}) {
  const t = getOutfitTag(tag);
  if (!t) return null;
  const sizing =
    size === "xs"
      ? "text-[9px] px-1.5 py-[2px]"
      : "text-[10px] px-2 py-[3px]";
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold uppercase tracking-wider whitespace-nowrap ${sizing} ${t.className} ${className}`}
    >
      {t.label}
    </span>
  );
}
