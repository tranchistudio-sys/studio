import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import {
  serviceGroupsTable, servicePackagesTable, packageItemsTable, surchargesTable
} from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";
import { verifyToken } from "./auth";
import { defaultRequiresPostProductionForGroupId, defaultRequiresPrintingForGroupId } from "../lib/post-production-eligibility";
import { resolveDiscount, discountWindowStatus, type DiscountConfig } from "../lib/pricing-discount";
import { clearSaleContextCache } from "../lib/sale-context";

const router: IRouter = Router();

// Mở toàn quyền module Dịch vụ & Bảng giá cho mọi nhân viên đã đăng nhập:
// nhân viên được tạo / sửa / xoá nhóm dịch vụ, gói, phụ thu như Admin.
// Vẫn yêu cầu đăng nhập để chống truy cập ẩn danh.
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) { res.status(401).json({ error: "Chưa đăng nhập" }); return false; }
  return true;
}


function toRequiresPostProductionFlag(v: unknown): boolean {
  if (v === false || v === 0 || v === "0") return false;
  if (v === true || v === 1 || v === "1") return true;
  return false;
}

function toRequiresPrintingFlag(v: unknown): boolean {
  if (v === false || v === 0 || v === "0") return false;
  if (v === true || v === 1 || v === "1") return true;
  return false;
}

function toWarnUpcomingShowFlag(v: unknown): boolean {
  if (v === true || v === 1 || v === "1") return true;
  return false;
}

// Chuẩn hoá các field discount_* thô (string numeric / Date) cho FE đọc.
const fmtDiscountFields = (o: Record<string, unknown>) => ({
  discountEnabled: Boolean(o.discountEnabled),
  discountType: (o.discountType as string | null) ?? null,
  discountValue: o.discountValue != null ? parseFloat(o.discountValue as string) : null,
  discountStartDate: (o.discountStartDate as Date | string | null) ?? null,
  discountEndDate: (o.discountEndDate as Date | string | null) ?? null,
  discountName: (o.discountName as string | null) ?? null,
  discountDescription: (o.discountDescription as string | null) ?? null,
});

// Rút DiscountConfig (cho resolveDiscount) từ 1 row group/package đã fmt.
const toDiscountConfig = (o: {
  discountEnabled?: boolean; discountType?: string | null; discountValue?: number | null;
  discountStartDate?: Date | string | null; discountEndDate?: Date | string | null;
  discountName?: string | null; discountDescription?: string | null;
}): DiscountConfig => ({
  enabled: o.discountEnabled, type: o.discountType, value: o.discountValue,
  startDate: o.discountStartDate, endDate: o.discountEndDate,
  name: o.discountName, description: o.discountDescription,
});

const fmtGroup = (g: { isActive: number; [k: string]: unknown }) => {
  const base = { ...g, isActive: Boolean(g.isActive), ...fmtDiscountFields(g) };
  return { ...base, discountStatus: discountWindowStatus(toDiscountConfig(base)) };
};

