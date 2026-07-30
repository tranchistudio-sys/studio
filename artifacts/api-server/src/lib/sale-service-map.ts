import { pool } from "@workspace/db";
import { getServicePricePreview, matchedGroupNamesForService } from "./sale-pricing";
import { normalizeVi } from "./sale-text-normalize";

/**
 * SERVICE MAP — GỐC của kiến trúc service-rooted (luật chủ 29/07).
 *
 * Đưa bản đồ dịch vụ (đang HARD-CODE trong SERVICE_GROUP_KEYWORDS ở sale-pricing.ts) ra DB,
 * để "Dịch vụ" trở thành thực thể gốc: mỗi service_key (khoá BỀN do ta tự đặt, KHÔNG đổi giữa
 * local↔prod) trỏ tới một NHÓM giá CRM (service_groups.name) + từ khoá nhận diện.
 *
 * Vì sao service_key (slug) là khoá liên kết, KHÔNG phải id số / KHÔNG phải tên nhóm:
 *  - id serial đổi khi reseed (local≠prod) → KHÔNG bền.
 *  - tên nhóm admin có thể sửa → nếu khoá theo tên thì đổi tên là đứt liên kết.
 *  - service_key do ta đặt, cố định vĩnh viễn; đổi tên nhóm chỉ cần cập nhật cột group_name
 *    của DÒNG service_key đó (admin KHÔNG phải đụng khoá) — kịch bản/golden vẫn dính nguyên.
 *
 * Additive, tạo lazy (CREATE TABLE IF NOT EXISTS) + seed chỉ-khi-rỗng, khai báo mirror ở
 * drizzle (chống DROP-drift PR #132). THUẦN đọc/ghi map — KHÔNG là nguồn giá (giá vẫn từ
 * sale-pricing.ts → service_groups/service_packages).
 */

export type ServiceMapRow = {
  id: number;
  serviceKey: string;
  displayName: string;
  groupName: string | null; // tên NHÓM giá CRM đang trỏ tới (durable pin); null = auto theo keyword
  keywords: string;         // các từ khoá nhận diện, ngăn bằng '|'
  isActive: boolean;
  sortOrder: number;
};

// Seed mặc định: 7 dịch vụ gốc (khớp SERVICE_GROUP_KEYWORDS + INTENT_VN). new_concept_idea là
// MODIFIER (gu/concept) không phải dịch vụ gốc nên KHÔNG đưa vào map.
const SEED: Array<Omit<ServiceMapRow, "id" | "isActive"> & { isActive?: boolean }> = [
  { serviceKey: "wedding_album", displayName: "Album cưới", groupName: null, keywords: "album|ảnh cưới|chụp cưới|pre-wedding|prewedding", sortOrder: 10 },
  { serviceKey: "wedding_gate", displayName: "Ảnh cổng", groupName: null, keywords: "cổng|ảnh cổng|chụp cổng", sortOrder: 20 },
  { serviceKey: "wedding_party", displayName: "Phóng sự cưới", groupName: null, keywords: "tiệc|phóng sự|tiệc cưới", sortOrder: 30 },
  { serviceKey: "family", displayName: "Chụp gia đình", groupName: null, keywords: "gia đình|family", sortOrder: 40 },
  { serviceKey: "maternity", displayName: "Chụp bầu", groupName: null, keywords: "bầu|maternity|thai sản", sortOrder: 50 },
  { serviceKey: "beauty", displayName: "Beauty / Kỷ yếu", groupName: null, keywords: "beauty|kỷ yếu|nghệ thuật|chân dung|profile", sortOrder: 60 },
  { serviceKey: "rental_outfit", displayName: "Thuê váy / đồ", groupName: null, keywords: "váy|thuê|áo dài|vest", sortOrder: 70 },
];

