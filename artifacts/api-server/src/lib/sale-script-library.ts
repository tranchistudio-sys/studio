import { pool } from "@workspace/db";

/**
 * SALE SCRIPT LIBRARY — "Bảng Kịch bản Sale: Hỏi & Trả lời" (yêu cầu 30/07).
 *
 * Chủ studio tự viết GOLDEN EXAMPLES (câu khách hỏi ↔ câu sale nên trả lời) cho từng nhánh
 * trong Cây kịch bản. AI THAM KHẢO giọng/cách dẫn/tâm lý — KHÔNG đọc y nguyên, KHÔNG lấy giá
 * từ đây (giá luôn realtime từ "Dịch vụ & Bảng giá" — sale-pricing.ts). Đây là nguồn CÁCH NÓI,
 * không phải nguồn SỰ THẬT VỀ GIÁ.
 *
 * AN TOÀN: bảng RIÊNG additive; retrieval THUẦN deterministic (không embedding, không nhét
 * cả bảng vào prompt) — chỉ top-N ví dụ gần nhất theo trùng từ khoá.
 */

export type ScriptRow = {
  id: number;
  nodeKey: string;             // nhánh cây sở hữu bảng này
  scenarioKey: string | null;  // leaf → dùng cho retrieval theo scenario; container → null
  serviceKey: string | null;   // dịch vụ sở hữu (service-rooted) → retrieval theo dịch vụ
  groupLabel: string;          // NHÓM (Album cưới / Phóng sự…) — nhãn từ export ChatGPT/Excel
  situationLabel: string;      // TÌNH HUỐNG (Hỏi giá / Chê giá…) — dùng để lọc trong bảng
  customerText: string;
  idealResponse: string;
  notes: string;
  isActive: boolean;
  sortOrder: number;
  source: "auto" | "manual";   // 'auto' = hệ thống sinh; 'manual' = admin nhập/chỉnh
};

let ensured = false;
export async function ensureScriptTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_sale_script_examples (
      id             SERIAL PRIMARY KEY,
      node_key       TEXT NOT NULL,
      scenario_key   TEXT,
      group_label    TEXT NOT NULL DEFAULT '',
      situation_label TEXT NOT NULL DEFAULT '',
      customer_text  TEXT NOT NULL DEFAULT '',
      ideal_response TEXT NOT NULL DEFAULT '',
      notes          TEXT NOT NULL DEFAULT '',
      is_active      BOOLEAN NOT NULL DEFAULT true,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Additive cho bảng đã tồn tại (bản trước 3 cột) — thêm 2 cột nhãn, KHÔNG destructive.
  await pool.query(`ALTER TABLE lulu_sale_script_examples ADD COLUMN IF NOT EXISTS group_label TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE lulu_sale_script_examples ADD COLUMN IF NOT EXISTS situation_label TEXT NOT NULL DEFAULT ''`);
  // (Service-rooted) service_key = khoá BỀN của dịch vụ sở hữu golden này → retrieval theo DỊCH VỤ
  // trực tiếp (không chỉ theo scenario_key). Additive, nullable.
  await pool.query(`ALTER TABLE lulu_sale_script_examples ADD COLUMN IF NOT EXISTS service_key TEXT`);
  // Nguồn dòng: 'auto' = hệ thống tự sinh từ Bảng giá (sync); 'manual' = admin nhập/chỉnh tay.
  // Rows CŨ (trước cột này) mặc định 'manual' — coi như admin sở hữu, sync KHÔNG đè.
  await pool.query(`ALTER TABLE lulu_sale_script_examples ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lulu_script_node ON lulu_sale_script_examples (node_key, sort_order)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lulu_script_scenario ON lulu_sale_script_examples (scenario_key) WHERE scenario_key IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lulu_script_service ON lulu_sale_script_examples (service_key) WHERE service_key IS NOT NULL`);
  ensured = true;
}

