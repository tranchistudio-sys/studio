import { pool } from "@workspace/db";
import { type ScenarioCard, type ScenarioRecord, type ScenarioDef, cardToDef } from "./sale-scenario-types";
import { compileCard, validateEnsemble, type EnsembleIssue } from "./sale-scenario-compiler";
import { SEED_SCENARIOS } from "./sale-scenario-seed";

/**
 * Store cho Lulu Sale Scenario Manager — 3 bảng RIÊNG, additive tuyệt đối.
 *
 * AN TOÀN (đúng runbook chống DROP-drift PR #132):
 *  - CREATE TABLE IF NOT EXISTS tại đây + migrations.ts gọi ensure lúc startup
 *    + khai báo drizzle schema (lib/db/src/schema/lulu-scenarios.ts). KHÔNG DROP/ALTER destructive.
 *  - MỘT nguồn sự thật: cột card_json (bản ACTIVE đang chạy) + draft_json (nháp đang sửa).
 *    Bản active KHÔNG sửa trực tiếp — mọi sửa ghi vào draft_json; Apply mới promote.
 *  - Apply/Rollback theo NGUYÊN BỘ (ensemble snapshot trong lulu_scenario_versions):
 *    không rollback lẻ từng thẻ gây lệch bộ.
 *  - loadActiveScenarioDefs() nằm trên luồng trả lời (shadow/enforce) → KHÔNG bao giờ throw
 *    (lỗi DB → [] = resolver fail-open về Workflow V1).
 */

