#!/usr/bin/env node
/**
 * seed-preview-db.mjs — dựng DATABASE PREVIEW từ một bản sao dữ liệu, rồi CHE
 * TOÀN BỘ danh tính khách hàng và XOÁ SẠCH secret nằm trong database.
 *
 * Chạy TAY trên máy chủ studio, KHÔNG bao giờ chạy trong CI/CD.
 *
 *   node scripts/seed-preview-db.mjs --source-local --yes
 *   node scripts/seed-preview-db.mjs --source-dump="D:\\...\\database_production_latest.dump" --yes
 *
 * Cấu hình đọc từ `.env.preview` ở gốc repo (file này ĐÃ nằm trong .gitignore —
 * tuyệt đối không commit):
 *
 *   PREVIEW_DATABASE_URL=postgresql://...@ep-xxx.aws.neon.tech/amazing_preview?sslmode=require
 *   PREVIEW_DB_HOST_ALLOWLIST=ep-xxx.aws.neon.tech/amazing_preview
 *   SOURCE_DATABASE_URL=postgresql://postgres:...@localhost:5432/amazing_studio   (khi dùng --source-local)
 *
 * ─── CHỐT AN TOÀN ────────────────────────────────────────────────────────────
 *  • Đích PHẢI khớp PREVIEW_DB_HOST_ALLOWLIST (cùng luật với artifacts/api-server/
 *    src/lib/preview-guard.ts) → không thể lỡ tay ghi đè database production.
 *  • Script chỉ GHI vào đích. Nguồn chỉ được ĐỌC (pg_dump).
 *  • Kết thúc bằng bước KIỂM CHỨNG: quét lại toàn bộ cột chữ, còn sót số điện
 *    thoại/email thật → EXIT 1 và KHÔNG đánh dấu database là preview.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `pg` là phụ thuộc của lib/db, `bcryptjs` của api-server — mượn lại node_modules
// của hai gói đó để script không phải thêm dependency mới (không đụng lockfile).
const requireFromDb = createRequire(pathToFileURL(path.join(REPO_ROOT, "lib", "db", "package.json")));
const requireFromApi = createRequire(
  pathToFileURL(path.join(REPO_ROOT, "artifacts", "api-server", "package.json")),
);
const { Client } = requireFromDb("pg");
const bcrypt = requireFromApi("bcryptjs");

// ─────────────────────────────────────────────────────────────────────────────
// Tham số + cấu hình
// ─────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

function loadEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(REPO_ROOT, ".env.preview"));
const cfg = { ...fileEnv, ...process.env };

const TARGET_URL = cfg.PREVIEW_DATABASE_URL;
const ALLOWLIST_RAW = cfg.PREVIEW_DB_HOST_ALLOWLIST;
const SOURCE_URL = value("source-url") || cfg.SOURCE_DATABASE_URL;
const SOURCE_DUMP = value("source-dump");
const PG_BIN =
  value("pg-bin") ||
  cfg.PG_BIN ||
  ["C:\\Program Files\\PostgreSQL\\17\\bin", "C:\\Program Files\\PostgreSQL\\16\\bin"].find((d) =>
    existsSync(d),
  ) ||
  "";

const log = (...m) => console.log(...m);
const fail = (msg) => {
  console.error(`\n\x1b[41m\x1b[97m  DỪNG  \x1b[0m\n\x1b[31m${msg}\x1b[0m\n`);
  process.exit(1);
};

// ─────────────────────────────────────────────────────────────────────────────
// Chốt an toàn: đích phải là database preview
// (Giữ ĐỒNG BỘ với artifacts/api-server/src/lib/preview-guard.ts — không wildcard.)
// ─────────────────────────────────────────────────────────────────────────────
function parseDbUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname.toLowerCase(),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase(),
  };
}

function assertTargetIsPreview() {
  if (!TARGET_URL) fail("Thiếu PREVIEW_DATABASE_URL (đặt trong .env.preview ở gốc repo).");
  if (!ALLOWLIST_RAW) fail("Thiếu PREVIEW_DB_HOST_ALLOWLIST — fail-closed, không chạy.");

  const target = parseDbUrl(TARGET_URL);
  const allow = ALLOWLIST_RAW.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => {
      const [host, database] = item.split("/", 2);
      return { host, database: database || null };
    });

  const ok = allow.some(
    (e) => e.host === target.host && (e.database === null || e.database === target.database),
  );
  if (!ok) {
    fail(
      `PREVIEW_DATABASE_URL trỏ tới '${target.host}/${target.database}' — KHÔNG nằm trong ` +
        "PREVIEW_DB_HOST_ALLOWLIST. Từ chối chạy để không có nguy cơ ghi nhầm vào database production.",
    );
  }
  if (SOURCE_URL) {
    const src = parseDbUrl(SOURCE_URL);
    if (src.host === target.host && src.database === target.database) {
      fail("Nguồn và đích là CÙNG một database. Từ chối chạy.");
    }
  }
  return target;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nạp dữ liệu vào database preview
// ─────────────────────────────────────────────────────────────────────────────
function pgTool(name) {
  const exe = PG_BIN ? path.join(PG_BIN, name) : name;
  return exe;
}

function run(cmd, cmdArgs, opts = {}) {
  log(`\n$ ${path.basename(cmd)} ${cmdArgs.filter((a) => !a.startsWith("postgres")).join(" ")}`);
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  if (res.error) fail(`Không chạy được '${cmd}': ${res.error.message}`);
  if (res.status !== 0) fail(`'${path.basename(cmd)}' kết thúc với mã lỗi ${res.status}.`);
}

function restoreInto(targetUrl) {
  let dumpFile = SOURCE_DUMP;
  let tmpDir = null;

  if (!dumpFile) {
    if (!SOURCE_URL) {
      fail("Cần --source-dump=<file> hoặc SOURCE_DATABASE_URL (kèm --source-local).");
    }
    tmpDir = mkdtempSync(path.join(tmpdir(), "amazing-preview-"));
    dumpFile = path.join(tmpDir, "source.dump");
    log("\n[1/6] Kết xuất dữ liệu từ database nguồn (CHỈ ĐỌC)…");
    run(pgTool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpFile, SOURCE_URL]);
  } else {
    if (!existsSync(dumpFile)) fail(`Không thấy file dump: ${dumpFile}`);
    log(`\n[1/6] Dùng file dump có sẵn: ${dumpFile}`);
  }

  log("\n[2/6] Nạp vào database PREVIEW (xoá sạch dữ liệu cũ của preview trước)…");
  // pg_restore trả mã khác 0 cho các cảnh báo vô hại (extension, owner) → dùng
  // --exit-on-error=false và tự kiểm tra bằng bước xác minh phía dưới.
  const res = spawnSync(
    pgTool("pg_restore"),
    ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--dbname", targetUrl, dumpFile],
    { stdio: "inherit" },
  );
  if (res.error) fail(`Không chạy được pg_restore: ${res.error.message}`);
  if (res.status !== 0) {
    log(
      `\n\x1b[33m[cảnh báo] pg_restore kết thúc với mã ${res.status} — thường là do lệnh DROP trên ` +
        "database rỗng hoặc quyền owner. Sẽ kiểm tra lại bằng bước xác minh cuối.\x1b[0m",
    );
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Kế hoạch che dữ liệu
// ─────────────────────────────────────────────────────────────────────────────
/** Xoá số điện thoại/email lẫn trong văn bản tự do, giữ nguyên phần còn lại. */
const scrub = (col) =>
  `CASE WHEN ${col} IS NULL THEN NULL ELSE regexp_replace(regexp_replace(${col}, ` +
  `'(\\+?84|0)[0-9]{8,10}', '[SĐT đã ẩn]', 'g'), ` +
  `'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', '[email đã ẩn]', 'g') END`;