// Chuẩn hoá payload discount_* từ req.body → giá trị cột DB (dùng cho cả group/package).
function parseDiscountPayload(body: Record<string, unknown>) {
  const parseDate = (x: unknown): Date | null => {
    if (x == null || x === "") return null;
    const d = new Date(String(x));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const t = body.discountType;
  const v = body.discountValue;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  return {
    discountEnabled: body.discountEnabled === true || body.discountEnabled === 1 || body.discountEnabled === "1",
    discountType: t === "percent" || t === "fixed" ? t : null,
    discountValue: v == null || v === "" ? null : String(v),
    discountStartDate: parseDate(body.discountStartDate),
    discountEndDate: parseDate(body.discountEndDate),
    discountName: str(body.discountName),
    discountDescription: str(body.discountDescription),
  };
}

const fmtPkg = (p: {
  price: string;
  printCost?: string | null; operatingCost?: string | null; salePercent?: string | null;
  isActive: number; addons: string | null; products: string | null;
  serviceType?: string | null; photoCount?: number | null; includesMakeup?: number | null;
  includedRetouchedPhotos?: number | null;
  defaultEditingDays?: number | null;
  requiresPostProduction?: number | null;
  requiresPrinting?: number | null;
  [k: string]: unknown
}) => {
  const printCost = parseFloat((p.printCost as string) ?? "0");
  const operatingCost = parseFloat((p.operatingCost as string) ?? "0");
  const price = parseFloat(p.price);
  return {
    ...p,
    price,
    printCost,
    operatingCost,
    salePercent: parseFloat((p.salePercent as string) ?? "0"),
    isActive: Boolean(p.isActive),
    addons: p.addons ? (() => { try { return JSON.parse(p.addons!); } catch { return []; } })() : [],
    products: p.products ? (() => { try { return JSON.parse(p.products!); } catch { return []; } })() : [],
    serviceType: p.serviceType ?? null,
    photoCount: p.photoCount ?? 1,
    includesMakeup: p.includesMakeup !== 0,
    includedRetouchedPhotos: p.includedRetouchedPhotos ?? 0,
    // Task #383 Bước 2: nullable — null = chưa cấu hình → fallback logic cũ
    defaultEditingDays: p.defaultEditingDays ?? null,
    requiresPostProduction: toRequiresPostProductionFlag(p.requiresPostProduction),
    requiresPrinting: toRequiresPrintingFlag(
      p.requiresPrinting ?? (p as { requires_printing?: unknown }).requires_printing,
    ),
    warnUpcomingShow: toWarnUpcomingShowFlag(
      p.warnUpcomingShow ?? (p as { warn_upcoming_show?: unknown }).warn_upcoming_show,
    ),
    ...fmtDiscountFields(p),
  };
};

const fmtSurcharge = (s: { price: string; isActive: number; [k: string]: unknown }) => ({
  ...s, price: parseFloat(s.price), isActive: Boolean(s.isActive),
});

// ─── Addon options chuẩn (dùng trong mọi gói) ────────────────────────────────
const ADDONS_NGOAI_CANH = JSON.stringify([
  { key: "nang_album",    name: "Nâng album (30×40 → 40×60)",        price: 500000 },
  { key: "makeup_chu_re", name: "Makeup chú rể",                      price: 300000 },
  { key: "video_hau_truong", name: "Video hậu trường (1-2 phút)",     price: 800000 },
  { key: "them_ngoai_canh",  name: "Thêm 1 địa điểm ngoại cảnh",    price: 1000000 },
  { key: "nang_trang_phuc",  name: "Nâng trang phục (thêm 1 sare)",  price: 500000 },
]);

const ADDONS_STUDIO = JSON.stringify([
  { key: "nang_album",    name: "Nâng album (30×40 → 40×60)",        price: 400000 },
  { key: "makeup_chu_re", name: "Makeup chú rể",                      price: 300000 },
  { key: "video_hau_truong", name: "Video hậu trường (1-2 phút)",     price: 800000 },
  { key: "them_background",  name: "Thêm 1 background studio",        price: 300000 },
  { key: "nang_trang_phuc",  name: "Nâng trang phục (thêm 1 sare)",  price: 400000 },
]);

async function seedIfEmpty() {
  const existing = await db.select()
    .from(serviceGroupsTable)
    .where(eq(serviceGroupsTable.name, "ALBUM NGOẠI CẢNH"))
    .limit(1);
  if (existing.length > 0) return;

  // Xóa data cũ
  await db.delete(packageItemsTable);
  await db.delete(servicePackagesTable);
  await db.delete(serviceGroupsTable);

  // ─── Nhóm 1: ALBUM NGOẠI CẢNH ────────────────────────────────────────────
  const [grNC] = await db.insert(serviceGroupsTable).values([
    { name: "ALBUM NGOẠI CẢNH", description: "Chụp ảnh album tại địa điểm ngoại cảnh", sortOrder: 1 },
  ]).returning();

  const [ncBasic, ncNormal, ncLuxury] = await db.insert(servicePackagesTable).values([
    {
      groupId: grNC.id, code: "NC-BASIC", name: "Album ngoại cảnh Basic",
      price: "7500000", costPrice: "800000",
      printCost: "500000", operatingCost: "300000", salePercent: "10",
      description: "Chụp 1 địa điểm ngoại cảnh — 2 sare cô dâu",
      addons: ADDONS_NGOAI_CANH,
      products: JSON.stringify([
        "Album 30×40 (10 trang láng bóng)",
        "2 tấm hình treo tường 60×90",
        "USB + file ảnh gốc đã chỉnh màu",
      ]),
      sortOrder: 1,
    },
    {
      groupId: grNC.id, code: "NC-NORMAL", name: "Album ngoại cảnh Normal",
      price: "12000000", costPrice: "1000000",
      printCost: "700000", operatingCost: "300000", salePercent: "10",
      description: "Chụp 2 địa điểm ngoại cảnh — 3 sare + 1 vest",
      addons: ADDONS_NGOAI_CANH,
      products: JSON.stringify([
        "Album 30×40 (20 trang láng bóng)",
        "2 tấm hình treo tường 60×90 khung gỗ",
        "1 tấm hình mica gương 40×60",
        "USB + file ảnh gốc đã chỉnh màu",
      ]),
      sortOrder: 2,
    },
    {
      groupId: grNC.id, code: "NC-LUXURY", name: "Album ngoại cảnh Luxury",
      price: "18000000", costPrice: "1200000",
      printCost: "900000", operatingCost: "300000", salePercent: "10",
      description: "Chụp 3 địa điểm ngoại cảnh — 4 sare + 2 vest — photographer & makeup master",
      addons: ADDONS_NGOAI_CANH,
      products: JSON.stringify([
        "Album 40×60 (30 trang láng bóng cao cấp)",
        "4 tấm hình treo tường 60×90 khung gỗ cao cấp",
        "2 tấm hình mica gương 60×90",
        "Video slideshow nhạc nền 5 phút",
        "USB + file ảnh gốc đã chỉnh màu",
      ]),
      sortOrder: 3,
    },
  ]).returning();

  // Bao gồm — NC Basic
  await db.insert(packageItemsTable).values([
    { packageId: ncBasic.id, name: "Nhiếp ảnh gia",         quantity: "1", unit: "người",  sortOrder: 1 },
    { packageId: ncBasic.id, name: "Trang điểm cô dâu",     quantity: "1", unit: "lần",    sortOrder: 2 },
    { packageId: ncBasic.id, name: "Sare cô dâu",           quantity: "2", unit: "bộ",     sortOrder: 3 },
    { packageId: ncBasic.id, name: "Địa điểm ngoại cảnh",   quantity: "1", unit: "nơi",    sortOrder: 4 },
    { packageId: ncBasic.id, name: "Hỗ trợ phục trang",     quantity: "1", unit: "người",  sortOrder: 5 },
  ]);

  // Bao gồm — NC Normal
  await db.insert(packageItemsTable).values([
    { packageId: ncNormal.id, name: "Nhiếp ảnh gia",        quantity: "1", unit: "người",  sortOrder: 1 },
    { packageId: ncNormal.id, name: "Trang điểm cô dâu",    quantity: "1", unit: "lần",    sortOrder: 2 },
    { packageId: ncNormal.id, name: "Sare cô dâu",          quantity: "3", unit: "bộ",     sortOrder: 3 },
    { packageId: ncNormal.id, name: "Vest chú rể",          quantity: "1", unit: "bộ",     sortOrder: 4 },
    { packageId: ncNormal.id, name: "Địa điểm ngoại cảnh",  quantity: "2", unit: "nơi",    sortOrder: 5 },
    { packageId: ncNormal.id, name: "Hỗ trợ phục trang",    quantity: "1", unit: "người",  sortOrder: 6 },
  ]);

  // Bao gồm — NC Luxury
  await db.insert(packageItemsTable).values([
    { packageId: ncLuxury.id, name: "Nhiếp ảnh gia master", quantity: "1", unit: "người",  sortOrder: 1 },
    { packageId: ncLuxury.id, name: "Makeup master",        quantity: "1", unit: "người",  sortOrder: 2 },
    { packageId: ncLuxury.id, name: "Sare cô dâu",          quantity: "4", unit: "bộ",     sortOrder: 3 },
    { packageId: ncLuxury.id, name: "Vest chú rể",          quantity: "2", unit: "bộ",     sortOrder: 4 },
    { packageId: ncLuxury.id, name: "Địa điểm ngoại cảnh",  quantity: "3", unit: "nơi",    sortOrder: 5 },
    { packageId: ncLuxury.id, name: "Trợ lý kỹ thuật",     quantity: "1", unit: "người",  sortOrder: 6 },
    { packageId: ncLuxury.id, name: "Drone / flycam",       quantity: "1", unit: "buổi",   notes: "Tặng kèm", sortOrder: 7 },
  ]);

  // ─── Nhóm 2: ALBUM TẠI STUDIO ─────────────────────────────────────────────
  const [grST] = await db.insert(serviceGroupsTable).values([
    { name: "ALBUM TẠI STUDIO", description: "Chụp ảnh album tại studio với background đa dạng", sortOrder: 2 },
  ]).returning();

  const [stBasic, stNormal, stLuxury] = await db.insert(servicePackagesTable).values([
    {
      groupId: grST.id, code: "ST-BASIC", name: "Album studio Basic",
      price: "5500000", costPrice: "700000",
      printCost: "500000", operatingCost: "200000", salePercent: "10",
      description: "Chụp studio — 2 background — 2 sare cô dâu",
      addons: ADDONS_STUDIO,
      products: JSON.stringify([
        "Album 30×40 (10 trang láng bóng)",
        "2 tấm hình cổng 60×90 ép gỗ in lụa",
        "5 tấm hình 13×18 (tặng kèm)",
        "USB + file ảnh gốc đã chỉnh màu",
      ]),
      sortOrder: 1,
    },
    {
      groupId: grST.id, code: "ST-NORMAL", name: "Album studio Normal",
      price: "8500000", costPrice: "900000",
      printCost: "600000", operatingCost: "300000", salePercent: "10",
      description: "Chụp studio — 3 background — 3 sare + 1 vest",
      addons: ADDONS_STUDIO,
      products: JSON.stringify([
        "Album 30×40 (20 trang láng bóng)",
        "2 tấm hình cổng mica gương 60×90",
        "10 tấm hình 13×18 (tặng kèm)",
        "USB + file ảnh gốc đã chỉnh màu",
      ]),
      sortOrder: 2,
    },
    {
      groupId: grST.id, code: "ST-LUXURY", name: "Album studio Luxury",
      price: "14000000", costPrice: "1100000",
      printCost: "800000", operatingCost: "300000", salePercent: "10",
      description: "Chụp studio — 4 background — 4 sare + 2 vest — photographer & makeup master",
      addons: ADDONS_STUDIO,
      products: JSON.stringify([
        "Album 40×60 (30 trang bìa da cao cấp)",
        "4 tấm hình cổng mica gương 60×90 khung gỗ cao cấp",
        "Video slideshow nhạc nền 5 phút",
        "USB + file ảnh gốc đã chỉnh màu",
      ]),
      sortOrder: 3,
    },
  ]).returning();

  // Bao gồm — ST Basic
  await db.insert(packageItemsTable).values([
    { packageId: stBasic.id, name: "Nhiếp ảnh gia",         quantity: "1", unit: "người",  sortOrder: 1 },
    { packageId: stBasic.id, name: "Trang điểm cô dâu",     quantity: "1", unit: "lần",    sortOrder: 2 },
    { packageId: stBasic.id, name: "Sare cô dâu",           quantity: "2", unit: "bộ",     sortOrder: 3 },
    { packageId: stBasic.id, name: "Background studio",     quantity: "2", unit: "cái",    sortOrder: 4 },
  ]);

  // Bao gồm — ST Normal
  await db.insert(packageItemsTable).values([
    { packageId: stNormal.id, name: "Nhiếp ảnh gia",        quantity: "1", unit: "người",  sortOrder: 1 },
    { packageId: stNormal.id, name: "Trang điểm cô dâu",    quantity: "1", unit: "lần",    sortOrder: 2 },
    { packageId: stNormal.id, name: "Sare cô dâu",          quantity: "3", unit: "bộ",     sortOrder: 3 },
    { packageId: stNormal.id, name: "Vest chú rể",          quantity: "1", unit: "bộ",     sortOrder: 4 },
    { packageId: stNormal.id, name: "Background studio",    quantity: "3", unit: "cái",    sortOrder: 5 },
  ]);

  // Bao gồm — ST Luxury
  await db.insert(packageItemsTable).values([
    { packageId: stLuxury.id, name: "Nhiếp ảnh gia master", quantity: "1", unit: "người",  sortOrder: 1 },
    { packageId: stLuxury.id, name: "Makeup master",        quantity: "1", unit: "người",  sortOrder: 2 },
    { packageId: stLuxury.id, name: "Sare cô dâu",          quantity: "4", unit: "bộ",     sortOrder: 3 },
    { packageId: stLuxury.id, name: "Vest chú rể",          quantity: "2", unit: "bộ",     sortOrder: 4 },
    { packageId: stLuxury.id, name: "Background studio",    quantity: "4", unit: "cái",    sortOrder: 5 },
    { packageId: stLuxury.id, name: "Trợ lý kỹ thuật",     quantity: "1", unit: "người",  sortOrder: 6 },
  ]);
}

seedIfEmpty().catch(console.error);

// ─── Addon: Chụp tiệc cưới ───────────────────────────────────────────────────
const ADDONS_TIEC_CUOI = JSON.stringify([
  { key: "ruoc_dau",      name: "Rước dâu",                          price: 500000 },
  { key: "tang_gio",      name: "Tăng giờ chiều / tối",              price: 2000000 },
  { key: "tiec_40_ban",   name: "Tiệc trên 40 bàn",                  price: 500000 },
  { key: "video_hau_truong", name: "Video hậu trường (1-2 phút)",    price: 300000 },
]);

async function seedTiecCuoiIfMissing() {
  const existing = await db.select()
    .from(serviceGroupsTable)
    .where(eq(serviceGroupsTable.name, "CHỤP TIỆC CƯỚI"))
    .limit(1);
  if (existing.length > 0) return;

  // ─── Nhóm 3: CHỤP TIỆC CƯỚI ─────────────────────────────────────────────
  const [grTiec] = await db.insert(serviceGroupsTable).values([
    { name: "CHỤP TIỆC CƯỚI", description: "Gói chụp ảnh phóng sự tiệc cưới", sortOrder: 3 },
  ]).returning();

  const [pkTiec, pkTiecLe, pkPhongSu1, pkPhongSu2] = await db.insert(servicePackagesTable).values([
    {
      groupId: grTiec.id, code: "TC-TRUYEN-THONG", name: "Gói truyền thống (tiệc)",
      price: "3000000", costPrice: "0",
      printCost: "0", operatingCost: "0", salePercent: "10",
      description: "1 photographer — chỉ chụp tiệc, không có lễ",
      serviceType: "tiec", photoCount: 1,
      addons: ADDONS_TIEC_CUOI,
      products: JSON.stringify([
        "200–300 ảnh đã chỉnh màu",
        "File gốc USB / Google Drive",
      ]),
      sortOrder: 1,
    },
    {
      groupId: grTiec.id, code: "TC-TRUYEN-THONG-LE", name: "Gói truyền thống (tiệc + lễ)",
      price: "3500000", costPrice: "0",
      printCost: "0", operatingCost: "0", salePercent: "10",
      description: "1 photographer — chụp cả lễ & tiệc",
      serviceType: "tiec_le", photoCount: 1,
      addons: ADDONS_TIEC_CUOI,
      products: JSON.stringify([
        "300–400 ảnh đã chỉnh màu (lễ + tiệc)",
        "File gốc USB / Google Drive",
      ]),
      sortOrder: 2,
    },
    {
      groupId: grTiec.id, code: "TC-PHONG-SU-1P", name: "Gói phóng sự 1 photo",
      price: "4500000", costPrice: "0",
      printCost: "0", operatingCost: "0", salePercent: "10",
      description: "1 photographer chuyên nghiệp — phong cách phóng sự báo chí",
      serviceType: "phong_su", photoCount: 1,
      addons: ADDONS_TIEC_CUOI,
      products: JSON.stringify([
        "400–500 ảnh phóng sự đã chỉnh màu",
        "20 ảnh retouch kỹ",
        "File gốc USB / Google Drive",
      ]),
      sortOrder: 3,
    },
    {
      groupId: grTiec.id, code: "TC-PHONG-SU-2P", name: "Gói phóng sự 2 photo",
      price: "7000000", costPrice: "0",
      printCost: "0", operatingCost: "0", salePercent: "10",
      description: "2 photographers — phong cách phóng sự — góc chụp toàn diện",
      serviceType: "phong_su_luxury", photoCount: 2,
      addons: ADDONS_TIEC_CUOI,
      products: JSON.stringify([
        "600–800 ảnh phóng sự đã chỉnh màu (2 góc chụp)",
        "30 ảnh retouch kỹ",
        "File gốc USB / Google Drive",
      ]),
      sortOrder: 4,
    },
  ]).returning();

  // Bao gồm — Gói tiệc
  await db.insert(packageItemsTable).values([
    { packageId: pkTiec.id, name: "Nhiếp ảnh gia", quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: pkTiec.id, name: "Chụp tiệc",     quantity: "1", unit: "buổi",  sortOrder: 2 },
  ]);
  // Bao gồm — Gói tiệc + lễ
  await db.insert(packageItemsTable).values([
    { packageId: pkTiecLe.id, name: "Nhiếp ảnh gia",           quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: pkTiecLe.id, name: "Chụp lễ gia tiên / cưới", quantity: "1", unit: "buổi",  sortOrder: 2 },
    { packageId: pkTiecLe.id, name: "Chụp tiệc",               quantity: "1", unit: "buổi",  sortOrder: 3 },
  ]);
  // Bao gồm — Gói phóng sự 1 photo
  await db.insert(packageItemsTable).values([
    { packageId: pkPhongSu1.id, name: "Nhiếp ảnh gia phóng sự", quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: pkPhongSu1.id, name: "Chụp lễ + tiệc",         quantity: "1", unit: "buổi",  sortOrder: 2 },
  ]);
  // Bao gồm — Gói phóng sự 2 photo
  await db.insert(packageItemsTable).values([
    { packageId: pkPhongSu2.id, name: "Nhiếp ảnh gia phóng sự", quantity: "2", unit: "người", notes: "2 góc chụp đồng thời", sortOrder: 1 },
    { packageId: pkPhongSu2.id, name: "Chụp lễ + tiệc",         quantity: "1", unit: "buổi",  sortOrder: 2 },
  ]);

  console.log("[seed] CHỤP TIỆC CƯỚI — 4 gói đã được thêm.");
}

seedTiecCuoiIfMissing().catch(console.error);

// ─── Addon: Combo ngày cưới ───────────────────────────────────────────────────
const ADDONS_COMBO = JSON.stringify([
  { key: "nang_sare",      name: "Nâng sare (thêm 1 bộ)",               price: 500000 },
  { key: "them_vest",      name: "Thêm 1 bộ vest chú rể",               price: 300000 },
  { key: "thue_mam_qua",  name: "Thuê mâm quả",                         price: 500000 },
  { key: "them_hoa_xe",   name: "Thêm hoa xe cưới",                     price: 500000 },
  { key: "nang_ao_dai",   name: "Nâng áo dài mẹ (thêm 1 bộ)",          price: 300000 },
]);

async function seedComboIfMissing() {
  const existing = await db.select()
    .from(serviceGroupsTable)
    .where(eq(serviceGroupsTable.name, "COMBO CÓ MAKEUP"))
    .limit(1);
  if (existing.length > 0) return;

  // ─── Nhóm 4: COMBO CÓ MAKEUP ─────────────────────────────────────────────
  const [grComboMK] = await db.insert(serviceGroupsTable).values([
    { name: "COMBO CÓ MAKEUP", description: "Combo ngày cưới bao gồm dịch vụ makeup", sortOrder: 4 },
  ]).returning();

  const [cmSilver, cmGold, cmDiamond, cmLuxury] = await db.insert(servicePackagesTable).values([
    {
      groupId: grComboMK.id, code: "CM-SILVER", name: "Combo Makeup Silver",
      price: "6000000", costPrice: "0",
      printCost: "0", operatingCost: "500000", salePercent: "10",
      description: "1 sare + vest + makeup cô dâu + mâm quả",
      serviceType: "combo_co_makeup", photoCount: 1, includesMakeup: 1,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 1,
    },
    {
      groupId: grComboMK.id, code: "CM-GOLD", name: "Combo Makeup Gold",
      price: "9000000", costPrice: "0",
      printCost: "0", operatingCost: "500000", salePercent: "10",
      description: "2 sare + vest + makeup cô dâu & chú rể + mâm quả",
      serviceType: "combo_co_makeup", photoCount: 1, includesMakeup: 1,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 2,
    },
    {
      groupId: grComboMK.id, code: "CM-DIAMOND", name: "Combo Makeup Diamond",
      price: "11000000", costPrice: "0",
      printCost: "0", operatingCost: "500000", salePercent: "10",
      description: "2 sare nâng cao + vest + 2 lần makeup (tiệc + cổng) + hoa xe + mâm quả",
      serviceType: "combo_co_makeup", photoCount: 1, includesMakeup: 1,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 3,
    },
    {
      groupId: grComboMK.id, code: "CM-LUXURY", name: "Combo Makeup Luxury",
      price: "13000000", costPrice: "0",
      printCost: "0", operatingCost: "500000", salePercent: "10",
      description: "3 sare luxury + vest + 3 lần makeup (tiệc + cổng + xu) + hoa xe + mâm quả lớn",
      serviceType: "combo_co_makeup", photoCount: 1, includesMakeup: 1,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 4,
    },
  ]).returning();

  // Items — Combo có makeup
  await db.insert(packageItemsTable).values([
    { packageId: cmSilver.id,  name: "Sare cô dâu",                   quantity: "1", unit: "bộ", sortOrder: 1 },
    { packageId: cmSilver.id,  name: "Vest chú rể",                   quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cmSilver.id,  name: "Makeup cô dâu",                 quantity: "1", unit: "lần", sortOrder: 3 },
    { packageId: cmSilver.id,  name: "Mâm quả",                       quantity: "1", unit: "bộ", sortOrder: 4 },
    { packageId: cmSilver.id,  name: "Hoa cầm tay + hoa cài áo",     quantity: "1", unit: "bộ", sortOrder: 5 },

    { packageId: cmGold.id,    name: "Sare cô dâu",                   quantity: "2", unit: "bộ", sortOrder: 1 },
    { packageId: cmGold.id,    name: "Vest chú rể",                   quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cmGold.id,    name: "Makeup cô dâu + chú rể",        quantity: "1", unit: "lần", sortOrder: 3 },
    { packageId: cmGold.id,    name: "Mâm quả",                       quantity: "1", unit: "bộ", sortOrder: 4 },
    { packageId: cmGold.id,    name: "Hoa cầm tay + hoa cài áo",     quantity: "1", unit: "bộ", sortOrder: 5 },

    { packageId: cmDiamond.id, name: "Sare cô dâu nâng cao",         quantity: "2", unit: "bộ", sortOrder: 1 },
    { packageId: cmDiamond.id, name: "Vest chú rể",                   quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cmDiamond.id, name: "Makeup (tiệc + cổng)",          quantity: "2", unit: "lần", sortOrder: 3 },
    { packageId: cmDiamond.id, name: "Hoa xe cưới",                   quantity: "1", unit: "bộ", sortOrder: 4 },
    { packageId: cmDiamond.id, name: "Mâm quả",                       quantity: "1", unit: "bộ", sortOrder: 5 },
    { packageId: cmDiamond.id, name: "Hoa cầm tay + hoa cài áo",     quantity: "1", unit: "bộ", sortOrder: 6 },

    { packageId: cmLuxury.id,  name: "Sare cô dâu luxury",            quantity: "3", unit: "bộ", sortOrder: 1 },
    { packageId: cmLuxury.id,  name: "Vest chú rể",                   quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cmLuxury.id,  name: "Makeup (tiệc + cổng + xu)",     quantity: "3", unit: "lần", sortOrder: 3 },
    { packageId: cmLuxury.id,  name: "Áo dài mẹ cô dâu",             quantity: "1", unit: "bộ", sortOrder: 4 },
    { packageId: cmLuxury.id,  name: "Hoa xe cưới",                   quantity: "1", unit: "bộ", sortOrder: 5 },
    { packageId: cmLuxury.id,  name: "Mâm quả lớn",                   quantity: "1", unit: "bộ", sortOrder: 6 },
    { packageId: cmLuxury.id,  name: "Hoa cầm tay + hoa cài áo",     quantity: "1", unit: "bộ", sortOrder: 7 },
  ]);

  // ─── Nhóm 5: COMBO KHÔNG MAKEUP ──────────────────────────────────────────
  const [grComboNoMK] = await db.insert(serviceGroupsTable).values([
    { name: "COMBO KHÔNG MAKEUP", description: "Combo ngày cưới không bao gồm dịch vụ makeup", sortOrder: 5 },
  ]).returning();

  const [cnSilver, cnGold, cnDiamond, cnLuxury] = await db.insert(servicePackagesTable).values([
    {
      groupId: grComboNoMK.id, code: "CN-SILVER", name: "Combo Không Makeup Silver",
      price: "4500000", costPrice: "0",
      printCost: "0", operatingCost: "300000", salePercent: "10",
      description: "1 sare + vest + mâm quả — không bao gồm makeup",
      serviceType: "combo_khong_makeup", photoCount: 1, includesMakeup: 0,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 1,
    },
    {
      groupId: grComboNoMK.id, code: "CN-GOLD", name: "Combo Không Makeup Gold",
      price: "5900000", costPrice: "0",
      printCost: "0", operatingCost: "300000", salePercent: "10",
      description: "2 sare + vest + mâm quả — không bao gồm makeup",
      serviceType: "combo_khong_makeup", photoCount: 1, includesMakeup: 0,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 2,
    },
    {
      groupId: grComboNoMK.id, code: "CN-DIAMOND", name: "Combo Không Makeup Diamond",
      price: "7900000", costPrice: "0",
      printCost: "0", operatingCost: "300000", salePercent: "10",
      description: "2 sare + vest + hoa xe + mâm quả — không bao gồm makeup",
      serviceType: "combo_khong_makeup", photoCount: 1, includesMakeup: 0,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 3,
    },
    {
      groupId: grComboNoMK.id, code: "CN-LUXURY", name: "Combo Không Makeup Luxury",
      price: "9900000", costPrice: "0",
      printCost: "0", operatingCost: "300000", salePercent: "10",
      description: "3 sare + vest + hoa xe + mâm quả lớn + áo dài mẹ — không bao gồm makeup",
      serviceType: "combo_khong_makeup", photoCount: 1, includesMakeup: 0,
      addons: ADDONS_COMBO,
      products: JSON.stringify(["Trang phục thuê ngày cưới", "Phụ kiện đính kèm"]),
      sortOrder: 4,
    },
  ]).returning();

  // Items — Combo không makeup
  await db.insert(packageItemsTable).values([
    { packageId: cnSilver.id,  name: "Sare cô dâu",               quantity: "1", unit: "bộ", sortOrder: 1 },
    { packageId: cnSilver.id,  name: "Vest chú rể",               quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cnSilver.id,  name: "Mâm quả",                   quantity: "1", unit: "bộ", sortOrder: 3 },
    { packageId: cnSilver.id,  name: "Hoa cầm tay + hoa cài áo", quantity: "1", unit: "bộ", sortOrder: 4 },

    { packageId: cnGold.id,    name: "Sare cô dâu",               quantity: "2", unit: "bộ", sortOrder: 1 },
    { packageId: cnGold.id,    name: "Vest chú rể",               quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cnGold.id,    name: "Mâm quả",                   quantity: "1", unit: "bộ", sortOrder: 3 },
    { packageId: cnGold.id,    name: "Hoa cầm tay + hoa cài áo", quantity: "1", unit: "bộ", sortOrder: 4 },

    { packageId: cnDiamond.id, name: "Sare cô dâu",               quantity: "2", unit: "bộ", sortOrder: 1 },
    { packageId: cnDiamond.id, name: "Vest chú rể",               quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cnDiamond.id, name: "Hoa xe cưới",               quantity: "1", unit: "bộ", sortOrder: 3 },
    { packageId: cnDiamond.id, name: "Mâm quả",                   quantity: "1", unit: "bộ", sortOrder: 4 },
    { packageId: cnDiamond.id, name: "Hoa cầm tay + hoa cài áo", quantity: "1", unit: "bộ", sortOrder: 5 },

    { packageId: cnLuxury.id,  name: "Sare cô dâu",               quantity: "3", unit: "bộ", sortOrder: 1 },
    { packageId: cnLuxury.id,  name: "Vest chú rể",               quantity: "1", unit: "bộ", sortOrder: 2 },
    { packageId: cnLuxury.id,  name: "Áo dài mẹ cô dâu",         quantity: "1", unit: "bộ", sortOrder: 3 },
    { packageId: cnLuxury.id,  name: "Hoa xe cưới",               quantity: "1", unit: "bộ", sortOrder: 4 },
    { packageId: cnLuxury.id,  name: "Mâm quả lớn",               quantity: "1", unit: "bộ", sortOrder: 5 },
    { packageId: cnLuxury.id,  name: "Hoa cầm tay + hoa cài áo", quantity: "1", unit: "bộ", sortOrder: 6 },
  ]);

  console.log("[seed] COMBO CÓ MAKEUP + COMBO KHÔNG MAKEUP — 8 gói đã được thêm.");
}

seedComboIfMissing().catch(console.error);

// ─── Seed: Nhóm dịch vụ mới ──────────────────────────────────────────────────

async function seedQuayPhimIfMissing() {
  const ex = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.name, "QUAY PHIM")).limit(1);
  if (ex.length > 0) return;
  const [gr] = await db.insert(serviceGroupsTable).values([
    { name: "QUAY PHIM", description: "Gói quay phim ngày cưới", sortOrder: 6 },
  ]).returning();
  const [p1, p2, p3] = await db.insert(servicePackagesTable).values([
    {
      groupId: gr.id, code: "QP-TRUYEN-THONG", name: "Quay phim truyền thống",
      price: "5000000", costPrice: "0", printCost: "0", operatingCost: "300000", salePercent: "10",
      serviceType: "quay_phim", photoCount: 1, includesMakeup: 0,
      description: "Quay phim phong cách truyền thống — 1 cameraman — dựng phim khoảng 10–15 phút.\n\nPhù hợp: Các cặp đôi muốn lưu giữ toàn bộ khoảnh khắc ngày cưới theo phong cách trang trọng, đầy đủ.\n\nLưu ý: Thời gian giao phim 7–10 ngày sau sự kiện.",
      notes: "Giao phim sau 7–10 ngày. Định dạng MP4 Full HD.",
      addons: JSON.stringify([
        { key: "len_4k",      name: "Nâng chất lượng lên 4K",         price: 1000000 },
        { key: "them_drone",  name: "Thêm flycam (drone)",             price: 2000000 },
        { key: "phim_ngan",   name: "Thêm phim ngắn highlight 3 phút", price: 500000 },
      ]),
      products: JSON.stringify(["Phim hoàn chỉnh 10–15 phút (MP4 Full HD)", "USB lưu trữ", "Link Google Drive"]),
      sortOrder: 1,
    },
    {
      groupId: gr.id, code: "QP-PHONG-SU-1", name: "Quay phóng sự 1 máy",
      price: "6000000", costPrice: "0", printCost: "0", operatingCost: "300000", salePercent: "10",
      serviceType: "quay_phim", photoCount: 1, includesMakeup: 0,
      description: "Quay phóng sự phong cách điện ảnh — 1 cameraman chuyên nghiệp — dựng phim 15–20 phút.\n\nBao gồm: Quay toàn bộ lễ + tiệc, âm nhạc cảm xúc, màu sắc chuyên nghiệp.\n\nPhù hợp: Các cặp đôi muốn bộ phim mang phong cách hiện đại, kể chuyện theo cảm xúc.\n\nLưu ý: Giao phim 10–14 ngày sau sự kiện.",
      notes: "Giao phim sau 10–14 ngày. Định dạng MP4 Full HD / 4K tùy yêu cầu.",
      addons: JSON.stringify([
        { key: "len_4k",      name: "Nâng chất lượng lên 4K",         price: 1000000 },
        { key: "them_drone",  name: "Thêm flycam (drone)",             price: 2000000 },
        { key: "phim_ngan",   name: "Thêm phim ngắn highlight 3 phút", price: 500000 },
        { key: "them_cam2",   name: "Thêm cameraman thứ 2",            price: 2000000 },
      ]),
      products: JSON.stringify(["Phim hoàn chỉnh 15–20 phút (MP4 Full HD)", "USB lưu trữ", "Link Google Drive"]),
      sortOrder: 2,
    },
    {
      groupId: gr.id, code: "QP-PHONG-SU-DRONE", name: "Quay phóng sự + flycam",
      price: "7800000", costPrice: "0", printCost: "0", operatingCost: "400000", salePercent: "10",
      serviceType: "quay_phim", photoCount: 1, includesMakeup: 0,
      description: "Quay phóng sự điện ảnh kết hợp flycam — 1 cameraman + 1 drone operator — dựng phim 15–25 phút.\n\nBao gồm: Quay mặt đất + cảnh flycam ngoài trời, dựng phim chuyên nghiệp với hiệu ứng màu điện ảnh.\n\nPhù hợp: Tiệc có sân ngoài trời, biệt thự, resort, địa điểm rộng.\n\nLưu ý: Chỉ bay flycam tại khu vực được phép. Giao phim 10–14 ngày.",
      notes: "Cần xác nhận địa điểm cho phép bay drone trước sự kiện. Giao phim 10–14 ngày.",
      addons: JSON.stringify([
        { key: "len_4k",      name: "Nâng chất lượng lên 4K",         price: 1000000 },
        { key: "phim_ngan",   name: "Thêm phim ngắn highlight 3 phút", price: 500000 },
        { key: "them_cam2",   name: "Thêm cameraman thứ 2",            price: 2000000 },
      ]),
      products: JSON.stringify(["Phim hoàn chỉnh 15–25 phút (MP4 Full HD)", "Cảnh quay flycam", "USB lưu trữ", "Link Google Drive"]),
      sortOrder: 3,
    },
  ]).returning();
  await db.insert(packageItemsTable).values([
    { packageId: p1.id, name: "Cameraman",            quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: p1.id, name: "Quay lễ + tiệc",       quantity: "1", unit: "buổi",  sortOrder: 2 },
    { packageId: p1.id, name: "Dựng phim + âm nhạc",  quantity: "1", unit: "lần",   sortOrder: 3 },
    { packageId: p2.id, name: "Cameraman phóng sự",   quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: p2.id, name: "Quay lễ + tiệc",       quantity: "1", unit: "buổi",  sortOrder: 2 },
    { packageId: p2.id, name: "Dựng phim điện ảnh",   quantity: "1", unit: "lần",   sortOrder: 3 },
    { packageId: p3.id, name: "Cameraman phóng sự",   quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: p3.id, name: "Drone operator",        quantity: "1", unit: "người", sortOrder: 2 },
    { packageId: p3.id, name: "Quay lễ + tiệc + bay", quantity: "1", unit: "buổi",  sortOrder: 3 },
    { packageId: p3.id, name: "Dựng phim điện ảnh",   quantity: "1", unit: "lần",   sortOrder: 4 },
  ]);
  console.log("[seed] QUAY PHIM — 3 gói đã thêm.");
}