let ensured = false;
export async function ensureScenarioTables(): Promise<void> {
  if (ensured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_sale_scenarios (
      id               SERIAL PRIMARY KEY,
      scenario_key     TEXT NOT NULL,
      sort_order       INTEGER NOT NULL DEFAULT 100,
      status           TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','active','archived')),
      enabled          BOOLEAN NOT NULL DEFAULT true,
      is_core          BOOLEAN NOT NULL DEFAULT false,
      version          INTEGER NOT NULL DEFAULT 1,
      card_json        JSONB,
      draft_json       JSONB,
      run_count        INTEGER NOT NULL DEFAULT 0,
      last_run_at      TIMESTAMP,
      last_test_result TEXT,
      created_by       INTEGER,
      created_by_name  TEXT,
      updated_by       INTEGER,
      updated_by_name  TEXT,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Unique key — điều kiện sống của ON CONFLICT (scenario_key). KHÔNG nuốt lỗi.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lulu_scenarios_key ON lulu_sale_scenarios (scenario_key)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_lulu_scenarios_order ON lulu_sale_scenarios (sort_order, scenario_key)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_scenario_versions (
      id              SERIAL PRIMARY KEY,
      kind            TEXT NOT NULL DEFAULT 'apply' CHECK (kind IN ('apply','rollback')),
      note            TEXT,
      snapshot_json   JSONB NOT NULL,
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_lulu_scenario_versions_at ON lulu_scenario_versions (created_at DESC)`,
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lulu_scenario_test_runs (
      id              SERIAL PRIMARY KEY,
      scenario_key    TEXT,
      input_message   TEXT NOT NULL DEFAULT '',
      history_json    JSONB,
      state_before    JSONB,
      winner_key      TEXT,
      losers_json     JSONB,
      action          TEXT,
      forbidden_json  JSONB,
      knowledge_json  JSONB,
      reply_text      TEXT,
      validator_json  JSONB,
      verdict         TEXT,
      state_after     JSONB,
      created_by      INTEGER,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_lulu_scenario_test_runs_at
     ON lulu_scenario_test_runs (scenario_key, created_at DESC)`,
  ).catch(() => {});

  // Seed TRƯỚC khi đánh dấu ensured: seed lỗi giữa chừng → ensured vẫn false → lần gọi
  // sau tự thử lại (không bao giờ kẹt ở bộ thẻ thiếu một cách im lặng).
  await seedDefaultScenarios();
  ensured = true;
}

/** Seed thẻ mẫu — UPSERT-MISSING: chỉ chèn thẻ CHƯA CÓ theo scenario_key (ON CONFLICT DO
 *  NOTHING). Thẻ chủ đã sửa/tắt/lưu trữ giữ nguyên tuyệt đối; bản cập nhật hệ thống thêm
 *  thẻ mới sẽ tự xuất hiện. Transaction: đủ bộ hoặc không gì. */
async function seedDefaultScenarios(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let order = 10;
    let inserted = 0;
    for (const s of SEED_SCENARIOS) {
      const compiled = compileCard(s.card);
      const r = await client.query(
        `INSERT INTO lulu_sale_scenarios
           (scenario_key, sort_order, status, enabled, is_core, version, card_json, created_by_name)
         VALUES ($1, $2, 'active', true, $3, 1, $4::jsonb, 'Hệ thống')
         ON CONFLICT (scenario_key) DO NOTHING`,
        [s.key, order, s.isCore, JSON.stringify(compiled.card)],
      );
      inserted += r.rowCount ?? 0;
      order += 10;
    }
    await client.query("COMMIT");
    if (inserted > 0) console.log(`[ScenarioMgr] seed thêm ${inserted}/${SEED_SCENARIOS.length} thẻ kịch bản mẫu mới`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Map row ──────────────────────────────────────────────────────────────────

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function mapRow(r: Record<string, unknown>): ScenarioRecord {
  return {
    id: Number(r.id),
    scenarioKey: String(r.scenario_key),
    sortOrder: Number(r.sort_order ?? 100),
    status: (r.status as ScenarioRecord["status"]) ?? "draft",
    enabled: !!r.enabled,
    isCore: !!r.is_core,
    version: Number(r.version ?? 1),
    card: (r.card_json ?? null) as ScenarioCard,
    draftCard: (r.draft_json ?? null) as ScenarioCard | null,
    runCount: Number(r.run_count ?? 0),
    lastRunAt: iso(r.last_run_at),
    lastTestResult: (r.last_test_result as string) ?? null,
    createdByName: (r.created_by_name as string) ?? null,
    updatedByName: (r.updated_by_name as string) ?? null,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

// ─── Đọc ──────────────────────────────────────────────────────────────────────

export async function listScenarios(): Promise<ScenarioRecord[]> {
  await ensureScenarioTables();
  const r = await pool.query(`SELECT * FROM lulu_sale_scenarios ORDER BY sort_order ASC, scenario_key ASC`);
  return (r.rows as Array<Record<string, unknown>>).map(mapRow);
}

export async function getScenario(key: string): Promise<ScenarioRecord | null> {
  await ensureScenarioTables();
  const r = await pool.query(`SELECT * FROM lulu_sale_scenarios WHERE scenario_key = $1`, [key]);
  return r.rows.length ? mapRow(r.rows[0] as Record<string, unknown>) : null;
}

/**
 * ScenarioDef cho Resolver — bản ACTIVE + enabled. Trên luồng trả lời sống →
 * KHÔNG bao giờ throw (lỗi → [] = fail-open về Workflow V1).
 */
export async function loadActiveScenarioDefs(): Promise<ScenarioDef[]> {
  try {
    await ensureScenarioTables();
    const r = await pool.query(
      `SELECT scenario_key, sort_order, enabled, card_json FROM lulu_sale_scenarios
       WHERE status = 'active' AND card_json IS NOT NULL
       ORDER BY sort_order ASC, scenario_key ASC`,
    );
    return (r.rows as Array<{ scenario_key: string; sort_order: number; enabled: boolean; card_json: ScenarioCard }>)
      .map((row) => cardToDef(row.scenario_key, row.card_json, Number(row.sort_order), !!row.enabled));
  } catch (err) {
    console.error("[ScenarioMgr] loadActiveScenarioDefs lỗi (fail-open):", String(err).slice(0, 160));
    return [];
  }
}

/** Def cho TEST: bản active nhưng thẻ `key` dùng DRAFT nếu có (xem trước khi áp dụng). */
export async function loadDefsWithDraftOf(key: string | null): Promise<ScenarioDef[]> {
  const rows = await listScenarios();
  return rows
    .filter((r) => (r.status === "active" && r.card) || (r.scenarioKey === key && r.draftCard))
    .map((r) => {
      const useDraft = r.scenarioKey === key && r.draftCard;
      return cardToDef(r.scenarioKey, useDraft ? r.draftCard! : r.card, r.sortOrder, useDraft ? true : r.enabled);
    });
}

// ─── Ghi (draft-first: active không sửa trực tiếp) ────────────────────────────

export type Actor = { id: number | null; name: string | null };

export async function createScenario(
  key: string, card: ScenarioCard, actor: Actor,
): Promise<{ ok: true; record: ScenarioRecord } | { ok: false; error: string }> {
  await ensureScenarioTables();
  const safeKey = key.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 80);
  if (!safeKey) return { ok: false, error: "Khoá kịch bản không hợp lệ" };
  const maxR = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) AS n FROM lulu_sale_scenarios`);
  const order = Number(maxR.rows[0]?.n ?? 0) + 10;
  const r = await pool.query(
    `INSERT INTO lulu_sale_scenarios
       (scenario_key, sort_order, status, enabled, is_core, version, card_json, draft_json,
        created_by, created_by_name, updated_by, updated_by_name)
     VALUES ($1, $2, 'draft', false, false, 1, NULL, $3::jsonb, $4, $5, $4, $5)
     ON CONFLICT (scenario_key) DO NOTHING
     RETURNING *`,
    [safeKey, order, JSON.stringify(card), actor.id, actor.name],
  );
  if (!r.rows.length) return { ok: false, error: `Đã có kịch bản với khoá '${safeKey}' — chọn tên khác.` };
  return { ok: true, record: mapRow(r.rows[0] as Record<string, unknown>) };
}

/** Sửa thẻ = ghi vào draft_json (bản active giữ nguyên cho tới khi Apply). */
export async function saveDraft(key: string, card: ScenarioCard, actor: Actor): Promise<ScenarioRecord | null> {
  await ensureScenarioTables();
  const r = await pool.query(
    `UPDATE lulu_sale_scenarios
        SET draft_json = $2::jsonb, updated_by = $3, updated_by_name = $4, updated_at = NOW()
      WHERE scenario_key = $1 RETURNING *`,
    [key, JSON.stringify(card), actor.id, actor.name],
  );
  return r.rows.length ? mapRow(r.rows[0] as Record<string, unknown>) : null;
}

/** Hủy nháp (giữ bản active nguyên vẹn). Thẻ MỚI TẠO chưa từng Apply (card_json NULL)
 *  → xoá luôn dòng (giải phóng khoá, không để lại "thẻ ma" không card không draft;
 *  chưa từng chạy thật nên xoá là an toàn — khác thẻ active tuyệt đối không xoá). */
export async function discardDraft(key: string, actor: Actor): Promise<ScenarioRecord | null> {
  await ensureScenarioTables();
  const cur = await getScenario(key);
  if (!cur) return null;
  if (!cur.card) {
    await pool.query(`DELETE FROM lulu_sale_scenarios WHERE scenario_key = $1 AND card_json IS NULL`, [key]);
    return { ...cur, draftCard: null };
  }
  const r = await pool.query(
    `UPDATE lulu_sale_scenarios
        SET draft_json = NULL, updated_by = $2, updated_by_name = $3, updated_at = NOW()
      WHERE scenario_key = $1 RETURNING *`,
    [key, actor.id, actor.name],
  );
  return r.rows.length ? mapRow(r.rows[0] as Record<string, unknown>) : null;
}

export async function toggleScenario(key: string, enabled: boolean, actor: Actor): Promise<ScenarioRecord | null> {
  await ensureScenarioTables();
  const r = await pool.query(
    `UPDATE lulu_sale_scenarios
        SET enabled = $2, updated_by = $3, updated_by_name = $4, updated_at = NOW()
      WHERE scenario_key = $1 RETURNING *`,
    [key, enabled, actor.id, actor.name],
  );
  return r.rows.length ? mapRow(r.rows[0] as Record<string, unknown>) : null;
}

/** Kéo thả thứ tự ưu tiên: nhận danh sách key theo thứ tự mới.
 *  Danh sách gửi lên có thể THIẾU thẻ (bug client / gọi tay) → resequence TOÀN BỘ:
 *  key gửi lên đứng trước theo thứ tự gửi, thẻ còn lại giữ thứ tự hiện tại phía sau —
 *  không bao giờ để 2 thẻ trùng sort_order làm đảo ưu tiên ngoài ý muốn. */
export async function reorderScenarios(keysInOrder: string[], actor: Actor): Promise<number> {
  await ensureScenarioTables();
  const all = await listScenarios();
  const sent = keysInOrder.filter((k) => all.some((r) => r.scenarioKey === k));
  const rest = all.map((r) => r.scenarioKey).filter((k) => !sent.includes(k));
  const finalOrder = [...sent, ...rest];
  let n = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < finalOrder.length; i++) {
      const r = await client.query(
        `UPDATE lulu_sale_scenarios SET sort_order = $2, updated_by = $3, updated_by_name = $4, updated_at = NOW()
         WHERE scenario_key = $1`,
        [finalOrder[i], (i + 1) * 10, actor.id, actor.name],
      );
      n += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return n;
}

/** Nhân bản thẻ → thẻ mới dạng nháp (chưa bật). */
export async function cloneScenario(key: string, actor: Actor):
  Promise<{ ok: true; record: ScenarioRecord } | { ok: false; error: string }> {
  const src = await getScenario(key);
  if (!src) return { ok: false, error: "Không tìm thấy kịch bản để nhân bản" };
  const baseCard = src.draftCard ?? src.card;
  if (!baseCard) return { ok: false, error: "Kịch bản nguồn chưa có nội dung" };
  for (let i = 2; i <= 20; i++) {
    const newKey = `${key}-ban-${i}`;
    const exists = await getScenario(newKey);
    if (exists) continue;
    const card: ScenarioCard = { ...baseCard, name: `${baseCard.name} (bản ${i})` };
    return createScenario(newKey, card, actor);
  }
  return { ok: false, error: "Đã nhân bản quá nhiều lần — hãy xoá bớt bản nháp cũ." };
}

/** Lưu trữ thẻ (soft) — KHÔNG xoá vĩnh viễn; thẻ lõi không lưu trữ được.
 *  Chặn khi còn thẻ khác đang CHUYỂN TIẾP tới thẻ này (tránh tham chiếu chết
 *  làm kẹt mọi lần Áp dụng sau đó với lỗi khó hiểu ở thẻ khác). */
export async function archiveScenario(key: string, actor: Actor):
  Promise<{ ok: boolean; error?: string; record?: ScenarioRecord }> {
  const cur = await getScenario(key);
  if (!cur) return { ok: false, error: "Không tìm thấy kịch bản" };
  if (cur.isCore) return { ok: false, error: "Thẻ lõi an toàn — không lưu trữ được (chỉ tắt tạm bằng công tắc)." };
  const all = await listScenarios();
  const referers = all.filter((r) =>
    r.scenarioKey !== key && r.status !== "archived"
    && [...(r.card?.nextScenarios ?? []), ...(r.draftCard?.nextScenarios ?? [])].some((n) => n.scenarioKey === key),
  );
  if (referers.length > 0) {
    const names = referers.map((r) => `'${(r.draftCard ?? r.card)?.name ?? r.scenarioKey}'`).join(", ");
    return {
      ok: false,
      error: `Thẻ này đang được ${names} chuyển tiếp tới — gỡ dòng chuyển tiếp ở thẻ đó trước rồi mới lưu trữ (tránh chuyển tiếp bị đứt).`,
    };
  }
  const r = await pool.query(
    `UPDATE lulu_sale_scenarios
        SET status = 'archived', enabled = false, draft_json = NULL,
            updated_by = $2, updated_by_name = $3, updated_at = NOW()
      WHERE scenario_key = $1 RETURNING *`,
    [key, actor.id, actor.name],
  );
  return { ok: true, record: mapRow(r.rows[0] as Record<string, unknown>) };
}

// ─── Apply / Rollback theo NGUYÊN BỘ (ensemble snapshot) ──────────────────────

type SnapshotEntry = {
  scenario_key: string; sort_order: number; status: string; enabled: boolean;
  is_core: boolean; version: number; card: ScenarioCard | null;
  /** Nháp đang sửa dở tại thời điểm snapshot — để rollback không làm mất công sửa của ai. */
  draft?: ScenarioCard | null;
};

async function buildSnapshot(): Promise<SnapshotEntry[]> {
  const rows = await listScenarios();
  return rows.map((r) => ({
    scenario_key: r.scenarioKey, sort_order: r.sortOrder, status: r.status,
    enabled: r.enabled, is_core: r.isCore, version: r.version, card: r.card,
    draft: r.draftCard,
  }));
}

/**
 * ÁP DỤNG: validate từng nháp + cả bộ → snapshot bộ ACTIVE hiện tại → promote mọi draft.
 * Trả lỗi VN chi tiết nếu có thẻ vi phạm (không áp dụng gì cả — all-or-nothing).
 */
export async function applyAllDrafts(actor: Actor, note?: string): Promise<
  | { ok: true; applied: string[]; versionId: number }
  | { ok: false; error: string; issues?: EnsembleIssue[] }
> {
  await ensureScenarioTables();
  const rows = await listScenarios();
  const drafts = rows.filter((r) => r.draftCard != null && r.status !== "archived");
  if (drafts.length === 0) return { ok: false, error: "Không có bản nháp nào để áp dụng." };

  // 1. Validate từng thẻ nháp.
  const issues: EnsembleIssue[] = [];
  const compiledDrafts = new Map<string, ScenarioCard>();
  for (const d of drafts) {
    const c = compileCard(d.draftCard);
    if (!c.ok) for (const e of c.errors) issues.push({ ...e, scenarioKey: d.scenarioKey });
    compiledDrafts.set(d.scenarioKey, c.card);
  }
  // 2. Validate CẢ BỘ sau khi áp (active hiện tại + nháp promote).
  const after = rows
    .filter((r) => r.status !== "archived")
    .map((r) => ({ key: r.scenarioKey, card: compiledDrafts.get(r.scenarioKey) ?? r.card }))
    .filter((x): x is { key: string; card: ScenarioCard } => x.card != null);
  const ens = validateEnsemble(after);
  issues.push(...ens.errors);
  if (issues.length > 0) {
    return { ok: false, error: "Có thẻ chưa hợp lệ — chưa áp dụng gì cả. Sửa theo gợi ý rồi áp dụng lại.", issues };
  }

  // 3. Snapshot bộ hiện tại (để rollback) rồi promote trong 1 transaction.
  const snapshot = await buildSnapshot();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snap = await client.query(
      `INSERT INTO lulu_scenario_versions (kind, note, snapshot_json, created_by, created_by_name)
       VALUES ('apply', $1, $2::jsonb, $3, $4) RETURNING id`,
      [(note ?? "").slice(0, 500) || `Áp dụng ${drafts.length} thẻ nháp`, JSON.stringify(snapshot), actor.id, actor.name],
    );
    for (const d of drafts) {
      // Guard "WHERE draft_json IS NOT NULL": nếu ai đó vừa HỦY nháp giữa lúc admin đọc
      // và COMMIT thì không promote bản đã hủy (giảm cửa sổ mất-cập-nhật TOCTOU).
      await client.query(
        `UPDATE lulu_sale_scenarios
            SET card_json = $2::jsonb, draft_json = NULL, status = 'active',
                version = version + 1, updated_by = $3, updated_by_name = $4, updated_at = NOW()
          WHERE scenario_key = $1 AND draft_json IS NOT NULL`,
        [d.scenarioKey, JSON.stringify(compiledDrafts.get(d.scenarioKey)), actor.id, actor.name],
      );
    }
    await client.query("COMMIT");
    console.log(`[ScenarioMgr] apply ${drafts.length} thẻ, snapshotId=${snap.rows[0].id} bởi ${actor.name ?? actor.id}`);
    return { ok: true, applied: drafts.map((d) => d.scenarioKey), versionId: Number(snap.rows[0].id) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, error: `Áp dụng lỗi: ${String(err).slice(0, 200)}` };
  } finally {
    client.release();
  }
}

export async function listVersions(limit = 50): Promise<Array<{
  id: number; kind: string; note: string | null; count: number;
  createdByName: string | null; createdAt: string;
}>> {
  await ensureScenarioTables();
  const r = await pool.query(
    `SELECT id, kind, note, jsonb_array_length(snapshot_json) AS count, created_by_name, created_at
     FROM lulu_scenario_versions ORDER BY id DESC LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id), kind: String(row.kind), note: (row.note as string) ?? null,
    count: Number(row.count ?? 0), createdByName: (row.created_by_name as string) ?? null,
    createdAt: iso(row.created_at) ?? "",
  }));
}