/**
 * `{ID}` = khoá phân biệt từng dòng. Bảng có cột `id` thì dùng luôn; bảng không
 * có (ví dụ ai_follow_up_logs) thì băm `ctid` ra số — cốt để giá trị che không
 * trùng nhau, đủ cho ràng buộc UNIQUE.
 */
const ROW_KEY_FALLBACK = `abs(('x' || substr(md5(ctid::text), 1, 8))::bit(32)::bigint)`;

/** SĐT giả: bắt đầu bằng 0000 → KHÔNG trùng dạng số Việt Nam thật (03/05/07/08/09). */
const fakePhone = `'0000' || lpad((({ID}) % 1000000)::text, 6, '0')`;
const HIDDEN_TEXT = `'[Nội dung đã ẩn cho bản xem thử]'`;

/** Mỗi mục: bảng → { cột: biểu thức SQL }. Bảng/cột không tồn tại sẽ được bỏ qua. */
const MASK_PLAN = {
  customers: {
    name: `'Khách ' || {ID}`,
    phone: fakePhone,
    email: `NULL`,
    address: `NULL`,
    facebook: `NULL`,
    facebook_user_id: `'fb_an_danh_' || {ID}`,
    zalo: `NULL`,
    notes: scrub("notes"),
  },
  crm_leads: {
    name: `'Khách tiềm năng ' || {ID}`,
    phone: fakePhone,
    zalo: `NULL`,
    facebook_user_id: `'fb_an_danh_' || {ID}`,
    message: HIDDEN_TEXT,
    last_message: HIDDEN_TEXT,
    notes: scrub("notes"),
  },
  quotes: { customer_name: `'Khách ' || {ID}`, phone: fakePhone, notes: scrub("notes") },
  photoshop_jobs: {
    customer_name: `'Khách ' || {ID}`,
    customer_phone: fakePhone,
    notes: scrub("notes"),
    photoshop_note: scrub("photoshop_note"),
    print_notes: scrub("print_notes"),
  },
  contracts: {
    signer_name: `'Khách ' || {ID}`,
    signer_phone: fakePhone,
    signature_image_url: `NULL`,
    notes: scrub("notes"),
  },
  payments: { payer_name: `'Khách ' || {ID}`, payer_phone: fakePhone, notes: scrub("notes") },
  bookings: { notes: scrub("notes"), internal_notes: scrub("internal_notes") },
  rentals: { notes: scrub("notes") },
  gallery_albums: { name: `'Album ' || {ID}` },
  // ── Hội thoại với khách: xoá hẳn nội dung ─────────────────────────────────
  fb_inbox_messages: { facebook_user_id: `'fb_an_danh_' || {ID}`, message: HIDDEN_TEXT },
  ai_test_sessions: {
    customer_name: `'Khách ' || {ID}`,
    name: `'Phiên thử ' || {ID}`,
    last_message_preview: HIDDEN_TEXT,
  },
  ai_follow_up_logs: { psid: `'psid_an_danh_' || {ID}` },
  ai_unknown_questions: { psid: `'psid_an_danh_' || {ID}` },
  claude_sale_lead_flags: { facebook_user_id: `'fb_an_danh_' || {ID}` },
  lulu_thread_state: { facebook_user_id: `'fb_an_danh_' || {ID}` },
  lulu_human_reviews: {
    facebook_user_id: `'fb_an_danh_' || {ID}`,
    customer_name: `'Khách ' || {ID}`,
    customer_question: HIDDEN_TEXT,
  },
  lulu_unknown_questions: { customer_text: HIDDEN_TEXT },
  lulu_brain_test_cases: { customer_message: HIDDEN_TEXT },
  lulu_brain_change_requests: { example_customer_message: HIDDEN_TEXT },
  lulu_scenario_test_runs: { input_message: HIDDEN_TEXT },
  lulu_sale_script_examples: { customer_text: HIDDEN_TEXT },
  internal_messages: { content: HIDDEN_TEXT },
  // ── Thiệp cưới: tên cô dâu chú rể + khách mời ─────────────────────────────
  wedding_cards: {
    bride_name: `'Cô dâu ' || {ID}`,
    groom_name: `'Chú rể ' || {ID}`,
    contact_phone: fakePhone,
    invitation_message: HIDDEN_TEXT,
  },
  wedding_card_guest_entries: { guest_name: `'Khách mời ' || {ID}`, message: HIDDEN_TEXT },
  wedding_guest_entries: { guest_name: `'Khách mời ' || {ID}`, message: HIDDEN_TEXT },
  // ── Nhân viên: GIỮ TÊN (để còn review được lịch/phân công), che liên lạc ───
  staff: { phone: fakePhone, email: `NULL`, notes: scrub("notes") },
  staff_internal_notes: { general_notes: scrub("general_notes"), work_notes: scrub("work_notes") },
  expenses: { bank_account: `NULL`, bank_name: `NULL`, notes: scrub("notes") },
};

