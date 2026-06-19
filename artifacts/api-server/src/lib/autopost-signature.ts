import { pool } from "@workspace/db";

/**
 * autopost-signature.ts — CHỮ KÝ TIỆM (signature cuối bài) của Amazing Studio.
 *
 * Khác footer cũ (autopost-brand.ts — lưu trong autopost_settings.config): đây là
 * BẢNG RIÊNG `autopost_signatures` cho admin tự quản (nhiều mẫu, chọn 1 mặc định).
 *
 * NGUYÊN TẮC:
 *  - AI CHỈ viết phần nội dung. Chữ ký do HỆ THỐNG gắn vào cuối SAU khi sanitize —
 *    AI không được sửa/chế lại số điện thoại, website, địa chỉ.
 *  - KHÔNG hardcode chữ ký lúc gắn: luôn đọc từ bảng (getDefaultSignatureContent).
 *    Hằng DEFAULT_SIGNATURE_CONTENT bên dưới CHỈ dùng để SEED lần đầu.
 *  - Chống gắn trùng: trước khi gắn, gỡ mọi chữ ký cũ ở cuối → chỉ còn 1 chữ ký.
 *  - Giữ NGUYÊN Unicode/xuống dòng/ký tự đặc biệt.
 *  - Mọi hàm KHÔNG throw (lỗi DB → trả an toàn, caption vẫn đăng bình thường).
 */

export type Signature = {
  id: number;
  name: string;
  content: string;
  isActive: boolean;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
};

// Tên + nội dung chữ ký mặc định MỚI NHẤT (chỉ dùng để seed lần đầu khi bảng rỗng).
export const DEFAULT_SIGNATURE_NAME = "Amazing Studio (mặc định)";
export const DEFAULT_SIGNATURE_CONTENT = `━━━━━━━━━━━━━━━━━━
𝐀𝐌𝐀𝐙𝐈𝐍𝐆 𝐒𝐓𝐔𝐃𝐈𝐎
𝐏𝐇𝐎𝐓𝐎  •  𝐁𝐑𝐈𝐃𝐀𝐋  •  𝐌𝐀𝐊𝐄 𝐔𝐏

Đ𝙤̂̀ 𝙘𝙪̛𝙤̛́𝙞 - 𝙖́𝙤 𝙙𝙖̀𝙞 - 𝙫𝙞𝙚̣̂𝙩 𝙥𝙝𝙪̣𝙘 - 𝙗𝙚𝙖𝙪𝙩𝙮
𝙎𝙤̂́ 𝟾𝟶, 𝙃𝙚̉𝙢 𝟽𝟷, Đ𝙪̛𝙤̛̀𝙣𝙜 𝘾𝙈𝙏𝟾, 𝙆𝙋. 𝙃𝙞𝙚̣̂𝙥 𝘽𝙞̀𝙣𝙝, 𝙋. 𝙃𝙞𝙚̣̂𝙥 𝙉𝙞𝙣𝙝, 𝙏𝙋. 𝙏𝙖̂𝙮 𝙉𝙞𝙣𝙝
𝚆𝚎𝚋𝚜𝚒𝚝𝚎 : 𝚝𝚛𝚊𝚗𝚌𝚑𝚒𝚜𝚝𝚞𝚍𝚒𝚘.𝚌𝚘𝚖
C͟a͟l͟l͟ : ⓿➌➒➋.➑➊➐.⓿➐➒
━━━━━━━━━━━━━━━━━━`;

/** Seed chữ ký mặc định lần đầu (chỉ khi bảng rỗng). Idempotent, không throw. */
export async function ensureSignatureSeed(): Promise<void> {
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM autopost_signatures`);
    const n = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (n === 0) {
      await pool.query(
        `INSERT INTO autopost_signatures (name, content, is_active, is_default, updated_at)
         VALUES ($1, $2, true, true, now())`,
        [DEFAULT_SIGNATURE_NAME, DEFAULT_SIGNATURE_CONTENT],
      );
      console.log("[AutoPost] seeded default signature");
    }
  } catch (e) {
    console.error("[AutoPost] ensureSignatureSeed lỗi:", String(e).slice(0, 150));
  }
}

function rowToSignature(r: any): Signature {
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    content: String(r.content ?? ""),
    isActive: Boolean(r.is_active ?? r.isActive),
    isDefault: Boolean(r.is_default ?? r.isDefault),
    createdAt: r.created_at ?? r.createdAt,
    updatedAt: r.updated_at ?? r.updatedAt,
  };
}

/** Danh sách chữ ký (mặc định lên đầu, mới nhất kế tiếp). [] nếu lỗi. */
export async function listSignatures(): Promise<Signature[]> {
  try {
    const r = await pool.query(
      `SELECT id, name, content, is_active, is_default, created_at, updated_at
         FROM autopost_signatures
        ORDER BY is_default DESC, updated_at DESC, id DESC`,
    );
    return r.rows.map(rowToSignature);
  } catch (e) {
    console.error("[AutoPost] listSignatures lỗi:", String(e).slice(0, 150));
    return [];
  }
}

/**
 * Nội dung chữ ký mặc định ĐANG BẬT — dùng để gắn cuối bài. "" nếu không có /lỗi.
 * Ưu tiên: is_default → mới cập nhật nhất. CHỈ lấy chữ ký đang bật (is_active).
 */
export async function getDefaultSignatureContent(): Promise<string> {
  try {
    const r = await pool.query(
      `SELECT content FROM autopost_signatures
        WHERE is_active = true
        ORDER BY is_default DESC, updated_at DESC, id DESC
        LIMIT 1`,
    );
    return String((r.rows[0] as { content?: string } | undefined)?.content ?? "").trim();
  } catch (e) {
    console.error("[AutoPost] getDefaultSignatureContent lỗi:", String(e).slice(0, 150));
    return "";
  }
}

/**
 * Gỡ chữ ký đã gắn trước đó ở CUỐI caption (chống gắn trùng khi "Tạo lại").
 * Quy ước: chữ ký luôn mở đầu bằng 1 DÒNG phân cách gồm toàn ký tự "━" (≥ 3).
 * Cắt từ dòng phân cách ĐẦU TIÊN trở đi. Cũng gỡ footer cũ (cùng ký tự ━).
 * Không có dòng phân cách → trả nguyên (chỉ bỏ khoảng trắng cuối).
 */
export function stripSignature(caption: string): string {
  const raw = caption ?? "";
  const lines = raw.split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length >= 3 && /^━+$/.test(t)) { cut = i; break; }
  }
  if (cut >= 0) return lines.slice(0, cut).join("\n").replace(/\s+$/g, "");
  return raw.replace(/\s+$/g, "");
}

/**
 * Gắn chữ ký vào CUỐI caption: `body + 1 dòng trống + chữ ký`.
 * Tự gỡ chữ ký cũ (dòng phân cách ━ HOẶC trùng nguyên văn) để không gắn chồng
 * 2-3 lần → nếu caption đã có chữ ký cũ thì được THAY bằng chữ ký truyền vào.
 * signature rỗng → trả nguyên body (không footer).
 */
export function appendSignature(caption: string, signature: string): string {
  const sig = (signature ?? "").trim();
  let body = stripSignature(caption);
  if (sig) {
    const trimmed = body.replace(/\s+$/g, "");
    if (trimmed.endsWith(sig)) body = trimmed.slice(0, trimmed.length - sig.length).replace(/\s+$/g, "");
  }
  body = body.trim();
  if (!sig) return body;
  if (!body) return sig;
  return `${body}\n\n${sig}`;
}