/**
 * ROLLBACK: khôi phục NGUYÊN BỘ về snapshot đã lưu. Trước khi khôi phục,
 * chụp lại bộ hiện tại (kind='rollback') để rollback của rollback vẫn được.
 */
export async function rollbackToVersion(versionId: number, actor: Actor):
  Promise<{ ok: boolean; error?: string; restored?: number }> {
  await ensureScenarioTables();
  const v = await pool.query(`SELECT snapshot_json FROM lulu_scenario_versions WHERE id = $1`, [versionId]);
  if (!v.rows.length) return { ok: false, error: "Không tìm thấy bản snapshot" };
  const snapshot = v.rows[0].snapshot_json as SnapshotEntry[];
  if (!Array.isArray(snapshot)) return { ok: false, error: "Snapshot hỏng — không khôi phục được" };

  const current = await buildSnapshot();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO lulu_scenario_versions (kind, note, snapshot_json, created_by, created_by_name)
       VALUES ('rollback', $1, $2::jsonb, $3, $4)`,
      [`Trước khi khôi phục về snapshot #${versionId}`, JSON.stringify(current), actor.id, actor.name],
    );
    let restored = 0;
    for (const s of snapshot) {
      // QUAN TRỌNG: rollback khôi phục BẢN CHẠY THẬT (card/status/enabled/thứ tự).
      // draft_json: GIỮ nháp hiện tại nếu đang có (không nuốt công sửa dở của ai);
      // nếu hiện KHÔNG có nháp thì khôi phục nháp từ snapshot — tránh "thẻ ma"
      // (thẻ draft-only được Apply rồi Rollback: card về NULL mà draft cũng NULL).
      const r = await client.query(
        `INSERT INTO lulu_sale_scenarios
           (scenario_key, sort_order, status, enabled, is_core, version, card_json, draft_json,
            updated_by, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         ON CONFLICT (scenario_key) DO UPDATE SET
           sort_order = EXCLUDED.sort_order, status = EXCLUDED.status,
           enabled = EXCLUDED.enabled, version = EXCLUDED.version,
           card_json = EXCLUDED.card_json,
           draft_json = COALESCE(lulu_sale_scenarios.draft_json, EXCLUDED.draft_json),
           updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name,
           updated_at = NOW()`,
        [s.scenario_key, s.sort_order, s.status, s.enabled, s.is_core, s.version,
         s.card != null ? JSON.stringify(s.card) : null,
         s.draft != null ? JSON.stringify(s.draft) : null,
         actor.id, actor.name],
      );
      restored += r.rowCount ?? 0;
    }
    // Thẻ tạo SAU snapshot (không có trong snapshot) → tắt + hạ về draft (không xoá — giữ lịch sử).
    const snapKeys = snapshot.map((s) => s.scenario_key);
    await client.query(
      `UPDATE lulu_sale_scenarios SET enabled = false, status = 'draft', updated_at = NOW()
       WHERE NOT (scenario_key = ANY($1::text[])) AND status = 'active'`,
      [snapKeys],
    );
    await client.query("COMMIT");
    console.log(`[ScenarioMgr] rollback về snapshot #${versionId}, restored=${restored} bởi ${actor.name ?? actor.id}`);
    return { ok: true, restored };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, error: `Khôi phục lỗi: ${String(err).slice(0, 200)}` };
  } finally {
    client.release();
  }
}