async function seedBeautyIfMissing() {
  // Check both old name AND new name to prevent re-creation after rename
  const exOld = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.name, "CHỤP BEAUTY")).limit(1);
  const exNew = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.name, "BEAUTY / THỜI TRANG")).limit(1);
  if (exOld.length > 0 || exNew.length > 0) return;
  const [gr] = await db.insert(serviceGroupsTable).values([
    { name: "CHỤP BEAUTY", description: "Gói chụp ảnh beauty cá nhân", sortOrder: 7 },
  ]).returning();
  const [p1, p2] = await db.insert(servicePackagesTable).values([
    {
      groupId: gr.id, code: "BT-CHUYEN-VIEN", name: "Chụp beauty chuyên viên",
      price: "1400000", costPrice: "0", printCost: "0", operatingCost: "100000", salePercent: "10",
      serviceType: "beauty", photoCount: 1, includesMakeup: 1,
      description: "Buổi chụp ảnh beauty cơ bản — makeup chuyên viên — tại studio.\n\nBao gồm: 1 chuyên viên makeup, 1 photographer, 2–3 bộ trang phục (tự chuẩn bị), 50–80 ảnh đã chỉnh màu.\n\nPhù hợp: Chụp ảnh cá nhân, ảnh đại diện, ảnh kỷ niệm sinh nhật, kỷ niệm.\n\nLưu ý: Thời gian chụp 2–3 tiếng. Khách tự chuẩn bị trang phục.",
      notes: "Thời gian 2–3 tiếng. Khách chuẩn bị trang phục. Giao ảnh sau 3–5 ngày.",
      addons: JSON.stringify([
        { key: "them_trang_phuc", name: "Thuê thêm trang phục studio", price: 300000 },
        { key: "nang_master",     name: "Nâng lên makeup Master",       price: 600000 },
        { key: "them_location",   name: "Thêm 1 địa điểm ngoại cảnh",  price: 500000 },
      ]),
      products: JSON.stringify(["50–80 ảnh đã chỉnh màu", "10 ảnh retouch kỹ", "File gốc USB / Google Drive"]),
      sortOrder: 1,
    },
    {
      groupId: gr.id, code: "BT-MASTER", name: "Chụp beauty master",
      price: "2000000", costPrice: "0", printCost: "0", operatingCost: "100000", salePercent: "10",
      serviceType: "beauty", photoCount: 1, includesMakeup: 1,
      description: "Buổi chụp ảnh beauty cao cấp — makeup Master — tại studio hoặc ngoại cảnh.\n\nBao gồm: 1 makeup Master, 1 photographer, trang phục studio (1–2 bộ), 80–120 ảnh đã chỉnh màu.\n\nPhù hợp: Chụp ảnh nghệ thuật, profile chuyên nghiệp, thương hiệu cá nhân.\n\nLưu ý: Thời gian 3–4 tiếng. Trang phục studio được cung cấp 1–2 bộ.",
      notes: "Thời gian 3–4 tiếng. Studio cung cấp 1–2 bộ trang phục. Giao ảnh 5–7 ngày.",
      addons: JSON.stringify([
        { key: "them_trang_phuc", name: "Thuê thêm trang phục studio", price: 300000 },
        { key: "them_location",   name: "Thêm 1 địa điểm ngoại cảnh",  price: 500000 },
        { key: "video_tease",     name: "Video teaser 30 giây",         price: 500000 },
      ]),
      products: JSON.stringify(["80–120 ảnh đã chỉnh màu", "20 ảnh retouch kỹ", "File gốc USB / Google Drive"]),
      sortOrder: 2,
    },
  ]).returning();
  await db.insert(packageItemsTable).values([
    { packageId: p1.id, name: "Makeup chuyên viên",  quantity: "1", unit: "lần",   sortOrder: 1 },
    { packageId: p1.id, name: "Photographer",         quantity: "1", unit: "người", sortOrder: 2 },
    { packageId: p1.id, name: "Chụp tại studio",     quantity: "1", unit: "buổi",  sortOrder: 3 },
    { packageId: p2.id, name: "Makeup Master",        quantity: "1", unit: "lần",   sortOrder: 1 },
    { packageId: p2.id, name: "Photographer",         quantity: "1", unit: "người", sortOrder: 2 },
    { packageId: p2.id, name: "Trang phục studio",   quantity: "1-2", unit: "bộ",  sortOrder: 3 },
    { packageId: p2.id, name: "Chụp studio / ngoại", quantity: "1", unit: "buổi",  sortOrder: 4 },
  ]);
  console.log("[seed] CHỤP BEAUTY — 2 gói đã thêm.");
}

