/** Nhãn hiển thị gọn cho nhóm dịch vụ (bảng giá). */
const GROUP_LABELS: Record<string, string> = {
  "ALBUM NGOẠI CẢNH": "Album cưới",
  "ALBUM TẠI STUDIO": "Album studio",
  "CHỤP TIỆC CƯỚI": "Chụp ngày cưới",
  "CHỤP CỔNG TẠI STUDIO": "Chụp cổng",
  "BEAUTY / THỜI TRANG": "Beauty",
  "COMBO CÓ MAKEUP": "Combo cưới",
  "COMBO KHÔNG MAKEUP": "Combo cưới",
  "COMBO Trang Phục cưới - CÓ MAKEUP": "Combo cưới",
  "COMBO Trang Phục cưới - Không MAKEUP": "Combo cưới",
  "QUAY PHIM": "Quay phim",
  "CHỤP GIA ĐÌNH": "Chụp gia đình",
  "MAKEUP LẺ": "Makeup lẻ",
  "IN ẢNH": "In ảnh",
};

/** Gom nhóm combo về một nhãn. */
function normalizeGroupLabel(rawName: string): string {
  const upper = rawName.toUpperCase();
  if (GROUP_LABELS[rawName]) return GROUP_LABELS[rawName];
  if (upper.includes("COMBO")) return "Combo cưới";
  if (upper.includes("CỔNG") || upper.includes("CONG")) return "Chụp cổng";
  if (upper.includes("BEAUTY") || upper.includes("THỜI TRANG")) return "Beauty";
  if (upper.includes("NGOẠI CẢNH") || upper.includes("ALBUM NGOẠI")) return "Album cưới";
  if (upper.includes("ALBUM") && upper.includes("STUDIO")) return "Album studio";
  if (upper.includes("TIỆC CƯỚI") || upper.includes("NGÀY CƯỚI")) return "Chụp ngày cưới";
  if (upper.includes("THUÊ") || upper.includes("THUE")) return "Thuê đồ";
  if (upper.includes("QUAY PHIM")) return "Quay phim";
  if (upper.includes("GIA ĐÌNH")) return "Chụp gia đình";
  if (upper.includes("MAKEUP")) return "Makeup lẻ";
  return rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
}

export type ServicePackageRef = { id: number; name: string; groupId: number | null };
export type ServiceGroupRef = { id: number; name: string };

export type BookingForGroupStats = {
  id: number;
  status: string;
  packageType?: string | null;
  serviceLabel?: string | null;
  servicePackageId?: number | null;
  parentId?: number | null;
  isParentContract?: boolean | null;
};

function norm(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function resolveGroupName(
  booking: BookingForGroupStats,
  pkgById: Map<number, ServicePackageRef>,
  pkgByName: Map<string, ServicePackageRef>,
  groupById: Map<number, string>,
): string {
  const pkgId = booking.servicePackageId;
  if (pkgId != null) {
    const pkg = pkgById.get(Number(pkgId));
    if (pkg?.groupId != null) {
      const gn = groupById.get(pkg.groupId);
      if (gn) return normalizeGroupLabel(gn);
    }
    if (pkg?.name) return normalizeGroupLabel(guessFromText(pkg.name));
  }

  const texts = [booking.serviceLabel, booking.packageType].filter(Boolean) as string[];
  for (const t of texts) {
    const exact = pkgByName.get(norm(t));
    if (exact?.groupId != null) {
      const gn = groupById.get(exact.groupId);
      if (gn) return normalizeGroupLabel(gn);
    }
    const guessed = guessFromText(t);
    if (guessed) return normalizeGroupLabel(guessed);
  }
  return "Khác";
}

function guessFromText(text: string): string {
  const n = norm(text);
  if (n.includes("thue do") || n.includes("cho thue")) return "Thuê đồ";
  if (n.includes("beauty")) return "Beauty";
  if (n.includes("cong") || n.includes("cua")) return "Chụp cổng";
  if (n.includes("ngoai canh") || n.includes("album ngoai")) return "Album cưới";
  if (n.includes("album studio") || n.includes("tai studio")) return "Album studio";
  if (n.includes("tiec cuoi") || n.includes("ngay cuoi")) return "Chụp ngày cưới";
  if (n.includes("combo")) return "Combo cưới";
  if (n.includes("quay phim")) return "Quay phim";
  if (n.includes("gia dinh")) return "Chụp gia đình";
  if (n.includes("makeup")) return "Makeup lẻ";
  return text.trim();
}

export type ServiceGroupStat = { label: string; count: number; pct: number };

export function computeServiceGroupStats(
  bookings: BookingForGroupStats[],
  packages: ServicePackageRef[],
  groups: ServiceGroupRef[],
  opts?: { excludeStatuses?: string[] },
): ServiceGroupStat[] {
  const exclude = new Set(opts?.excludeStatuses ?? ["cancelled"]);
  const pkgById = new Map(packages.map(p => [p.id, p]));
  const pkgByName = new Map<string, ServicePackageRef>();
  for (const p of packages) pkgByName.set(norm(p.name), p);
  const groupById = new Map(groups.map(g => [g.id, g.name]));

  const counts: Record<string, number> = {};
  for (const b of bookings) {
    if (exclude.has(b.status)) continue;
    if (b.isParentContract) continue;
    const label = resolveGroupName(b, pkgById, pkgByName, groupById);
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  if (total === 0) return [];

  return Object.entries(counts)
    .map(([label, count]) => ({ label, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);
}