// ─── Ghi kết quả test ─────────────────────────────────────────────────────────

export async function recordTestRun(input: {
  scenarioKey: string | null; inputMessage: string; history: unknown;
  stateBefore: unknown; winnerKey: string | null; losers: unknown; action: string | null;
  forbidden: unknown; knowledge: unknown; replyText: string | null; validator: unknown;
  verdict: string | null; stateAfter: unknown; createdBy: number | null;
}): Promise<void> {
  try {
    await ensureScenarioTables();
    await pool.query(
      `INSERT INTO lulu_scenario_test_runs
         (scenario_key, input_message, history_json, state_before, winner_key, losers_json,
          action, forbidden_json, knowledge_json, reply_text, validator_json, verdict, state_after, created_by)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13::jsonb,$14)`,
      [input.scenarioKey, input.inputMessage.slice(0, 2000), JSON.stringify(input.history ?? []),
       JSON.stringify(input.stateBefore ?? {}), input.winnerKey, JSON.stringify(input.losers ?? []),
       input.action, JSON.stringify(input.forbidden ?? []), JSON.stringify(input.knowledge ?? []),
       input.replyText, JSON.stringify(input.validator ?? {}), input.verdict,
       JSON.stringify(input.stateAfter ?? {}), input.createdBy],
    );
    if (input.scenarioKey) {
      await pool.query(
        `UPDATE lulu_sale_scenarios
            SET run_count = run_count + 1, last_run_at = NOW(), last_test_result = $2
          WHERE scenario_key = $1`,
        [input.scenarioKey, input.verdict],
      );
    }
  } catch (err) {
    console.error("[ScenarioMgr] recordTestRun lỗi (bỏ qua):", String(err).slice(0, 120));
  }
}