async function seedGiaDinhIfMissing() {
  const ex = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.name, "CHỤP GIA ĐÌNH")).limit(1);
  if (ex.length > 0) return;
  const [gr] = await db.insert(serviceGroupsTable).values([
    { name: "CHỤP GIA ĐÌNH", description: "Gói chụp ảnh gia đình", sortOrder: 8 },
  ]).returning();
  const [p1, p2, p3] = await db.insert(servicePackagesTable).values([
    {
      groupId: gr.id, code: "GD-BASIC", name: "Chụp gia đình Basic",
      price: "1500000", costPrice: "0", printCost: "0", operatingCost: "100000", salePercent: "10",
      serviceType: "gia_dinh", photoCount: 1, includesMakeup: 0,
      description: "Buổi chụp ảnh gia đình tại studio — 1–2 tiếng — dành cho gia đình 3–5 người.\n\nBao gồm: 1 photographer, chụp tại studio, 2–3 bối cảnh, 50–70 ảnh đã chỉnh màu.\n\nPhù hợp: Ảnh gia đình hàng năm, ảnh tết, ảnh lưu niệm, ảnh treo tường.\n\nLưu ý: Thêm người (trên 5 người) phụ thu 200k/người.",
      notes: "Phụ thu 200k/người nếu trên 5 người. Thời gian 1–2 tiếng.",
      addons: JSON.stringify([
        { key: "them_nguoi",   name: "Thêm người (>5 người)",          price: 200000 },
        { key: "them_location",name: "Thêm ngoại cảnh",               price: 500000 },
        { key: "in_anh_lon",   name: "In ảnh 40×60 cm",               price: 200000 },
      ]),
      products: JSON.stringify(["50–70 ảnh đã chỉnh màu", "File gốc USB / Google Drive"]),
      sortOrder: 1,
    },
    {
      groupId: gr.id, code: "GD-STANDARD", name: "Chụp gia đình Standard",
      price: "1800000", costPrice: "0", printCost: "0", operatingCost: "100000", salePercent: "10",
      serviceType: "gia_dinh", photoCount: 1, includesMakeup: 0,
      description: "Buổi chụp ảnh gia đình studio + ngoại cảnh — 2–3 tiếng — dành cho gia đình 3–7 người.\n\nBao gồm: 1 photographer, studio + 1 địa điểm ngoại cảnh, 70–100 ảnh đã chỉnh màu.\n\nPhù hợp: Ảnh gia đình đa dạng cảnh, ảnh kỷ niệm đặc biệt.\n\nLưu ý: Thêm người trên 7 người phụ thu 200k/người.",
      notes: "Phụ thu 200k/người nếu trên 7 người. Thời gian 2–3 tiếng.",
      addons: JSON.stringify([
        { key: "them_nguoi",   name: "Thêm người (>7 người)",          price: 200000 },
        { key: "them_location",name: "Thêm địa điểm ngoại cảnh",      price: 500000 },
        { key: "in_anh_lon",   name: "In ảnh 40×60 cm",               price: 200000 },
      ]),
      products: JSON.stringify(["70–100 ảnh đã chỉnh màu", "10 ảnh retouch kỹ", "File gốc USB / Google Drive"]),
      sortOrder: 2,
    },
    {
      groupId: gr.id, code: "GD-PREMIUM", name: "Chụp gia đình Premium",
      price: "2500000", costPrice: "0", printCost: "0", operatingCost: "100000", salePercent: "10",
      serviceType: "gia_dinh", photoCount: 1, includesMakeup: 0,
      description: "Buổi chụp ảnh gia đình nửa ngày — 3–5 tiếng — dành cho gia đình đông người hoặc nhiều thế hệ.\n\nBao gồm: 1 photographer, 2 địa điểm ngoại cảnh / nhiều bối cảnh studio, 100–150 ảnh đã chỉnh màu, 15 ảnh retouch kỹ.\n\nPhù hợp: Ảnh đại gia đình, ảnh 3 thế hệ, ảnh kỷ niệm đặc biệt.\n\nLưu ý: Không giới hạn số người trong gia đình.",
      notes: "Không giới hạn số người. Thời gian 3–5 tiếng. Giao ảnh 5–7 ngày.",
      addons: JSON.stringify([
        { key: "them_location",name: "Thêm địa điểm ngoại cảnh",      price: 500000 },
        { key: "in_anh_lon",   name: "In ảnh 40×60 cm",               price: 200000 },
        { key: "album_gia_dinh", name: "Album gia đình 20×30",        price: 800000 },
      ]),
      products: JSON.stringify(["100–150 ảnh đã chỉnh màu", "15 ảnh retouch kỹ", "File gốc USB / Google Drive"]),
      sortOrder: 3,
    },
  ]).returning();
  await db.insert(packageItemsTable).values([
    { packageId: p1.id, name: "Photographer",     quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: p1.id, name: "Chụp tại studio", quantity: "1", unit: "buổi",  sortOrder: 2 },
    { packageId: p2.id, name: "Photographer",     quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: p2.id, name: "Studio + ngoại cảnh", quantity: "1+1", unit: "bối cảnh", sortOrder: 2 },
    { packageId: p3.id, name: "Photographer",     quantity: "1", unit: "người", sortOrder: 1 },
    { packageId: p3.id, name: "Địa điểm",        quantity: "2", unit: "nơi",   sortOrder: 2 },
    { packageId: p3.id, name: "Thời gian",        quantity: "3-5", unit: "tiếng", sortOrder: 3 },
  ]);
  console.log("[seed] CHỤP GIA ĐÌNH — 3 gói đã thêm.");
}

