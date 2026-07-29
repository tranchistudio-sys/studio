import { pool } from "@workspace/db";
import { listScenarios } from "./sale-scenario-store";
import { summarizeWhenServer } from "./sale-scenario-types";
import { getServicePricePreview } from "./sale-pricing";
import { normalizeVi } from "./sale-text-normalize";

/** Slug ổn định từ tên nhóm giá → dùng làm serviceKey/nodeKey (không lộ id số). */
function slugifyGroup(name: string): string {
  return normalizeVi(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "nhom";
}

/**
 * CÂY KỊCH BẢN LULU — SERVICE-FIRST (luật chủ 29/07: Dịch vụ là TRUNG TÂM).
 *
 * Trang đầu: 🌐 Chào hỏi chung (script toàn studio) → rồi DANH SÁCH DỊCH VỤ (mỗi nhóm bảng
 * giá = 1 CARD/FOLDER lớn, mặc định thu gọn). Mở 1 dịch vụ → hiện 7 BƯỚC RIÊNG của dịch vụ
 * đó (Tìm hiểu → Tư vấn → Báo giá → Xử lý phân vân → Chốt → Không chốt → Sau chốt), mỗi bước
 * có các TÌNH HUỐNG, mỗi tình huống có bảng Excel Hỏi & Trả lời RIÊNG (khoá theo node_key
 * = service::step::situation → KHÔNG trộn script giữa các dịch vụ).
 *
 * Cây được SINH ĐỘNG từ lulu_service_map (nguồn dịch vụ) + template 7 bước — KHÔNG hard-code
 * từng dịch vụ. Giá đọc realtime từ "Dịch vụ & Bảng giá" (node Báo giá). Engine phía dưới
 * (lulu_sale_scenarios + resolver) GIỮ NGUYÊN; cây này chỉ là lớp TỔ CHỨC/soạn golden cho người.
 *
 * Bảng lulu_scenario_tree (cũ) vẫn giữ (additive, chống DROP) nhưng UI KHÔNG render từ nó nữa.
 */

export type TreeNodeType = "greeting" | "service" | "step" | "leaf" | "pricing"
  | "stage" | "group" | "subgroup"; // giữ type cũ cho seed/table (không dùng ở UI mới)

export type TreeRow = {
  nodeKey: string;
  parentKey: string | null;
  nodeType: TreeNodeType;
  title: string;
  serviceKey: string | null;   // group/pricing → gợi ý nguồn giá
  priceSource: string | null;  // pricing → tên nhóm "Dịch vụ & Bảng giá" ghim sẵn (nếu có)
  scenarioKey: string | null;  // leaf → trỏ scenario
  sortOrder: number;
};

/** Node cây đã dựng (nested) cho FE. */
export type TreeNode = TreeRow & {
  children: TreeNode[];
  /** service/step/pricing: cờ hiển thị + số liệu tóm tắt cho card. */
  meta?: {
    groupName?: string | null;    // service: tên nhóm giá CRM đang nối
    packageCount?: number;        // service: số gói đang bán (realtime)
    situationCount?: number;      // service/step: số tình huống bên trong
    filledCount?: number;         // service: số tình huống ĐÃ có golden (tiến độ)
    priceConnected?: boolean;     // service: đã nối bảng giá chưa
    showPricing?: boolean;        // step Báo giá: hiện bảng giá realtime phía trên
    imageUrl?: string | null;     // service/pricing: ảnh bảng giá nhóm (đồng bộ Dịch vụ & Bảng giá)
  };
  /** leaf: tóm tắt scenario để hiện nhanh (không cần mở). */
  scenario?: { name: string; enabled: boolean; status: string; whenText: string; missing?: boolean } | null;
};

// ─── TEMPLATE 7 BƯỚC + TÌNH HUỐNG (dùng CHUNG cho mọi dịch vụ) ─────────────────
// Mỗi dịch vụ áp template này → tạo node RIÊNG (node_key có service_key) → script riêng.

type StepTpl = { key: string; title: string; showPricing?: boolean; situations: Array<{ key: string; title: string }> };
const S = (key: string, title: string) => ({ key, title });

const SERVICE_STEPS: StepTpl[] = [
  { key: "tim-hieu", title: "1. Tìm hiểu nhu cầu", situations: [
    S("chua-ro-nhu-cau", "Chưa rõ nhu cầu"), S("chup-dip-gi", "Chụp dịp gì"), S("so-nguoi-doi-tuong", "Số người / đối tượng"),
  ]},
  { key: "tu-van", title: "2. Tư vấn & Concept", situations: [
    S("xem-anh-mau", "Xem ảnh mẫu"), S("chua-biet-gu", "Chưa biết gu"), S("phong-cach-han", "Phong cách Hàn"),
    S("tu-nhien", "Tự nhiên"), S("sang-trong", "Sang trọng"), S("lo-khong-an-anh", "Lo không ăn ảnh"),
    S("chon-dia-diem", "Chọn địa điểm"), S("trang-phuc", "Trang phục"), S("makeup", "Makeup"),
  ]},
  { key: "bao-gia", title: "3. Báo giá", showPricing: true, situations: [
    S("hoi-gia", "Hỏi giá"), S("goi-gom-gi", "Gói gồm gì"), S("so-sanh-goi", "So sánh gói"),
  ]},
  { key: "xu-ly-phan-van", title: "4. Xử lý phân vân", situations: [
    S("gia-cao", "Giá cao"), S("xin-giam", "Xin giảm"), S("ben-khac-re-hon", "Bên khác rẻ hơn"),
    S("hoi-chong-gia-dinh", "Cần hỏi chồng / gia đình"), S("can-suy-nghi", "Cần suy nghĩ"),
    S("chua-du-ngan-sach", "Chưa đủ ngân sách"), S("lo-chup-khong-dep", "Lo chụp không đẹp"), S("muon-xem-them", "Muốn xem thêm"),
  ]},
  { key: "chot", title: "5. Chốt sale", situations: [
    S("chon-goi", "Chọn gói"), S("kiem-tra-lich", "Kiểm tra lịch"), S("giu-lich", "Giữ lịch"),
    S("coc", "Cọc"), S("thong-tin-lien-he", "Thông tin liên hệ"), S("chuyen-nhan-vien", "Chuyển nhân viên"),
  ]},
  { key: "khong-chot", title: "6. Không chốt", situations: [
    S("tu-choi", "Từ chối"), S("hen-lai", "Hẹn lại"), S("follow-up", "Follow-up"),
  ]},
  { key: "sau-chot", title: "7. Sau chốt / chuyển người", situations: [
    S("xac-nhan-lich", "Xác nhận lịch"), S("nhac-chuan-bi", "Nhắc chuẩn bị"), S("chuyen-nguoi-that", "Chuyển người thật"),
  ]},
];
const SITUATIONS_PER_SERVICE = SERVICE_STEPS.reduce((n, s) => n + s.situations.length, 0);

const GREETING_SITUATIONS: Array<{ key: string; title: string }> = [
  S("chao-hoi", "Chào hỏi"), S("chua-ro-dich-vu", "Chưa rõ khách cần gì"), S("hoi-studio-co-gi", "Hỏi studio có dịch vụ gì"),
  S("gap-nguoi-that", "Muốn gặp người thật"), S("khieu-nai", "Khiếu nại"),
];

let ensured = false;
export async function ensureScenarioTreeTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_scenario_tree (
      id            SERIAL PRIMARY KEY,
      node_key      TEXT NOT NULL,
      parent_key    TEXT,
      node_type     TEXT NOT NULL DEFAULT 'group'
                      CHECK (node_type IN ('stage','group','subgroup','leaf','pricing')),
      title         TEXT NOT NULL DEFAULT '',
      service_key   TEXT,
      price_source  TEXT,
      scenario_key  TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 100,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_tree_key ON lulu_scenario_tree (node_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lulu_tree_parent ON lulu_scenario_tree (parent_key, sort_order)`);
  ensured = true;
  await seedTreeSkeleton();
}

// ─── SEED SKELETON (nested literal → flatten) ─────────────────────────────────

type SeedNode = {
  key?: string; type: TreeNodeType; title?: string; serviceKey?: string; scenario?: string;
  children?: SeedNode[];
};

const leaf = (scenario: string): SeedNode => ({ type: "leaf", scenario });

const SEED_TREE: SeedNode[] = [
  { key: "s1", type: "stage", title: "1. Chào hỏi", children: [
    leaf("chao-hoi-moi"),
  ]},
  { key: "s2", type: "stage", title: "2. Tìm hiểu nhu cầu", children: [
    { key: "s2-unclear", type: "group", title: "Chưa rõ dịch vụ", children: [ leaf("chua-ro-dich-vu") ]},
    { key: "s2-album", type: "group", title: "Album cưới", serviceKey: "wedding_album", children: [
      { key: "s2-album-concept", type: "subgroup", title: "Tư vấn & Concept", children: [
        leaf("xem-anh-mau"), leaf("chua-biet-gu"),
      ]},
      { key: "s2-album-price", type: "pricing", title: "Báo giá", serviceKey: "wedding_album" },
      { key: "s2-album-close", type: "subgroup", title: "Chốt", children: [
        leaf("chon-duoc-goi"), leaf("giu-lich-coc"),
      ]},
      { key: "s2-album-noclose", type: "subgroup", title: "Không chốt", children: [
        leaf("che-gia-cao"), leaf("xin-giam-gia"), leaf("so-sanh-ben-khac"), leaf("hoi-chong-gia-dinh"),
        leaf("xin-suy-nghi-them"), leaf("chua-tin-anh-that"), leaf("lo-ngan-sach"),
        leaf("xin-giam-them"), leaf("tham-khao-them"), leaf("dang-ban"),
      ]},
    ]},
    { key: "s2-party", type: "group", title: "Phóng sự cưới", serviceKey: "wedding_party", children: [
      { key: "s2-party-price", type: "pricing", title: "Báo giá", serviceKey: "wedding_party" },
    ]},
    { key: "s2-family", type: "group", title: "Gia đình", serviceKey: "family", children: [
      { key: "s2-family-price", type: "pricing", title: "Báo giá", serviceKey: "family" },
    ]},
    { key: "s2-gate", type: "group", title: "Ảnh cổng", serviceKey: "wedding_gate", children: [
      { key: "s2-gate-price", type: "pricing", title: "Báo giá", serviceKey: "wedding_gate" },
    ]},
    { key: "s2-beauty", type: "group", title: "Beauty", serviceKey: "beauty", children: [
      { key: "s2-beauty-price", type: "pricing", title: "Báo giá", serviceKey: "beauty" },
    ]},
    { key: "s2-other", type: "group", title: "Các dịch vụ khác" },
  ]},
  { key: "s3", type: "stage", title: "3. Tư vấn & Concept", children: [
    leaf("xem-anh-mau"), leaf("chua-biet-gu"),
  ]},
  { key: "s4", type: "stage", title: "4. Báo giá", children: [
    leaf("hoi-gia-chua-ngay"), leaf("hoi-gia-co-ngay"), leaf("hoi-chi-tiet-goi"),
  ]},
  { key: "s5", type: "stage", title: "5. Xử lý phân vân", children: [
    leaf("phan-van"), leaf("che-gia-cao"), leaf("xin-giam-gia"), leaf("so-sanh-ben-khac"),
    leaf("hoi-chong-gia-dinh"), leaf("xin-suy-nghi-them"), leaf("chua-tin-anh-that"),
    leaf("lo-ngan-sach"), leaf("xin-giam-them"), leaf("tham-khao-them"), leaf("dang-ban"),
  ]},
  { key: "s6", type: "stage", title: "6. Chốt sale", children: [
    leaf("chon-duoc-goi"), leaf("giu-lich-coc"),
  ]},
  { key: "s7", type: "stage", title: "7. Sau chốt / chuyển người", children: [
    leaf("gap-nguoi-that"), leaf("dia-chi-gio-lam"),
  ]},
];

/** Flatten seed → rows (node_key leaf = parentKey + ':' + scenario để duy nhất khi trỏ lại). */
function flattenSeed(nodes: SeedNode[], parent: string | null, out: TreeRow[]): void {
  let order = 10;
  for (const n of nodes) {
    const nodeKey = n.key ?? (n.type === "leaf" ? `${parent}:${n.scenario}` : `${parent}:${n.title}`);
    out.push({
      nodeKey,
      parentKey: parent,
      nodeType: n.type,
      title: n.title ?? "",
      serviceKey: n.serviceKey ?? null,
      priceSource: null,
      scenarioKey: n.type === "leaf" ? (n.scenario ?? null) : null,
      sortOrder: order,
    });
    order += 10;
    if (n.children?.length) flattenSeed(n.children, nodeKey, out);
  }
}

/** Rows skeleton đã flatten — export để test cấu trúc cây (thuần, không DB). */
export function getSeedTreeRows(): TreeRow[] {
  const rows: TreeRow[] = [];
  flattenSeed(SEED_TREE, null, rows);
  return rows;
}

async function seedTreeSkeleton(): Promise<void> {
  const rows = getSeedTreeRows();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO lulu_scenario_tree (node_key, parent_key, node_type, title, service_key, scenario_key, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (node_key) DO NOTHING`,
        [r.nodeKey, r.parentKey, r.nodeType, r.title, r.serviceKey, r.scenarioKey, r.sortOrder],
      );
      inserted += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
    if (inserted > 0) console.log(`[ScenarioTree] seed thêm ${inserted}/${rows.length} node cây kịch bản`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Dựng cây (nested) cho FE ─────────────────────────────────────────────────

function mapRow(r: Record<string, unknown>): TreeRow {
  return {
    nodeKey: String(r.node_key),
    parentKey: (r.parent_key as string) ?? null,
    nodeType: (r.node_type as TreeNodeType) ?? "group",
    title: (r.title as string) ?? "",
    serviceKey: (r.service_key as string) ?? null,
    priceSource: (r.price_source as string) ?? null,
    scenarioKey: (r.scenario_key as string) ?? null,
    sortOrder: Number(r.sort_order ?? 100),
  };
}

const leafNode = (nodeKey: string, title: string, serviceKey: string | null, order: number): TreeNode => ({
  nodeKey, parentKey: null, nodeType: "leaf", title, serviceKey, priceSource: null, scenarioKey: null, sortOrder: order, children: [],
});

/**
 * CÂY SERVICE-FIRST (nested) — SINH ĐỘNG từ lulu_service_map + template 7 bước.
 * Root 1 = 🌐 Chào hỏi chung; sau đó mỗi DỊCH VỤ là 1 card (thu gọn) → 7 bước → tình huống.
 * Số gói/giá đọc realtime 1 lần (getServicePricePreview) để hiện trên card. KHÔNG throw (lỗi → []).
 */
export async function buildScenarioTree(): Promise<TreeNode[]> {
  try {
    await ensureScenarioTreeTable(); // giữ bảng cũ tồn tại (chống DROP), UI không đọc từ nó
    // MỖI NHÓM BẢNG GIÁ (service_groups active) = 1 CARD dịch vụ. Nguồn dịch vụ = chính bảng giá.
    const allGroups = await getServicePricePreview(null).catch(
      () => [] as Awaited<ReturnType<typeof getServicePricePreview>>,
    );
    // Đếm số tình huống ĐÃ có golden theo dịch vụ (slug) — hiện tiến độ trên card. Fail-soft.
    const filledByService = new Map<string, number>();
    try {
      const r = await pool.query(
        `SELECT service_key, COUNT(DISTINCT node_key)::int AS n FROM lulu_sale_script_examples
         WHERE service_key IS NOT NULL AND ideal_response <> '' AND is_active = true GROUP BY service_key`,
      );
      for (const row of r.rows as Array<{ service_key: string; n: number }>) filledByService.set(row.service_key, Number(row.n));
    } catch { /* chưa có bảng/rows → 0 */ }

    const roots: TreeNode[] = [];

    // Root 1 — 🌐 Chào hỏi chung (script toàn studio, serviceKey null).
    const greetKey = "global-chao-hoi";
    roots.push({
      nodeKey: greetKey, parentKey: null, nodeType: "greeting", title: "🌐 Chào hỏi chung",
      serviceKey: null, priceSource: null, scenarioKey: null, sortOrder: 0,
      meta: { situationCount: GREETING_SITUATIONS.length },
      children: GREETING_SITUATIONS.map((s, i) => leafNode(`${greetKey}::${s.key}`, s.title, null, (i + 1) * 10)),
    });

    // Root 2..n — mỗi NHÓM GIÁ 1 card → 7 bước RIÊNG → tình huống. serviceKey = slug tên nhóm
    // (khoá bền, không lộ id); priceSource = tên nhóm (đọc giá realtime). KHÔNG trộn script.
    let svcOrder = 100;
    for (const g of allGroups) {
      const groupName = g.groupName;
      const svcSlug = slugifyGroup(groupName);
      const svcKey = `svc::${svcSlug}`;
      const steps: TreeNode[] = SERVICE_STEPS.map((step, si) => {
        const stepKey = `${svcKey}::${step.key}`;
        const situations = step.situations.map((sit, ci) =>
          leafNode(`${stepKey}::${sit.key}`, sit.title, svcSlug, (ci + 1) * 10));
        return {
          nodeKey: stepKey, parentKey: svcKey, nodeType: step.showPricing ? "pricing" : "step",
          title: step.title, serviceKey: svcSlug, priceSource: groupName, scenarioKey: null,
          sortOrder: (si + 1) * 10,
          meta: { situationCount: situations.length, showPricing: !!step.showPricing },
          children: situations,
        } as TreeNode;
      });
      roots.push({
        nodeKey: svcKey, parentKey: null, nodeType: "service", title: groupName,
        serviceKey: svcSlug, priceSource: groupName, scenarioKey: null, sortOrder: svcOrder,
        meta: {
          groupName,
          packageCount: (g.packages ?? []).length,
          situationCount: SITUATIONS_PER_SERVICE,
          filledCount: filledByService.get(svcSlug) ?? 0,
          priceConnected: true,
          imageUrl: g.imageUrl ?? null,
        },
        children: steps,
      });
      svcOrder += 10;
    }
    return roots;
  } catch (err) {
    console.error("[ScenarioTree] buildScenarioTree lỗi (fail-soft):", String(err).slice(0, 160));
    return [];
  }
}

// Giữ để không vỡ import cũ (mapRow/listScenarios/summarizeWhenServer) — không dùng ở cây mới.
void mapRow; void listScenarios; void summarizeWhenServer;

/** Thêm leaf (trỏ scenario có sẵn) vào 1 node cha. Trả false nếu cha không tồn tại. */
export async function addLeafToNode(parentKey: string, scenarioKey: string): Promise<boolean> {
  await ensureScenarioTreeTable();
  const p = await pool.query(`SELECT node_type FROM lulu_scenario_tree WHERE node_key = $1`, [parentKey]);
  if (!p.rows.length) return false;
  const maxR = await pool.query(`SELECT COALESCE(MAX(sort_order),0) AS n FROM lulu_scenario_tree WHERE parent_key = $1`, [parentKey]);
  const order = Number(maxR.rows[0]?.n ?? 0) + 10;
  await pool.query(
    `INSERT INTO lulu_scenario_tree (node_key, parent_key, node_type, title, scenario_key, sort_order)
     VALUES ($1,$2,'leaf','',$3,$4)
     ON CONFLICT (node_key) DO NOTHING`,
    [`${parentKey}:${scenarioKey}`, parentKey, scenarioKey, order],
  );
  return true;
}
