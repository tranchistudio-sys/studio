import { pool } from "@workspace/db";
import { SERVICE_STEPS, GREETING_SITUATIONS, GREETING_ROOT_KEY, slugifyGroup } from "./sale-scenario-steps";
import { ensureScriptTable } from "./sale-script-library";
import { SERVICE_TEMPLATES, GREETING_TEMPLATES, type TemplateRow } from "./sale-scenario-templates";

/**
 * ĐỒNG BỘ Bảng giá → Kịch bản Sale (auto-generate).
 *
 * NGUYÊN TẮC:
 * - Idempotent: chạy nhiều lần ra cùng kết quả, lần sau tạo 0 dòng.
 * - SKIP-IF-FILLED: node đã có dòng (auto HAY manual) → GIỮ NGUYÊN, tuyệt đối không đè.
 * - Xếp đúng nhóm dịch vụ hiện có (node_key = svc::<slug tên nhóm>::<step>::<situation>) —
 *   KHÔNG tạo root trùng. Nhóm/gói mới tự có kịch bản (token {{PACKAGE_NAME}}… thích ứng mọi gói).
 * - Giá/tên gói/nội dung/ưu đãi = token realtime, KHÔNG số cứng (đã đảm bảo trong template).
 * - Fail-soft: lỗi 1 node không làm hỏng toàn bộ; gom vào errors[].
 */

export type SyncReport = {
  groupsScanned: number;
  packagesScanned: number;
  mappingsCreated: number;    // nhóm dịch vụ (slug) lần đầu thấy trong lần sync này
  situationsCreated: number;  // số TÌNH HUỐNG (node) được tạo kịch bản mới
  scriptsCreated: number;     // tổng số DÒNG câu hỏi–đáp auto tạo mới
  situationsUpdated: number;  // số node TOÀN-auto được nâng cấp template (nội dung đổi)
  scriptsUpdated: number;     // tổng số DÒNG sau nâng cấp ở các node đó
  scriptsSkipped: number;     // số node bỏ qua (có dòng manual HOẶC template không đổi)
  errors: string[];
};

const emptyReport = (): SyncReport => ({
  groupsScanned: 0, packagesScanned: 0, mappingsCreated: 0,
  situationsCreated: 0, scriptsCreated: 0, situationsUpdated: 0, scriptsUpdated: 0, scriptsSkipped: 0, errors: [],
});

/**
 * Đồng bộ Bảng giá → Kịch bản. opts.groupName: chỉ đồng bộ 1 nhóm (dùng cho hook thêm gói/nhóm);
 * bỏ trống = toàn hệ thống (backfill).
 */
export async function syncPricingToSaleScenarios(
  opts: { groupName?: string | null } = {},
): Promise<SyncReport> {
  const report = emptyReport();
  await ensureScriptTable();

  const wantGroup = (opts.groupName ?? "").trim().toLowerCase();

  // 1) CHÀO HỎI CHUNG (global, 1 bộ duy nhất) — chỉ khi backfill toàn bộ (không lặp theo gói).
  if (!wantGroup) {
    for (const sit of GREETING_SITUATIONS) {
      const nodeKey = `${GREETING_ROOT_KEY}::${sit.key}`;
      try {
        const r = await upsertAutoNode(nodeKey, null, sit.title, "Chào hỏi chung", GREETING_TEMPLATES[sit.key] ?? []);
        if (r.kind === "skipped") report.scriptsSkipped++;
        else if (r.kind === "created") { report.situationsCreated++; report.scriptsCreated += r.rows; }
        else { report.situationsUpdated++; report.scriptsUpdated += r.rows; }
      } catch (e) { report.errors.push(`greeting/${sit.key}: ${msg(e)}`); }
    }
  }

  // 2) Mỗi NHÓM GIÁ active → 7 bước × tình huống (service-level, token thích ứng mọi gói).
  // Đọc THẲNG service_groups (kể cả nhóm CHƯA có gói) — kịch bản service-level không cần gói.
  let groups: Array<{ name: string; pkgCount: number }> = [];
  try {
    const gr = await pool.query(
      `SELECT g.name AS name, COUNT(p.id) FILTER (WHERE p.is_active = 1) AS pkg_count
       FROM service_groups g LEFT JOIN service_packages p ON p.group_id = g.id
       WHERE g.is_active = 1 GROUP BY g.id, g.name ORDER BY g.sort_order ASC, g.id ASC`,
    );
    groups = (gr.rows as Array<{ name: string; pkg_count: string }>).map((r) => ({ name: r.name, pkgCount: Number(r.pkg_count ?? 0) }));
  } catch (e) { report.errors.push(`service_groups: ${msg(e)}`); return report; }

  for (const g of groups) {
    if (wantGroup && (g.name ?? "").trim().toLowerCase() !== wantGroup) continue;
    report.groupsScanned++;
    report.mappingsCreated++; // slug tên nhóm = mapping bền (cây đọc theo slug này)
    report.packagesScanned += g.pkgCount;
    const svcSlug = slugifyGroup(g.name);
    for (const step of SERVICE_STEPS) {
      for (const sit of step.situations) {
        const nodeKey = `svc::${svcSlug}::${step.key}::${sit.key}`;
        try {
          const r = await upsertAutoNode(nodeKey, svcSlug, sit.title, g.name, SERVICE_TEMPLATES[sit.key] ?? []);
          if (r.kind === "skipped") report.scriptsSkipped++;
          else if (r.kind === "created") { report.situationsCreated++; report.scriptsCreated += r.rows; }
          else { report.situationsUpdated++; report.scriptsUpdated += r.rows; }
        } catch (e) { report.errors.push(`${nodeKey}: ${msg(e)}`); }
      }
    }
  }
  return report;
}