async function seedMakeupLeIfMissing() {
  const ex = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.name, "MAKEUP LẺ")).limit(1);
  if (ex.length > 0) return;
  const [gr] = await db.insert(serviceGroupsTable).values([
    { name: "MAKEUP LẺ", description: "Dịch vụ makeup riêng lẻ không kèm chụp ảnh", sortOrder: 9 },
  ]).returning();
  await db.insert(servicePackagesTable).values([
    {
      groupId: gr.id, code: "MK-CO-DAU-CV", name: "Makeup cô dâu chuyên viên",
      price: "1500000", costPrice: "0", printCost: "0", operatingCost: "50000", salePercent: "10",
      serviceType: "makeup_le", photoCount: 0, includesMakeup: 1,
      description: "Dịch vụ makeup cô dâu by chuyên viên — 1 lần — tại studio hoặc tại nhà.\n\nBao gồm: Makeup hoàn chỉnh cô dâu, tóc cô dâu (1 kiểu), phụ kiện tóc cơ bản.\n\nPhù hợp: Cô dâu ngày tiệc, lễ gia tiên, lễ đính hôn.\n\nLưu ý: Di chuyển xa trên 10km phụ thu thêm.",
      notes: "Phụ thu di chuyển xa > 10km. Thời gian makeup 1.5–2 tiếng.",
      addons: JSON.stringify([
        { key: "them_lan_makeup", name: "Thêm lần makeup",             price: 1000000 },
        { key: "them_toc",        name: "Thêm 1 kiểu tóc",             price: 200000 },
      ]),
      products: JSON.stringify(["Makeup + tóc hoàn chỉnh 1 lần", "Phụ kiện tóc cơ bản"]),
      sortOrder: 1,
    },
    {
      groupId: gr.id, code: "MK-CO-DAU-MASTER", name: "Makeup cô dâu Master",
      price: "2500000", costPrice: "0", printCost: "0", operatingCost: "50000", salePercent: "10",
      serviceType: "makeup_le", photoCount: 0, includesMakeup: 1,
      description: "Dịch vụ makeup cô dâu by Master — 1 lần — kỹ thuật cao cấp, chất liệu cao cấp.\n\nBao gồm: Makeup Master hoàn chỉnh, tóc sáng tạo (1 kiểu), phụ kiện tóc cao cấp.\n\nPhù hợp: Cô dâu muốn nét đẹp tinh tế, lâu trôi, phù hợp ảnh chụp chuyên nghiệp.\n\nLưu ý: Nên đặt trước 1–2 tuần để xác nhận lịch Master.",
      notes: "Nên đặt trước 1–2 tuần. Thời gian makeup 2–2.5 tiếng.",
      addons: JSON.stringify([
        { key: "them_lan_makeup", name: "Thêm lần makeup",             price: 1500000 },
        { key: "them_toc",        name: "Thêm 1 kiểu tóc",             price: 300000 },
      ]),
      products: JSON.stringify(["Makeup + tóc Master hoàn chỉnh 1 lần", "Phụ kiện tóc cao cấp"]),
      sortOrder: 2,
    },
    {
      groupId: gr.id, code: "MK-CHU-RE", name: "Makeup chú rể",
      price: "500000", costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "10",
      serviceType: "makeup_le", photoCount: 0, includesMakeup: 1,
      description: "Dịch vụ makeup & tạo kiểu cho chú rể — đơn giản, tự nhiên.\n\nBao gồm: Makeup căn bản làm mịn da, tạo kiểu tóc.\n\nPhù hợp: Chú rể trong ngày cưới hoặc sự kiện đặc biệt.\n\nLưu ý: Thời gian 20–30 phút.",
      notes: "Thời gian 20–30 phút. Có thể kết hợp cùng gói cô dâu.",
      addons: JSON.stringify([]),
      products: JSON.stringify(["Makeup + tạo kiểu tóc chú rể"]),
      sortOrder: 3,
    },
    {
      groupId: gr.id, code: "MK-NGUOI-NHA-CO-BAN", name: "Makeup người nhà cơ bản",
      price: "300000", costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "10",
      serviceType: "makeup_le", photoCount: 0, includesMakeup: 1,
      description: "Makeup cơ bản cho người thân — nhẹ nhàng, tự nhiên.\n\nBao gồm: Makeup nhẹ + tạo kiểu tóc đơn giản.\n\nPhù hợp: Mẹ hai bên, phù dâu, người thân dự tiệc.\n\nLưu ý: Mỗi người 20–30 phút. Đặt số lượng trước ít nhất 3 ngày.",
      notes: "20–30 phút/người. Đặt trước 3 ngày.",
      addons: JSON.stringify([]),
      products: JSON.stringify(["Makeup + tóc nhẹ nhàng"]),
      sortOrder: 4,
    },
    {
      groupId: gr.id, code: "MK-NGUOI-NHA-NANG", name: "Makeup người nhà nâng",
      price: "600000", costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "10",
      serviceType: "makeup_le", photoCount: 0, includesMakeup: 1,
      description: "Makeup nâng cao cho người thân — kỹ hơn, trang trọng hơn.\n\nBao gồm: Makeup đầy đủ + tóc búi hoặc uốn xoăn.\n\nPhù hợp: Mẹ cô dâu / chú rể, phù dâu chính, người quan trọng.\n\nLưu ý: Mỗi người 40–50 phút.",
      notes: "40–50 phút/người. Phù hợp mẹ hai bên hoặc phù dâu chính.",
      addons: JSON.stringify([]),
      products: JSON.stringify(["Makeup đầy đủ + tóc trang trọng"]),
      sortOrder: 5,
    },
  ]);
  console.log("[seed] MAKEUP LẺ — 5 gói đã thêm.");
}