let ensured = false;
export async function ensureServiceMapTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_service_map (
      id            SERIAL PRIMARY KEY,
      service_key   TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      group_name    TEXT,
      keywords      TEXT NOT NULL DEFAULT '',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      sort_order    INTEGER NOT NULL DEFAULT 100,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_service_map_key ON lulu_service_map (service_key)`);
  // Seed UPSERT-missing: chỉ thêm dòng chưa có, KHÔNG ghi đè chỉnh tay của admin (group_name/keywords).
  for (const s of SEED) {
    await pool.query(
      `INSERT INTO lulu_service_map (service_key, display_name, group_name, keywords, sort_order)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (service_key) DO NOTHING`,
      [s.serviceKey, s.displayName, s.groupName, s.keywords, s.sortOrder],
    );
  }
  ensured = true;
}

function mapRow(r: Record<string, unknown>): ServiceMapRow {
  return {
    id: Number(r.id),
    serviceKey: String(r.service_key),
    displayName: (r.display_name as string) ?? "",
    groupName: (r.group_name as string) ?? null,
    keywords: (r.keywords as string) ?? "",
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order ?? 100),
  };
}

export async function listServiceMap(): Promise<ServiceMapRow[]> {
  await ensureServiceMapTable();
  const r = await pool.query(`SELECT * FROM lulu_service_map WHERE is_active = true ORDER BY sort_order ASC, id ASC`);
  return (r.rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function getServiceMap(serviceKey: string): Promise<ServiceMapRow | null> {
  await ensureServiceMapTable();
  const r = await pool.query(`SELECT * FROM lulu_service_map WHERE service_key = $1 LIMIT 1`, [serviceKey]);
  return r.rows.length ? mapRow(r.rows[0] as Record<string, unknown>) : null;
}

/**
 * Nhóm giá CRM cho một service_key. Ưu tiên group_name đã ghim; nếu chưa ghim → khớp KEYWORD
 * với nhóm giá sống (fail-soft). Trả tên nhóm để dùng làm pinnedGroup cho getServicePricePreview.
 */
export async function resolveGroupNameForService(serviceKey: string): Promise<string | null> {
  const m = await getServiceMap(serviceKey);
  if (!m) return null;
  if (m.groupName && m.groupName.trim()) return m.groupName.trim();
  // Chưa ghim: chỉ nhận nhóm THẬT SỰ khớp keyword. TRƯỚC ĐÂY dùng getServicePricePreview —
  // service không có nhóm (maternity/rental) bị fallback "trả tất cả" → gán bừa nhóm ĐẦU TIÊN
  // (bug "chụp bầu" bị trả lời CHỤP CỔNG). Giờ không khớp → null (Lulu hỏi lại, không đoán bừa).
  try {
    const matched = await matchedGroupNamesForService(serviceKey);
    return matched[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * (GĐ1) Backfill service_key cho golden CŨ: mỗi script gắn node_key → tra cây lulu_scenario_tree,
 * đi NGƯỢC parent tới node đầu tiên có service_key. Chỉ điền dòng đang NULL (idempotent), fail-soft.
 * Trả số node đã điền. Chạy được trong migrations.
 */
export async function backfillScriptServiceKeys(): Promise<number> {
  try {
    const tr = await pool.query(`SELECT node_key, parent_key, service_key FROM lulu_scenario_tree`);
    const byKey = new Map<string, { parent: string | null; service: string | null }>();
    for (const row of tr.rows as Array<{ node_key: string; parent_key: string | null; service_key: string | null }>) {
      byKey.set(row.node_key, { parent: row.parent_key, service: row.service_key });
    }
    const resolveService = (nodeKey: string): string | null => {
      let cur: string | null = nodeKey;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const node = byKey.get(cur);
        if (!node) return null;
        if (node.service && node.service.trim()) return node.service.trim();
        cur = node.parent;
      }
      return null;
    };
    const sc = await pool.query(`SELECT DISTINCT node_key FROM lulu_sale_script_examples WHERE service_key IS NULL`);
    let filled = 0;
    for (const row of sc.rows as Array<{ node_key: string }>) {
      const svc = resolveService(row.node_key);
      if (svc) {
        await pool.query(
          `UPDATE lulu_sale_script_examples SET service_key = $1, updated_at = NOW() WHERE node_key = $2 AND service_key IS NULL`,
          [svc, row.node_key],
        );
        filled++;
      }
    }
    return filled;
  } catch (err) {
    console.error("[ServiceMap] backfillScriptServiceKeys lỗi (fail-soft):", String(err).slice(0, 150));
    return 0;
  }
}

/**
 * (GĐ1) Auto-ghim group_name cho các service_key CHƯA ghim, bằng cách khớp keyword với nhóm
 * giá sống hiện có. Idempotent, fail-soft — chạy được trong migrations. KHÔNG ghi đè ghim tay.
 */
export async function autoLinkServiceGroups(): Promise<number> {
  await ensureServiceMapTable();
  let linked = 0;
  const rows = await listServiceMap();
  let liveGroups: Array<{ groupName: string }> = [];
  try {
    const all = await getServicePricePreview(null); // null → trả tất cả nhóm
    liveGroups = all.map((g) => ({ groupName: g.groupName }));
  } catch {
    return 0; // không đọc được bảng giá → để nguyên, lần sau thử lại
  }
  for (const row of rows) {
    if (row.groupName && row.groupName.trim()) continue; // đã ghim tay
    const kw = row.keywords.split("|").map((k) => normalizeVi(k.trim())).filter(Boolean);
    const hit = liveGroups.find((g) => {
      const gn = normalizeVi(g.groupName);
      return kw.some((k) => k && gn.includes(k));
    });
    if (hit) {
      await pool.query(`UPDATE lulu_service_map SET group_name = $1, updated_at = NOW() WHERE service_key = $2`, [hit.groupName, row.serviceKey]);
      linked++;
    }
  }
  return linked;
}