function mapRow(r: Record<string, unknown>): ScriptRow {
  return {
    id: Number(r.id),
    nodeKey: String(r.node_key),
    scenarioKey: (r.scenario_key as string) ?? null,
    serviceKey: (r.service_key as string) ?? null,
    groupLabel: (r.group_label as string) ?? "",
    situationLabel: (r.situation_label as string) ?? "",
    customerText: (r.customer_text as string) ?? "",
    idealResponse: (r.ideal_response as string) ?? "",
    notes: (r.notes as string) ?? "",
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order ?? 0),
    source: (r.source as string) === "auto" ? "auto" : "manual",
  };
}

// ─── Chống hard-code GIÁ trong câu mẫu (cảnh báo, không chặn cứng) ────────────
// Câu mẫu NÊN dùng {{PRICE}} / "gói hiện tại" thay số cụ thể — vì giá lấy realtime.
// Regex thật ở sale-scenario-steps.ts (module thuần) — re-export giữ import cũ.
export { scriptHasHardcodedPrice } from "./sale-scenario-steps";
import { scriptHasHardcodedPrice } from "./sale-scenario-steps";

// ─── Đọc / Ghi ────────────────────────────────────────────────────────────────

export async function listScripts(nodeKey: string): Promise<ScriptRow[]> {
  await ensureScriptTable();
  const r = await pool.query(
    `SELECT * FROM lulu_sale_script_examples WHERE node_key = $1 ORDER BY sort_order ASC, id ASC`,
    [nodeKey],
  );
  return (r.rows as Array<Record<string, unknown>>).map(mapRow);
}

export type ScriptInput = { groupLabel?: string; situationLabel?: string; customerText: string; idealResponse: string; notes?: string; isActive?: boolean };

/**
 * LƯU TOÀN BỘ bảng của 1 node (thay thế) — khớp thao tác spreadsheet "Lưu bảng".
 * Transaction: xoá cũ + chèn mới theo thứ tự. Bỏ dòng trống (không có cả 2 cột).
 * Trả về danh sách sau lưu + cảnh báo dòng có vẻ chứa giá cứng.
 */
export async function saveScripts(
  nodeKey: string, scenarioKey: string | null, rows: ScriptInput[], serviceKey: string | null = null,
  source: "auto" | "manual" = "manual",
): Promise<{ rows: ScriptRow[]; priceWarnings: number[] }> {
  await ensureScriptTable();
  const clean = (rows ?? [])
    .map((r) => ({
      groupLabel: String(r.groupLabel ?? "").trim().slice(0, 200),
      situationLabel: String(r.situationLabel ?? "").trim().slice(0, 200),
      customerText: String(r.customerText ?? "").trim().slice(0, 2000),
      idealResponse: String(r.idealResponse ?? "").trim().slice(0, 4000),
      notes: String(r.notes ?? "").trim().slice(0, 1000),
      isActive: r.isActive !== false,
    }))
    .filter((r) => r.customerText || r.idealResponse)
    .slice(0, 1000);
  const priceWarnings: number[] = [];
  clean.forEach((r, i) => { if (scriptHasHardcodedPrice(r.idealResponse)) priceWarnings.push(i + 1); });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM lulu_sale_script_examples WHERE node_key = $1`, [nodeKey]);
    let order = 10;
    for (const r of clean) {
      await client.query(
        `INSERT INTO lulu_sale_script_examples
           (node_key, scenario_key, service_key, group_label, situation_label, customer_text, ideal_response, notes, is_active, sort_order, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [nodeKey, scenarioKey, serviceKey, r.groupLabel, r.situationLabel, r.customerText, r.idealResponse, r.notes, r.isActive, order, source],
      );
      order += 10;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { rows: await listScripts(nodeKey), priceWarnings };
}