async function seedInAnhIfMissing() {
  const ex = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.name, "IN ẢNH")).limit(1);
  if (ex.length > 0) return;
  const [gr] = await db.insert(serviceGroupsTable).values([
    { name: "IN ẢNH", description: "Dịch vụ in ảnh theo size — giấy bóng / matte", sortOrder: 10 },
  ]).returning();
  await db.insert(servicePackagesTable).values([
    { groupId: gr.id, code: "IN-10x15",  name: "In ảnh 10×15 cm",  price: "5000",   costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 10×15 cm — giấy bóng hoặc matte.\n\nPhù hợp: Ảnh mini, album lưu niệm nhỏ.\n\nLưu ý: Giá tính theo 1 ảnh. Đặt tối thiểu 10 ảnh.", notes: "Tối thiểu 10 ảnh/lần đặt. Giao ảnh sau 1–2 ngày.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in giấy bóng hoặc matte"]), sortOrder: 1 },
    { groupId: gr.id, code: "IN-13x18",  name: "In ảnh 13×18 cm",  price: "8000",   costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 13×18 cm — giấy bóng hoặc matte.\n\nPhù hợp: Ảnh để bàn, ảnh lồng khung nhỏ.\n\nLưu ý: Giá tính theo 1 ảnh.", notes: "Tối thiểu 5 ảnh/lần đặt. Giao ảnh sau 1–2 ngày.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in giấy bóng hoặc matte"]), sortOrder: 2 },
    { groupId: gr.id, code: "IN-20x30",  name: "In ảnh 20×30 cm",  price: "15000",  costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 20×30 cm — giấy bóng hoặc matte.\n\nPhù hợp: Ảnh treo tường nhỏ, ảnh để bàn.\n\nLưu ý: Giá tính theo 1 ảnh.", notes: "Tối thiểu 5 ảnh/lần đặt.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in giấy bóng hoặc matte"]), sortOrder: 3 },
    { groupId: gr.id, code: "IN-30x45",  name: "In ảnh 30×45 cm",  price: "25000",  costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 30×45 cm — giấy bóng hoặc matte.\n\nPhù hợp: Ảnh treo tường, ảnh trang trí phòng.\n\nLưu ý: Giá tính theo 1 ảnh.", notes: "Giao ảnh sau 1–2 ngày.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in giấy bóng hoặc matte"]), sortOrder: 4 },
    { groupId: gr.id, code: "IN-40x60",  name: "In ảnh 40×60 cm",  price: "40000",  costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 40×60 cm — giấy bóng hoặc matte.\n\nPhù hợp: Ảnh treo tường phòng khách, ảnh cưới.\n\nLưu ý: Giá tính theo 1 ảnh.", notes: "Giao ảnh sau 2–3 ngày.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in giấy bóng hoặc matte"]), sortOrder: 5 },
    { groupId: gr.id, code: "IN-60x90",  name: "In ảnh 60×90 cm",  price: "80000",  costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 60×90 cm — giấy bóng hoặc matte — khổ lớn.\n\nPhù hợp: Ảnh cưới treo phòng khách, backdrop trang trí.\n\nLưu ý: Giá tính theo 1 ảnh. Cần ảnh gốc độ phân giải cao.", notes: "Cần file ảnh gốc độ phân giải cao (>5MP). Giao sau 2–3 ngày.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in khổ lớn giấy bóng hoặc matte"]), sortOrder: 6 },
    { groupId: gr.id, code: "IN-80x120", name: "In ảnh 80×120 cm", price: "150000", costPrice: "0", printCost: "0", operatingCost: "0", salePercent: "0", serviceType: "in_anh", photoCount: 0, includesMakeup: 0, description: "In ảnh size 80×120 cm — giấy bóng hoặc matte — khổ đại.\n\nPhù hợp: Ảnh trưng bày, ảnh cưới treo tường lớn, backdrop sự kiện.\n\nLưu ý: Cần file ảnh gốc độ phân giải rất cao (>10MP).", notes: "Cần file gốc >10MP. Giao sau 3–5 ngày.", addons: JSON.stringify([]), products: JSON.stringify(["Ảnh in khổ đại giấy bóng hoặc matte"]), sortOrder: 7 },
  ]);
  console.log("[seed] IN ẢNH — 7 size đã thêm.");
}

seedQuayPhimIfMissing().catch(console.error);
seedBeautyIfMissing().catch(console.error);
seedGiaDinhIfMissing().catch(console.error);
seedMakeupLeIfMissing().catch(console.error);
seedInAnhIfMissing().catch(console.error);

// ─── Addon: Chụp cổng tại studio ─────────────────────────────────────────────
const ADDONS_CONG = JSON.stringify([
  { key: "video_hau_truong", name: "Video hậu trường",      price: 200000 },
  { key: "makeup_chu_re",    name: "Makeup luôn cho chú rể", price: 500000 },
]);

const NOTES_CONG = "Cọc 20% khi đặt lịch\nThanh toán 60% trong ngày chụp\nThanh toán 20% còn lại khi nhận hình\n\nPhụ thu:\n• Video hậu trường +200.000đ\n• Makeup chú rể +500.000đ";

async function seedCongGroup() {
  const existing = await db.select()
    .from(serviceGroupsTable)
    .where(eq(serviceGroupsTable.name, "CHỤP CỔNG TẠI STUDIO"))
    .limit(1);
  if (existing.length > 0) return;

  // ─── Nhóm 0: CHỤP CỔNG TẠI STUDIO (nhóm dịch vụ chủ lực) ────────────────
  const [grCong] = await db.insert(serviceGroupsTable).values([
    { name: "CHỤP CỔNG TẠI STUDIO", description: "Nhóm dịch vụ chủ lực — chụp ảnh cổng cưới tại studio Amazing Studio", sortOrder: 1 },
  ]).returning();

  const [cgBasic, cgPremium, cgLuxury] = await db.insert(servicePackagesTable).values([
    {
      groupId: grCong.id,
      code: "CG-BASIC",
      name: "Chụp cổng Basic",
      price: "2900000",
      costPrice: "400000",
      printCost: "300000",
      operatingCost: "100000",
      salePercent: "8",
      serviceType: "tiec",
      photoCount: 1,
      includesMakeup: 1,
      description: "Dành cho cặp đôi muốn lưu giữ khoảnh khắc giản dị nhưng vẫn tinh tế.\n\n• 1 sare cô dâu + 1 áo vest chú rể\n• 1 photo chuyên viên\n• Makeup chuyên viên",
      notes: NOTES_CONG,
      addons: ADDONS_CONG,
      products: JSON.stringify([
        "2 hình cổng 60×90 ép gỗ in lụa",
        "5 hình nhỏ 13×18 (chưa khung)",
        "Toàn bộ file gốc (tặng kèm)",
      ]),
      sortOrder: 1,
    },
    {
      groupId: grCong.id,
      code: "CG-PREMIUM",
      name: "Chụp cổng Premium",
      price: "3900000",
      costPrice: "550000",
      printCost: "400000",
      operatingCost: "150000",
      salePercent: "8",
      serviceType: "tiec",
      photoCount: 1,
      includesMakeup: 1,
      description: "Dành cho cặp đôi muốn bộ ảnh chỉn chu, sang trọng hơn.\n\n• 2 sare cô dâu + 2 áo vest chú rể\n• 1 photo chuyên viên\n• Makeup chuyên viên",
      notes: NOTES_CONG,
      addons: ADDONS_CONG,
      products: JSON.stringify([
        "2 hình cổng 60×90 mica gương cao cấp",
        "10 hình nhỏ 13×18 (chưa khung)",
        "Toàn bộ file gốc (tặng kèm)",
      ]),
      sortOrder: 2,
    },
    {
      groupId: grCong.id,
      code: "CG-LUXURY",
      name: "Chụp cổng Luxury",
      price: "5900000",
      costPrice: "800000",
      printCost: "600000",
      operatingCost: "200000",
      salePercent: "8",
      serviceType: "tiec",
      photoCount: 1,
      includesMakeup: 1,
      description: "Phiên bản cao cấp nhất, mọi chi tiết đều được đầu tư tỉ mỉ.\n\n• 2 sare cô dâu + 2 áo vest chú rể\n• 1 photo master\n• Makeup master",
      notes: NOTES_CONG,
      addons: ADDONS_CONG,
      products: JSON.stringify([
        "2 hình cổng 60×90 mica gương cao cấp",
        "10 hình khung 15×21 ép gỗ cao cấp (có khung)",
        "Toàn bộ file gốc (tặng kèm)",
      ]),
      sortOrder: 3,
    },
  ]).returning();

  await db.insert(packageItemsTable).values([
    // Basic
    { packageId: cgBasic.id, name: "Sare cô dâu",         quantity: "1", unit: "bộ",     sortOrder: 1 },
    { packageId: cgBasic.id, name: "Áo vest chú rể",      quantity: "1", unit: "bộ",     sortOrder: 2 },
    { packageId: cgBasic.id, name: "Photo chuyên viên",   quantity: "1", unit: "người",  sortOrder: 3 },
    { packageId: cgBasic.id, name: "Makeup chuyên viên",  quantity: "1", unit: "lần",    sortOrder: 4 },
    // Premium
    { packageId: cgPremium.id, name: "Sare cô dâu",       quantity: "2", unit: "bộ",     sortOrder: 1 },
    { packageId: cgPremium.id, name: "Áo vest chú rể",    quantity: "2", unit: "bộ",     sortOrder: 2 },
    { packageId: cgPremium.id, name: "Photo chuyên viên", quantity: "1", unit: "người",  sortOrder: 3 },
    { packageId: cgPremium.id, name: "Makeup chuyên viên",quantity: "1", unit: "lần",    sortOrder: 4 },
    // Luxury
    { packageId: cgLuxury.id, name: "Sare cô dâu",        quantity: "2", unit: "bộ",     sortOrder: 1 },
    { packageId: cgLuxury.id, name: "Áo vest chú rể",     quantity: "2", unit: "bộ",     sortOrder: 2 },
    { packageId: cgLuxury.id, name: "Photo master",        quantity: "1", unit: "người",  sortOrder: 3 },
    { packageId: cgLuxury.id, name: "Makeup master",       quantity: "1", unit: "lần",    sortOrder: 4 },
  ]);

  console.log("[seed] CHỤP CỔNG TẠI STUDIO — 3 gói đã thêm.");
}

async function updateGroupSortOrders() {
  // Thứ tự ưu tiên kinh doanh Amazing Studio
  const ORDER: { name: string; newName?: string; sortOrder: number }[] = [
    { name: "CHỤP CỔNG TẠI STUDIO",  sortOrder: 1  },
    { name: "ALBUM TẠI STUDIO",       sortOrder: 2  },
    { name: "ALBUM NGOẠI CẢNH",       sortOrder: 3  },
    { name: "CHỤP TIỆC CƯỚI",         sortOrder: 4  },
    { name: "CHỤP BEAUTY",  newName: "BEAUTY / THỜI TRANG", sortOrder: 5 },
    { name: "BEAUTY / THỜI TRANG",    sortOrder: 5  }, // idempotent nếu đã đổi tên rồi
    { name: "COMBO CÓ MAKEUP",        sortOrder: 6  },
    { name: "COMBO KHÔNG MAKEUP",     sortOrder: 7  },
    { name: "QUAY PHIM",              sortOrder: 8  },
    { name: "CHỤP GIA ĐÌNH",          sortOrder: 9  },
    { name: "MAKEUP LẺ",              sortOrder: 10 },
    { name: "IN ẢNH",                 sortOrder: 11 },
  ];

  for (const entry of ORDER) {
    const rows = await db.select().from(serviceGroupsTable)
      .where(eq(serviceGroupsTable.name, entry.name)).limit(1);
    if (rows.length === 0) continue;

    const updatePayload: Record<string, unknown> = { sortOrder: entry.sortOrder };
    if (entry.newName) updatePayload.name = entry.newName;

    await db.update(serviceGroupsTable)
      .set(updatePayload)
      .where(eq(serviceGroupsTable.id, rows[0].id));
  }
  console.log("[migrate] Thứ tự nhóm dịch vụ đã được cập nhật.");
}

seedCongGroup().catch(console.error);
updateGroupSortOrders().catch(console.error);

// ─── Service groups ─────────────────────────────────────────────────────────
router.get("/service-groups", async (_req, res) => {
  const all = await db.select().from(serviceGroupsTable).orderBy(asc(serviceGroupsTable.sortOrder));
  // Deduplicate by name — keep the one with the lowest id (earliest created)
  const seen = new Map<string, typeof all[0]>();
  for (const g of all) {
    if (!seen.has(g.name)) seen.set(g.name, g);
  }
  res.json(Array.from(seen.values()).map(fmtGroup));
});

router.post("/service-groups", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const { name, description, sortOrder, isActive, aiImageUrl, publicForCustomer } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Tên nhóm không được để trống" });

  // Reject duplicate names
  const existing = await db.select().from(serviceGroupsTable)
    .where(eq(serviceGroupsTable.name, name.trim())).limit(1);
  if (existing.length > 0) {
    return res.status(409).json({ error: `Nhóm "${name.trim()}" đã tồn tại`, existing: fmtGroup(existing[0]) });
  }

  const [g] = await db.insert(serviceGroupsTable).values({
    name: name.trim(), description, sortOrder: sortOrder ?? 0, isActive: isActive !== false ? 1 : 0,
    aiImageUrl: typeof aiImageUrl === "string" && aiImageUrl.trim() ? aiImageUrl.trim() : null,
    publicForCustomer: publicForCustomer === false ? false : true,
    ...parseDiscountPayload(req.body),
  }).returning();
  clearSaleContextCache();
  res.status(201).json(fmtGroup(g));
});

router.put("/service-groups/:id", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const id = parseInt(req.params.id);
  const { name, description, sortOrder, isActive, aiImageUrl, publicForCustomer } = req.body;
  const discountSet = req.body.discountEnabled !== undefined ? parseDiscountPayload(req.body) : {};
  const [g] = await db.update(serviceGroupsTable).set({
    name, description,
    sortOrder: sortOrder !== undefined ? sortOrder : undefined,
    isActive: isActive !== undefined ? (isActive ? 1 : 0) : undefined,
    // aiImageUrl: undefined = không đụng tới; "" / null = xóa ảnh; chuỗi = đặt ảnh.
    aiImageUrl: aiImageUrl === undefined
      ? undefined
      : (typeof aiImageUrl === "string" && aiImageUrl.trim() ? aiImageUrl.trim() : null),
    publicForCustomer: publicForCustomer === undefined ? undefined : Boolean(publicForCustomer),
    ...discountSet,
  }).where(eq(serviceGroupsTable.id, id)).returning();
  if (!g) return res.status(404).json({ error: "Not found" });
  clearSaleContextCache();
  res.json(fmtGroup(g));
});

router.delete("/service-groups/:id", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const id = parseInt(req.params.id);
  // An toàn: chỉ HARD-DELETE khi nhóm RỖNG. Nhóm còn gói → 409 để FE hỏi cách xử lý
  // (chuyển gói sang nhóm khác, hoặc ẩn nhóm — PUT isActive=false). Tránh mất dữ liệu.
  const pkgs = await db.select({ id: servicePackagesTable.id }).from(servicePackagesTable)
    .where(eq(servicePackagesTable.groupId, id));
  if (pkgs.length > 0) {
    return res.status(409).json({ error: "group_not_empty", packageCount: pkgs.length });
  }
  await db.delete(serviceGroupsTable).where(eq(serviceGroupsTable.id, id));
  clearSaleContextCache();
  res.status(204).send();
});

// Chuyển TOÀN BỘ gói từ nhóm :id sang nhóm khác (bước trước khi xoá/ẩn nhóm cũ).
// Gói chuyển sang KHÔNG mang theo giảm giá nhóm cũ (giảm nhóm lưu ở group) — sẽ
// theo giảm giá của nhóm đích nếu nhóm đích có cấu hình.
router.post("/service-groups/:id/move-packages", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const fromId = parseInt(req.params.id);
  const toId = parseInt(String(req.body?.targetGroupId));
  if (!Number.isFinite(toId)) return res.status(400).json({ error: "Thiếu nhóm đích" });
  if (toId === fromId) return res.status(400).json({ error: "Nhóm đích phải khác nhóm hiện tại" });
  const [target] = await db.select().from(serviceGroupsTable).where(eq(serviceGroupsTable.id, toId)).limit(1);
  if (!target) return res.status(404).json({ error: "Không tìm thấy nhóm đích" });
  const moved = await db.update(servicePackagesTable).set({ groupId: toId })
    .where(eq(servicePackagesTable.groupId, fromId)).returning({ id: servicePackagesTable.id });
  clearSaleContextCache();
  res.json({ moved: moved.length });
});

// ─── Service packages ────────────────────────────────────────────────────────
router.get("/service-packages", async (_req, res) => {
  const packages = await db.select().from(servicePackagesTable)
    .orderBy(asc(servicePackagesTable.groupId), asc(servicePackagesTable.sortOrder));
  const items = await db.select().from(packageItemsTable)
    .orderBy(asc(packageItemsTable.packageId), asc(packageItemsTable.sortOrder));
  const groups = await db.select().from(serviceGroupsTable);
  const groupById = new Map<number, ReturnType<typeof fmtGroup>>();
  for (const g of groups) groupById.set(g.id, fmtGroup(g));
  const result = packages.map((p) => {
    const fp = fmtPkg(p);
    const g = p.groupId != null ? groupById.get(p.groupId) : undefined;
    const groupActive = g ? g.isActive : false;
    // Giảm giá NHÓM chỉ áp khi nhóm đang active (nhóm ẩn → bỏ qua).
    const discount = resolveDiscount({
      basePrice: fp.price,
      pkg: toDiscountConfig(fp),
      group: g && groupActive ? toDiscountConfig(g) : null,
    });
    return {
      ...fp,
      items: items.filter((i) => i.packageId === p.id),
      discount, // giá sau giảm đã tính sẵn (nguồn sự thật) — FE chỉ hiển thị
      pkgDiscountStatus: discountWindowStatus(toDiscountConfig(fp)),
      groupDiscountStatus: g && groupActive ? g.discountStatus : "off",
    };
  });
  res.json(result);
});

router.get("/service-packages/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [pkg] = await db.select().from(servicePackagesTable).where(eq(servicePackagesTable.id, id));
  if (!pkg) return res.status(404).json({ error: "Not found" });
  const items = await db.select().from(packageItemsTable)
    .where(eq(packageItemsTable.packageId, id)).orderBy(asc(packageItemsTable.sortOrder));
  res.json({ ...fmtPkg(pkg), items });
});

