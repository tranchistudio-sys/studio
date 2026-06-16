#!/usr/bin/env node
/**
 * Task #367: Bảo vệ Doanh thu khỏi lỗi hàm trùng tên trong tương lai.
 *
 * Lý do tồn tại: Khi 1 file .ts có 2 khai báo `function foo()` ở top-level,
 * esbuild bundle vẫn chạy thành công (chỉ giữ bản cuối) → bug im lặng.
 * Đây là root cause của Task #366 — `revenue.ts` từng có 2 `getBookingDate`
 * và 2 `getPaymentDate`, khiến endpoint /api/revenue/by-sale dùng nhầm
 * phiên bản không lọc theo from/to.
 *
 * Script này scan toàn bộ src/**.ts, phát hiện các khai báo trùng tên
 * (function/const/let/var/class) ở top-level và fail build nếu có.
 * Chỉ fail trên file thuộc dự án (không scan node_modules/dist).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "src");

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      files.push(...(await walk(full)));
    } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

// Match top-level (no leading whitespace) declarations:
//   function NAME(
//   async function NAME(
//   export function NAME(
//   export async function NAME(
//   const NAME =
//   let NAME =
//   var NAME =
//   class NAME
//   export const NAME =   etc.
const DECL_RE = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

function findDuplicates(source) {
  const seen = new Map(); // name -> [lineNumbers]
  const lines = source.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip block comments (very rough; only handles whole-line cases — fine for scanning)
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1 && line.indexOf("*/", blockStart) === -1) {
      line = line.slice(0, blockStart);
      inBlockComment = true;
    }
    if (!line || line.startsWith(" ") || line.startsWith("\t")) continue;
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("//")) continue;
    const m = DECL_RE.exec(trimmed);
    if (!m) continue;
    const name = m[1];
    const arr = seen.get(name) ?? [];
    arr.push(i + 1);
    seen.set(name, arr);
  }
  const dups = [];
  for (const [name, ls] of seen) {
    if (ls.length > 1) dups.push({ name, lines: ls });
  }
  return dups;
}

async function main() {
  const files = await walk(srcDir);
  const offenders = [];
  for (const f of files) {
    const src = await fs.readFile(f, "utf8");
    const dups = findDuplicates(src);
    if (dups.length > 0) offenders.push({ file: f, dups });
  }
  if (offenders.length === 0) {
    return;
  }
  console.error("\n\x1b[41m\x1b[97m  BUILD GUARD: duplicate top-level declarations detected  \x1b[0m\n");
  console.error("Các khai báo trùng tên ở top-level sẽ bị esbuild bundle im lặng (giữ bản cuối)");
  console.error("→ tham khảo Task #366/#367. Hãy đổi tên hoặc gộp:\n");
  for (const o of offenders) {
    const rel = path.relative(path.resolve(here, ".."), o.file);
    console.error(`  ${rel}`);
    for (const d of o.dups) {
      console.error(`    - "${d.name}" tại các dòng: ${d.lines.join(", ")}`);
    }
  }
  console.error("");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
