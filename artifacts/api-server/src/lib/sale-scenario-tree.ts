import { pool } from "@workspace/db";
import { listScenarios } from "./sale-scenario-store";
import { summarizeWhenServer } from "./sale-scenario-types";

/**
 * CÂY KỊCH BẢN LULU — lớp TỔ CHỨC cho con người (Sales Brain V1, yêu cầu 30/07).
 *
 * Chủ studio quản lý kịch bản dạng CÂY THƯ MỤC thu gọn được (7 chặng → nhóm dịch vụ →
 * Concept/Báo giá/Chốt/Không chốt → tình huống), thay cho danh sách phẳng.
 *
 * QUAN TRỌNG: cây chỉ là CÁCH SẮP XẾP — KHÔNG thay engine. Resolver vẫn chạy PHẲNG trên
 * các scenario active (lulu_sale_scenarios) như cũ. Leaf trong cây chỉ TRỎ tới scenario_key
 * (một scenario có thể xuất hiện ở nhiều nhánh — chia sẻ, không nhân bản hành vi).
 * Node "pricing" (Báo giá) KHÔNG chứa số tiền — chỉ giữ service_key trỏ nguồn "Dịch vụ & Bảng giá".
 *
 * AN TOÀN: bảng RIÊNG additive (không đụng lulu_sale_scenarios), CREATE IF NOT EXISTS +
 * seed skeleton chỉ khi rỗng (UPSERT-missing để bản cập nhật thêm node mới, không đè node chủ sửa).
 */

export type TreeNodeType = "stage" | "group" | "subgroup" | "leaf" | "pricing";

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
  /** leaf: tóm tắt scenario để hiện nhanh (không cần mở). */
  scenario?: { name: string; enabled: boolean; status: string; whenText: string; missing?: boolean } | null;
};

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

/**
 * Cây đầy đủ (nested), leaf đính kèm tóm tắt scenario. KHÔNG bao giờ throw (lỗi → []).
 * KHÔNG nạp giá ở đây (nặng) — FE gọi /price-preview khi mở node pricing.
 */
export async function buildScenarioTree(): Promise<TreeNode[]> {
  try {
    await ensureScenarioTreeTable();
    const [treeRes, scenarios] = await Promise.all([
      pool.query(`SELECT * FROM lulu_scenario_tree ORDER BY sort_order ASC, node_key ASC`),
      listScenarios(),
    ]);
    const scMap = new Map(scenarios.map((s) => [s.scenarioKey, s]));
    const rows = (treeRes.rows as Array<Record<string, unknown>>).map(mapRow);

    const nodes = new Map<string, TreeNode>();
    for (const r of rows) {
      const node: TreeNode = { ...r, children: [] };
      if (r.nodeType === "leaf" && r.scenarioKey) {
        const sc = scMap.get(r.scenarioKey);
        const card = sc ? (sc.draftCard ?? sc.card) : null;
        node.scenario = sc && card
          ? { name: card.name, enabled: sc.enabled, status: sc.status, whenText: summarizeWhenServer(card), missing: false }
          : { name: r.scenarioKey, enabled: false, status: "draft", whenText: "", missing: true };
        if (!node.title) node.title = node.scenario.name;
      }
      nodes.set(r.nodeKey, node);
    }
    const roots: TreeNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentKey && nodes.has(node.parentKey)) nodes.get(node.parentKey)!.children.push(node);
      else roots.push(node);
    }
    const sortRec = (arr: TreeNode[]) => {
      arr.sort((a, b) => a.sortOrder - b.sortOrder || a.nodeKey.localeCompare(b.nodeKey));
      for (const n of arr) sortRec(n.children);
    };
    sortRec(roots);
    return roots;
  } catch (err) {
    console.error("[ScenarioTree] buildScenarioTree lỗi (fail-soft):", String(err).slice(0, 160));
    return [];
  }
}

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