router.post("/service-packages", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const {
    groupId, code, name, price,
    printCost, operatingCost, salePercent,
    description, notes, addons, products, isActive, sortOrder, items = [],
    serviceType, photoCount, includesMakeup, includedRetouchedPhotos,
    defaultEditingDays,
    requiresPostProduction,
    requiresPrinting,
    warnUpcomingShow,
  } = req.body;
  const parseEditingDays = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  };
  const [pkg] = await db.insert(servicePackagesTable).values({
    groupId: groupId ? parseInt(groupId) : null,
    code, name,
    price: String(price ?? 0),
    printCost: String(printCost ?? 0),
    operatingCost: String(operatingCost ?? 0),
    salePercent: String(salePercent ?? 0),
    description, notes,
    addons: addons ? (typeof addons === "string" ? addons : JSON.stringify(addons)) : null,
    products: products ? (typeof products === "string" ? products : JSON.stringify(products)) : null,
    isActive: isActive !== false ? 1 : 0,
    sortOrder: sortOrder ?? 0,
    serviceType: serviceType ?? null,
    photoCount: photoCount ? parseInt(photoCount) : 1,
    includesMakeup: includesMakeup === false || includesMakeup === 0 ? 0 : 1,
    includedRetouchedPhotos: includedRetouchedPhotos ? parseInt(String(includedRetouchedPhotos)) : 0,
    defaultEditingDays: parseEditingDays(defaultEditingDays),
    requiresPostProduction: requiresPostProduction === false || requiresPostProduction === 0
      ? false
      : (requiresPostProduction === true || requiresPostProduction === 1
        ? true
        : (groupId ? await defaultRequiresPostProductionForGroupId(parseInt(String(groupId))) : false)),
    requiresPrinting: requiresPrinting === false || requiresPrinting === 0
      ? false
      : (requiresPrinting === true || requiresPrinting === 1
        ? true
        : (groupId ? await defaultRequiresPrintingForGroupId(parseInt(String(groupId))) : false)),
    warnUpcomingShow: toWarnUpcomingShowFlag(warnUpcomingShow),
    ...parseDiscountPayload(req.body),
  }).returning();

  if (items.length > 0) {
    await db.insert(packageItemsTable).values(
      items.map((item: { name: string; quantity?: string; unit?: string; notes?: string; sortOrder?: number }, idx: number) => ({
        packageId: pkg.id,
        name: item.name,
        quantity: String(item.quantity ?? "1"),
        unit: item.unit,
        notes: item.notes,
        sortOrder: item.sortOrder ?? idx,
      }))
    );
  }

  const savedItems = await db.select().from(packageItemsTable)
    .where(eq(packageItemsTable.packageId, pkg.id)).orderBy(asc(packageItemsTable.sortOrder));
  clearSaleContextCache();
  res.status(201).json({ ...fmtPkg(pkg), items: savedItems });
});