/** Secret nằm trong DB — token Facebook/OpenAI đọc từ đây, env chỉ là fallback. */
const SECRET_KEY_PATTERN = "(token|api_key|secret|password|refresh|client_id|mcp:oauth)";

async function maskDatabase(client, previewPassword) {
  log("\n[3/6] Che danh tính khách hàng…");

  const { rows: cols } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`,
  );
  const has = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
  const tables = new Set(cols.map((c) => c.table_name));

  let touched = 0;
  const skipped = [];
  for (const [table, plan] of Object.entries(MASK_PLAN)) {
    if (!tables.has(table)) {
      skipped.push(table);
      continue;
    }
    const rowKey = has.has(`${table}.id`) ? "id" : ROW_KEY_FALLBACK;
    const sets = Object.entries(plan)
      .filter(([col]) => has.has(`${table}.${col}`))
      .map(([col, expr]) => `${col} = ${expr.replaceAll("{ID}", rowKey)}`);
    if (sets.length === 0) continue;
    const res = await client.query(`UPDATE ${table} SET ${sets.join(", ")}`);
    touched += res.rowCount ?? 0;
    log(`  • ${table}: ${res.rowCount} dòng (${sets.length} cột)`);
  }
  if (skipped.length) log(`  (bỏ qua bảng không có trong DB này: ${skipped.join(", ")})`);

  // ── Quét toàn bộ cột chữ còn lại: xoá SĐT/email lẫn trong văn bản tự do ────
  log("\n[4/6] Quét mọi cột chữ còn lại để xoá SĐT/email lẫn trong nội dung…");
  const { rows: textCols } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND data_type IN ('text','character varying')
        AND is_generated = 'NEVER'
        AND table_name NOT LIKE 'pg_%'`,
  );
  let scrubbed = 0;
  for (const { table_name: t, column_name: c } of textCols) {
    const planned = MASK_PLAN[t]?.[c];
    if (planned && planned !== scrub(c)) continue; // đã xử lý ở bước trên
    const res = await client.query(
      `UPDATE ${t} SET ${c} = ${scrub(c)}
        WHERE ${c} ~ '(\\+?84|0)[0-9]{8,10}'
           OR ${c} ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'`,
    );
    if (res.rowCount) {
      scrubbed += res.rowCount;
      log(`  • ${t}.${c}: ${res.rowCount} dòng`);
    }
  }
  log(`  → tổng ${scrubbed} dòng được làm sạch.`);

  // ── Xoá secret trong DB + tắt mọi thứ có thể gửi ra ngoài ──────────────────
  log("\n[5/6] Xoá secret trong database + tắt kênh gửi ra ngoài…");
  for (const table of ["settings", "app_settings"]) {
    if (!tables.has(table)) continue;
    const res = await client.query(
      `DELETE FROM ${table} WHERE key ~* $1`,
      [SECRET_KEY_PATTERN],
    );
    log(`  • ${table}: xoá ${res.rowCount} dòng chứa token/key`);
  }
  if (tables.has("push_subscriptions")) {
    const res = await client.query(`DELETE FROM push_subscriptions`);
    log(`  • push_subscriptions: xoá ${res.rowCount} thiết bị (không đẩy nhầm push ra máy thật)`);
  }
  if (has.has("autopost_settings.config")) {
    await client.query(
      `UPDATE autopost_settings SET config = jsonb_set(COALESCE(config,'{}'::jsonb), '{dryRun}', 'true'::jsonb)`,
    );
    log("  • autopost_settings: ép dryRun = true");
  }
  for (const t of ["autopost_posts", "autopost_batches"]) {
    if (!tables.has(t)) continue;
    // Không để hàng chờ đăng bài nào ở trạng thái sẵn sàng bắn lên Facebook.
    if (has.has(`${t}.status`)) {
      const res = await client.query(
        `UPDATE ${t} SET status = 'cancelled' WHERE status IN ('pending','scheduled','approved','pending_review')`,
      );
      if (res.rowCount) log(`  • ${t}: huỷ ${res.rowCount} mục đang chờ đăng`);
    }
  }

  // ── Đặt lại mật khẩu đăng nhập cho bản preview ────────────────────────────
  if (has.has("staff.password_hash")) {
    const hash = await bcrypt.hash(previewPassword, 10);
    const res = await client.query(`UPDATE staff SET password_hash = $1`, [hash]);
    log(`  • staff: đặt lại mật khẩu cho ${res.rowCount} tài khoản (mật khẩu prod KHÔNG dùng trên preview)`);
  }

  return touched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kiểm chứng: không còn số/email thật