/** Đổi đoạn service trong node_key: svc::<from>::rest → svc::<to>::rest. null nếu không khớp. */
export function retargetNodeKey(nodeKey: string, fromSlug: string, toSlug: string): string | null {
  const prefix = `svc::${fromSlug}::`;
  return nodeKey.startsWith(prefix) ? `svc::${toSlug}::${nodeKey.slice(prefix.length)}` : null;
}

/**
 * CHÉP toàn bộ golden từ 1 dịch vụ (slug) sang dịch vụ khác — tiết kiệm công soạn 11×35.
 * BỎ QUA tình huống mà đích ĐÃ có kịch bản (không đè). service_key/node_key/group_label
 * đổi sang đích; giá vẫn {{PRICE}} realtime (chỉ chép CÁCH NÓI). scenario_key = null.
 * Trả về {copiedRows, copiedSituations, skippedSituations}.
 */
export async function copyServiceGolden(
  fromSlug: string, toSlug: string, toGroupName: string,
): Promise<{ copiedRows: number; copiedSituations: number; skippedSituations: number }> {
  await ensureScriptTable();
  if (!fromSlug || !toSlug || fromSlug === toSlug) return { copiedRows: 0, copiedSituations: 0, skippedSituations: 0 };
  const src = await pool.query(
    `SELECT node_key, situation_label, customer_text, ideal_response, notes, is_active, sort_order
     FROM lulu_sale_script_examples WHERE service_key = $1 AND ideal_response <> '' ORDER BY node_key, sort_order, id`,
    [fromSlug],
  );
  if (src.rows.length === 0) return { copiedRows: 0, copiedSituations: 0, skippedSituations: 0 };
  // Tình huống đích đã có kịch bản → bỏ qua (không đè).
  const existing = await pool.query(
    `SELECT DISTINCT node_key FROM lulu_sale_script_examples WHERE service_key = $1 AND ideal_response <> ''`, [toSlug],
  );
  const filledTarget = new Set((existing.rows as Array<{ node_key: string }>).map((r) => r.node_key));

  const bySrcNode = new Map<string, Array<Record<string, unknown>>>();
  for (const r of src.rows as Array<Record<string, unknown>>) {
    const k = String(r.node_key);
    if (!bySrcNode.has(k)) bySrcNode.set(k, []);
    bySrcNode.get(k)!.push(r);
  }

  let copiedRows = 0, copiedSituations = 0, skippedSituations = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [srcNode, rows] of bySrcNode) {
      const target = retargetNodeKey(srcNode, fromSlug, toSlug);
      if (!target) continue;
      if (filledTarget.has(target)) { skippedSituations++; continue; } // đích đã có → giữ nguyên
      let order = 10;
      for (const r of rows) {
        await client.query(
          `INSERT INTO lulu_sale_script_examples
             (node_key, scenario_key, service_key, group_label, situation_label, customer_text, ideal_response, notes, is_active, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [target, null, toSlug, toGroupName, r.situation_label ?? "", r.customer_text ?? "", r.ideal_response ?? "", r.notes ?? "", r.is_active !== false, order],
        );
        order += 10; copiedRows++;
      }
      copiedSituations++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { copiedRows, copiedSituations, skippedSituations };
}

// ─── Parse DÁN từ Excel/Google Sheets (TSV/CSV) — THUẦN, test được ───────────

/**
 * Tách văn bản dán từ Excel/Sheets/ChatGPT → ma trận ô (mỗi dòng = mảng cột).
 * Ô ngăn bằng TAB (mặc định); fallback dấu | hoặc ≥2 khoảng trắng. Giữ NGUYÊN mọi dòng
 * (kể cả header) — việc map cột + bỏ header do lớp trên quyết (preview).
 */
export function parsePasteMatrix(text: string): string[][] {
  return (text ?? "").replace(/\r\n/g, "\n").split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => (line.includes("\t") ? line.split("\t") : line.split(/\s*\|\s*|\s{2,}/)).map((c) => c.trim()));
}

/** Dòng đầu có phải HEADER không (cột chứa các chữ tiêu đề chuẩn). */
export function looksLikeHeader(cols: string[]): boolean {
  const joined = cols.join(" ").toLowerCase();
  const hits = ["nhóm", "nhom", "tình huống", "tinh huong", "khách", "khach", "trả lời", "tra loi", "ghi chú", "ghi chu", "sale"]
    .filter((k) => joined.includes(k)).length;
  return hits >= 2;
}

const COL_ORDER_5: Array<keyof ScriptInput> = ["groupLabel", "situationLabel", "customerText", "idealResponse", "notes"];

/**
 * Ma trận → ScriptInput[] theo THỨ TỰ CỘT chuẩn (Nhóm|Tình huống|Khách|Trả lời|Ghi chú).
 * Tự suy khi thiếu cột: 3 cột = [khách, trả lời, ghi chú]; 2 cột = [khách, trả lời].
 * `mapping` (tuỳ chọn) ép thứ tự cột từ preview (index → field | 'skip').
 */
export function matrixToRows(matrix: string[][], mapping?: Array<keyof ScriptInput | "skip">): ScriptInput[] {
  const out: ScriptInput[] = [];
  for (let i = 0; i < matrix.length; i++) {
    const cols = matrix[i];
    if (i === 0 && !mapping && looksLikeHeader(cols)) continue; // bỏ header khi tự-suy
    const row: ScriptInput = { customerText: "", idealResponse: "", notes: "", groupLabel: "", situationLabel: "" };
    if (mapping) {
      mapping.forEach((field, idx) => { if (field !== "skip" && cols[idx] != null) (row as Record<string, unknown>)[field] = cols[idx]; });
    } else if (cols.length >= 5) {
      COL_ORDER_5.forEach((f, idx) => { (row as Record<string, unknown>)[f] = cols[idx] ?? ""; });
    } else if (cols.length === 4) {
      [row.groupLabel, row.situationLabel, row.customerText, row.idealResponse] = [cols[0], cols[1], cols[2], cols[3]] as [string, string, string, string];
    } else if (cols.length === 3) {
      [row.customerText, row.idealResponse, row.notes] = [cols[0], cols[1], cols[2]] as [string, string, string];
    } else {
      [row.customerText, row.idealResponse] = [cols[0] ?? "", cols[1] ?? ""];
    }
    if (!row.customerText && !row.idealResponse) continue;
    out.push(row);
  }
  return out;
}

/** Tiện ích cũ (tự-suy, không mapping) — giữ cho test/back-compat. */
export function parsePastedRows(text: string): ScriptInput[] {
  return matrixToRows(parsePasteMatrix(text));
}

// ─── Tìm kiếm trong bảng (admin) ─────────────────────────────────────────────

export async function searchScripts(nodeKey: string, q: string): Promise<ScriptRow[]> {
  const all = await listScripts(nodeKey);
  const t = normalizeVi(q);
  if (!t) return all;
  return all.filter((r) => normalizeVi(`${r.customerText} ${r.idealResponse} ${r.notes}`).includes(t));
}

// ─── RETRIEVAL cho AI (deterministic top-N theo trùng từ khoá) ───────────────

function normalizeVi(s: string): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}
const STOP = new Set(["la", "va", "co", "khong", "ko", "cho", "minh", "ban", "em", "chi", "anh", "a", "the", "nao", "gi", "voi", "nhe", "nha", "ma", "duoc", "dc", "o", "cua", "de", "thi"]);
function tokens(s: string): string[] {
  return normalizeVi(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));
}

export type GoldenExample = {
  customerText: string; idealResponse: string; notes: string; score: number;
  /** Nguồn script (trace SCRIPT SOURCE): 'service' = đúng dịch vụ khoá; 'scenario' = thẻ chung; 'greeting' = chào hỏi global. */
  source?: "service" | "scenario" | "greeting";
  /** Điểm khớp TỪ KHOÁ thuần (không tính tier/step) — 0 = golden "mù" với câu khách. */
  kw?: number;
};

/**
 * Lấy top-N ví dụ GẦN NHẤT với tin khách — SERVICE-FIRST (luật chủ):
 * khách đang bàn dịch vụ nào thì script CỦA DỊCH VỤ ĐÓ thắng script chung.
 *
 * Xếp hạng nguồn (tier): (1) script của ĐÚNG dịch vụ (service_key = serviceSlug, gồm cả
 * script gắn scenario lẫn script cây) → (2) script gắn scenario thắng nhưng KHÔNG gắn
 * dịch vụ (bộ chung/cũ) — chỉ dùng khi tier 1 thiếu. KHÔNG lấy script của dịch vụ KHÁC.
 * Trong cùng tier: điểm = số từ khoá trùng giữa tin khách và câu-khách-mẫu + mật độ.
 * Giá trong ví dụ vẫn là historical — CRM luôn thắng. fail-soft → [].
 */
export async function getGoldenExamples(
  scenarioKey: string | null, customerMessage: string, topN = 4, serviceSlug: string | null = null,
  stepHint: string | null = null,
): Promise<GoldenExample[]> {
  try {
    await ensureScriptTable();
    type Row = { node_key: string; customer_text: string; ideal_response: string; notes: string; service_key: string | null; scenario_key: string | null };
    let rows: Row[] = [];
    if (scenarioKey && serviceSlug) {
      const r = await pool.query(
        `SELECT node_key, customer_text, ideal_response, notes, service_key, scenario_key FROM lulu_sale_script_examples
         WHERE is_active = true AND ideal_response <> ''
           AND (service_key = $1 OR (scenario_key = $2 AND service_key IS NULL))
         ORDER BY node_key, sort_order LIMIT 400`,
        [serviceSlug, scenarioKey],
      );
      rows = r.rows as Row[];
    } else if (serviceSlug) {
      const r = await pool.query(
        `SELECT node_key, customer_text, ideal_response, notes, service_key, scenario_key FROM lulu_sale_script_examples
         WHERE service_key = $1 AND is_active = true AND ideal_response <> ''
         ORDER BY node_key, sort_order LIMIT 400`,
        [serviceSlug],
      );
      rows = r.rows as Row[];
    } else if (scenarioKey) {
      const r = await pool.query(
        `SELECT node_key, customer_text, ideal_response, notes, service_key, scenario_key FROM lulu_sale_script_examples
         WHERE scenario_key = $1 AND is_active = true AND ideal_response <> ''`,
        [scenarioKey],
      );
      rows = r.rows as Row[];
    }
    // Fallback CHÀO HỎI CHUNG: khách CHƯA có dịch vụ (serviceSlug null) và scenario không có
    // script → dùng bộ chào hỏi global (node global-chao-hoi::*) làm giọng chung. KHÔNG áp khi
    // đã khoá dịch vụ (service-first tuyệt đối).
    let greetingSource = false;
    if (rows.length === 0 && !serviceSlug) {
      const rg = await pool.query(
        `SELECT node_key, customer_text, ideal_response, notes, service_key, scenario_key FROM lulu_sale_script_examples
         WHERE node_key LIKE 'global-chao-hoi::%' AND is_active = true AND ideal_response <> ''
         ORDER BY node_key, sort_order LIMIT 100`,
      );
      rows = rg.rows as Row[];
      greetingSource = true;
    }
    if (rows.length === 0) return [];
    const msgTokens = new Set(tokens(customerMessage));
    const scored = rows.map((row) => {
      const exTokens = tokens(row.customer_text);
      let overlap = 0;
      for (const tk of exTokens) if (msgTokens.has(tk)) overlap++;
      const denom = Math.max(1, exTokens.length);
      const kw = overlap + overlap / denom; // điểm khớp từ khoá (mật độ cao hơn = tốt hơn)
      // SERVICE-FIRST: cùng dịch vụ trội 1 BẬC — script chung dù khớp từ khoá mạnh
      // cũng không vượt được script đúng dịch vụ (tier + kw, tier = 100).
      const sameService = !!(serviceSlug && row.service_key === serviceSlug);
      const source: GoldenExample["source"] = greetingSource ? "greeting" : (sameService ? "service" : "scenario");
      // STEP-HINT: action Router đã chỉ giai đoạn (báo giá/phân vân/chốt...) → row thuộc ĐÚNG BƯỚC
      // được trội hơn (chống bốc trúng row lệch nghĩa khi điểm keyword thấp/tie).
      const stepBoost = stepHint && row.node_key.includes(`::${stepHint}::`) ? 50 : 0;
      return { customerText: row.customer_text, idealResponse: row.ideal_response, notes: row.notes ?? "", kw, score: (sameService ? 100 : 0) + stepBoost + kw, source };
    });
    scored.sort((a, b) => b.score - a.score);
    // Không tin nào trùng từ khoá → vẫn trả vài ví dụ ĐẦU TIER CAO làm "giọng chung".
    const hits = scored.filter((s) => s.kw > 0);
    return (hits.length ? hits : scored).slice(0, topN); // giữ kw để tầng finalize biết golden "mù"
  } catch (err) {
    console.error("[ScriptLib] getGoldenExamples lỗi (fail-soft):", String(err).slice(0, 150));
    return [];
  }
}

/** Khối "VÍ DỤ CÁCH SALE THẬT" chèn vào context LLM. "" nếu không có ví dụ. */
export function buildGoldenExamplesBlock(examples: GoldenExample[]): string {
  if (!examples.length) return "";
  const lines = examples.map((e, i) =>
    `Ví dụ ${i + 1}:\n  Khách: ${e.customerText}\n  Sale trả lời (mẫu): ${e.idealResponse}${e.notes ? `\n  (Lưu ý: ${e.notes})` : ""}`,
  );
  // STATIC-vs-DYNAMIC (luật chủ mục A/C/D/E/G): ví dụ = GUIDANCE (cách nói), KHÔNG phải FACTS.
  // Giá/khuyến mãi trong ví dụ là HISTORICAL — tuyệt đối không lặp lại; luôn lấy số hiện tại từ CRM.
  return (
    `CÁCH SALE THẬT CỦA STUDIO XỬ LÝ TÌNH HUỐNG NÀY (GOLDEN EXAMPLES — chỉ để học GIỌNG, CÁCH DẪN, TÂM LÝ, THỨ TỰ Ý):\n` +
    `${lines.join("\n")}\n` +
    `RÀNG BUỘC KHI DÙNG VÍ DỤ:\n` +
    `- KHÔNG đọc y nguyên — diễn đạt lại tự nhiên theo ngữ cảnh khách.\n` +
    `- MỌI con số GIÁ trong ví dụ là DỮ LIỆU CŨ (historical). BỎ QUA nó. Con số giá PHẢI lấy từ ` +
    `BẢNG GIÁ CRM ở trên. Nếu ví dụ ghi giá khác bảng giá → dùng bảng giá, KHÔNG dùng số trong ví dụ.\n` +
    `- Nếu ví dụ nói "đang giảm/khuyến mãi/ưu đãi" nhưng BẢNG GIÁ CRM hiện KHÔNG có ưu đãi → KHÔNG được ` +
    `nói đang giảm. Chỉ báo đúng giá thường hiện tại.\n` +
    `- Thứ tự ưu tiên khi mâu thuẫn: LUẬT AN TOÀN > CRM/BẢNG GIÁ > TRÍ NHỚ HỘI THOẠI > KỊCH BẢN/VÍ DỤ. ` +
    `Kịch bản/ví dụ KHÔNG override được bảng giá CRM.`
  );
}