router.put("/service-packages/:id", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  try {
    const id = parseInt(req.params.id);
    const {
      groupId, code, name, price,
      printCost, operatingCost, salePercent,
      description, notes, addons, products, isActive, sortOrder, items,
      serviceType, photoCount, includesMakeup, includedRetouchedPhotos,
      defaultEditingDays,
      requiresPostProduction,
      requiresPrinting,
      warnUpcomingShow,
    } = req.body;

    const update: Record<string, unknown> = {};
    if (groupId !== undefined) update.groupId = groupId ? parseInt(groupId) : null;
    if (code !== undefined) update.code = code;
    if (name !== undefined) update.name = name;
    if (price !== undefined) update.price = String(price);
    if (printCost !== undefined) update.printCost = String(printCost ?? 0);
    if (operatingCost !== undefined) update.operatingCost = String(operatingCost ?? 0);
    if (salePercent !== undefined) update.salePercent = String(salePercent);
    if (description !== undefined) update.description = description;
    if (notes !== undefined) update.notes = notes;
    if (addons !== undefined) update.addons = addons ? (typeof addons === "string" ? addons : JSON.stringify(addons)) : null;
    if (products !== undefined) update.products = products ? (typeof products === "string" ? products : JSON.stringify(products)) : null;
    if (isActive !== undefined) update.isActive = isActive ? 1 : 0;
    if (sortOrder !== undefined) update.sortOrder = sortOrder;
    if (serviceType !== undefined) update.serviceType = serviceType ?? null;
    if (photoCount !== undefined) update.photoCount = photoCount ? parseInt(photoCount) : 1;
    if (includesMakeup !== undefined) update.includesMakeup = includesMakeup === false || includesMakeup === 0 ? 0 : 1;
    if (includedRetouchedPhotos !== undefined) update.includedRetouchedPhotos = includedRetouchedPhotos ? parseInt(String(includedRetouchedPhotos)) : 0;
    if (defaultEditingDays !== undefined) {
      // null/"" → clear (về fallback logic cũ); số hợp lệ → set; còn lại bỏ qua
      if (defaultEditingDays === null || defaultEditingDays === "") {
        update.defaultEditingDays = null;
      } else {
        const n = Number(defaultEditingDays);
        if (Number.isFinite(n) && n >= 0) update.defaultEditingDays = Math.floor(n);
      }
    }
    if (requiresPostProduction !== undefined) {
      update.requiresPostProduction = toRequiresPostProductionFlag(requiresPostProduction);
    }
    if (requiresPrinting !== undefined) {
      update.requiresPrinting = toRequiresPrintingFlag(requiresPrinting);
    }
    if (warnUpcomingShow !== undefined) {
      update.warnUpcomingShow = toWarnUpcomingShowFlag(warnUpcomingShow);
    }
    // Chương trình giảm giá riêng cho gói — form luôn gửi cả khối khi lưu.
    if (req.body.discountEnabled !== undefined) {
      Object.assign(update, parseDiscountPayload(req.body));
    }

    let pkg: (typeof servicePackagesTable.$inferSelect) | undefined;
    if (Object.keys(update).length > 0) {
      const [updated] = await db.update(servicePackagesTable).set(update)
        .where(eq(servicePackagesTable.id, id)).returning();
      pkg = updated;
    } else {
      const [existing] = await db.select().from(servicePackagesTable)
        .where(eq(servicePackagesTable.id, id));
      pkg = existing;
    }
    if (!pkg) return res.status(404).json({ error: "Không tìm thấy gói dịch vụ" });

    if (Array.isArray(items)) {
      await db.delete(packageItemsTable).where(eq(packageItemsTable.packageId, id));
      if (items.length > 0) {
        await db.insert(packageItemsTable).values(
          items.map((item: { name: string; quantity?: string; unit?: string; notes?: string; sortOrder?: number }, idx: number) => ({
            packageId: id,
            name: item.name,
            quantity: String(item.quantity ?? "1"),
            unit: item.unit,
            notes: item.notes,
            sortOrder: item.sortOrder ?? idx,
          }))
        );
      }
    }

    const savedItems = await db.select().from(packageItemsTable)
      .where(eq(packageItemsTable.packageId, id)).orderBy(asc(packageItemsTable.sortOrder));
    clearSaleContextCache();
    res.json({ ...fmtPkg(pkg), items: savedItems });
  } catch (err: unknown) {
    console.error("PUT /service-packages/:id error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Lỗi lưu gói dịch vụ, vui lòng thử lại" });
  }
});

router.delete("/service-packages/:id", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const id = parseInt(req.params.id);
  await db.delete(packageItemsTable).where(eq(packageItemsTable.packageId, id));
  await db.delete(servicePackagesTable).where(eq(servicePackagesTable.id, id));
  clearSaleContextCache();
  res.status(204).send();
});

// ─── Surcharges ──────────────────────────────────────────────────────────────
router.get("/surcharges", async (_req, res) => {
  const rows = await db.select().from(surchargesTable).orderBy(asc(surchargesTable.sortOrder));
  res.json(rows.map(fmtSurcharge));
});

router.post("/surcharges", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const { name, category, price, unit, description, isActive, sortOrder } = req.body;
  const [s] = await db.insert(surchargesTable).values({
    name, category, price: String(price ?? 0), unit: unit ?? "lần",
    description, isActive: isActive !== false ? 1 : 0, sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(fmtSurcharge(s));
});

router.put("/surcharges/:id", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const id = parseInt(req.params.id);
  const { name, category, price, unit, description, isActive, sortOrder } = req.body;
  const [s] = await db.update(surchargesTable).set({
    name, category,
    price: price !== undefined ? String(price) : undefined,
    unit, description,
    isActive: isActive !== undefined ? (isActive ? 1 : 0) : undefined,
    sortOrder: sortOrder !== undefined ? sortOrder : undefined,
  }).where(eq(surchargesTable.id, id)).returning();
  if (!s) return res.status(404).json({ error: "Not found" });
  res.json(fmtSurcharge(s));
});

router.delete("/surcharges/:id", async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const id = parseInt(req.params.id);
  await db.delete(surchargesTable).where(eq(surchargesTable.id, id));
  res.status(204).send();
});

export default router;