// ─────────────────────────────────────────────────────────────────────────────
const REAL_PHONE_RE = `(\\+84|84|0[3-9])[0-9]{8}`;
const REAL_EMAIL_RE = `[A-Za-z0-9._%+-]+@(?!example\\.invalid)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}`;

async function verifyClean(client) {
  log("\n[6/6] Kiểm chứng lần cuối…");
  const { rows: textCols } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND data_type IN ('text','character varying')
        AND is_generated = 'NEVER'`,
  );
  const offenders = [];
  for (const { table_name: t, column_name: c } of textCols) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE ${c} ~ $1 OR ${c} ~ $2`,
      [REAL_PHONE_RE, REAL_EMAIL_RE],
    );
    if (rows[0].n > 0) offenders.push(`${t}.${c} (${rows[0].n} dòng)`);
  }
  if (offenders.length) {
    console.error("\n\x1b[41m\x1b[97m  CÒN SÓT DỮ LIỆU THẬT — KHÔNG ĐÁNH DẤU LÀ PREVIEW  \x1b[0m");
    for (const o of offenders) console.error(`  ✗ ${o}`);
    console.error(
      "\nSửa MASK_PLAN trong scripts/seed-preview-db.mjs cho các cột trên rồi chạy lại.\n",
    );
    process.exit(1);
  }
  log("  ✓ Không còn số điện thoại/email dạng thật trong bất kỳ cột chữ nào.");
}