type UpsertResult = { kind: "skipped" | "created" | "updated"; rows: number };

/**
 * Upsert template vào 1 node theo luật KHÔNG-ĐÈ-MANUAL:
 *  - node có ≥1 dòng MANUAL (admin nhập/chỉnh) → SKIP tuyệt đối.
 *  - node TRỐNG → chèn template (created).
 *  - node TOÀN dòng auto → so NỘI DUNG với template hiện tại:
 *      giống hệt → skip (idempotent, chạy N lần không đổi);
 *      khác → THAY bằng template mới (updated) — cho phép nâng cấp thư viện auto.
 */
async function upsertAutoNode(
  nodeKey: string, serviceKey: string | null, situationLabel: string, groupLabel: string, rows: TemplateRow[],
): Promise<UpsertResult> {
  if (!rows.length) return { kind: "skipped", rows: 0 };
  const exist = await pool.query(
    `SELECT customer_text, ideal_response, notes, source FROM lulu_sale_script_examples
     WHERE node_key = $1 ORDER BY sort_order ASC, id ASC`,
    [nodeKey],
  );
  const cur = exist.rows as Array<{ customer_text: string; ideal_response: string; notes: string; source: string }>;
  const hasManual = cur.some((r) => r.source !== "auto");
  if (hasManual) return { kind: "skipped", rows: 0 }; // admin đã đụng node này → bất khả xâm phạm
  const sig = (xs: Array<{ c: string; a: string; n: string }>) => xs.map((x) => `${x.c}${x.a}${x.n}`).join("");
  const curSig = sig(cur.map((r) => ({ c: r.customer_text, a: r.ideal_response, n: r.notes ?? "" })));
  const tplSig = sig(rows.map((r) => ({ c: r.customerText, a: r.idealResponse, n: r.notes ?? "" })));
  if (cur.length > 0 && curSig === tplSig) return { kind: "skipped", rows: 0 }; // template không đổi
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM lulu_sale_script_examples WHERE node_key = $1 AND source = 'auto'`, [nodeKey]);
    let order = 10, n = 0;
    for (const r of rows) {
      await client.query(
        `INSERT INTO lulu_sale_script_examples
           (node_key, scenario_key, service_key, group_label, situation_label, customer_text, ideal_response, notes, is_active, sort_order, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,'auto')`,
        [nodeKey, null, serviceKey, groupLabel, situationLabel, r.customerText, r.idealResponse, r.notes ?? "", order],
      );
      order += 10; n++;
    }
    await client.query("COMMIT");
    return { kind: cur.length === 0 ? "created" : "updated", rows: n };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function msg(e: unknown): string { return String((e as Error)?.message ?? e).slice(0, 120); }

/** Báo cáo tiếng Việt gọn cho toast admin. */
export function syncReportVN(r: SyncReport): string {
  const parts = [
    `${r.groupsScanned} nhóm · ${r.packagesScanned} gói`,
    `tạo mới ${r.situationsCreated} tình huống (${r.scriptsCreated} câu)`,
  ];
  if (r.situationsUpdated) parts.push(`nâng cấp ${r.situationsUpdated} tình huống auto (${r.scriptsUpdated} câu)`);
  parts.push(`giữ nguyên ${r.scriptsSkipped} tình huống`);
  if (r.errors.length) parts.push(`⚠ ${r.errors.length} lỗi`);
  return parts.join(" · ");
}