async function stampMarker(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS preview_db_marker (
      id integer PRIMARY KEY,
      is_preview boolean NOT NULL DEFAULT true,
      seeded_at timestamptz NOT NULL DEFAULT now(),
      note text
    )`);
  await client.query(`DELETE FROM preview_db_marker`);
  await client.query(
    `INSERT INTO preview_db_marker (id, is_preview, seeded_at, note) VALUES (1, true, now(), $1)`,
    ["Database dùng riêng cho bản xem thử theo PR. Dữ liệu đã che danh tính khách."],
  );
  log("  ✓ Đã đánh dấu database này là PREVIEW (bảng preview_db_marker).");
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const target = assertTargetIsPreview();

  if (!flag("yes")) {
    fail(
      `Sẽ GHI ĐÈ toàn bộ database preview '${target.host}/${target.database}'.\n` +
        "Thêm --yes để xác nhận.",
    );
  }

  const previewPassword = value("preview-password") || `xemthu-${Math.floor(Math.random() * 1e6)}`;

  log(`\n╭─ DỰNG DATABASE PREVIEW ─────────────────────────────────────────────`);
  log(`│ Đích  : ${target.host}/${target.database}`);
  log(`│ Nguồn : ${SOURCE_DUMP ? path.basename(SOURCE_DUMP) : "database nguồn qua pg_dump"}`);
  log(`╰──────────────────────────────────────────────────────────────────────`);

  restoreInto(TARGET_URL);

  const client = new Client({ connectionString: TARGET_URL });
  await client.connect();
  try {
    await maskDatabase(client, previewPassword);
    await verifyClean(client);
    await stampMarker(client);
  } finally {
    await client.end();
  }

  log(`\n\x1b[42m\x1b[30m  XONG — DATABASE PREVIEW ĐÃ SẴN SÀNG  \x1b[0m`);
  log(`\nĐăng nhập trong bản xem thử:`);
  log(`  • Tên đăng nhập : như thật (ví dụ 'tranchi'), SĐT đã bị đổi thành số giả 0000…`);
  log(`  • Mật khẩu      : \x1b[1m${previewPassword}\x1b[0m   ← dùng cho MỌI tài khoản trên preview`);
  log(`\nGhi lại mật khẩu này. Chạy lại script sẽ sinh mật khẩu mới (hoặc dùng --preview-password=...).\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
