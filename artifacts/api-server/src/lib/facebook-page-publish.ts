/**
 * facebook-page-publish.ts — Đăng bài AutoPost lên Facebook Page.
 *
 * ENV / CONFIG (KHÔNG chỉnh sửa bất kỳ file .env nào — chỉ đọc lúc runtime):
 *  - AUTOPOST_DRY_RUN: MẶC ĐỊNH BẬT (true). Chỉ đúng chuỗi "false" (không phân biệt
 *    hoa/thường) mới TẮT dry-run và cho phép đăng thật lên Facebook. Mọi giá trị
 *    khác (kể cả không set) đều giữ dry-run BẬT — sẽ KHÔNG gọi Graph API thật.
 *  - FB_PAGE_ACCESS_TOKEN: page access token, đọc từ env làm fallback. Ưu tiên
 *    đọc từ bảng settings key 'fb_page_access_token'.
 *  - FB_PAGE_ID: id của page, đọc từ env làm fallback. Ưu tiên đọc từ bảng
 *    settings key 'fb_active_page_id'.
 *  - PUBLIC_APP_URL: dùng bởi resolvePublicUrl để biến đường dẫn ảnh tương đối
 *    thành URL tuyệt đối. KHI ĐĂNG THẬT, các URL ảnh phải truy cập công khai được
 *    (Facebook tải ảnh từ URL), nếu không Graph API sẽ báo lỗi.
 *
 * LƯU Ý: KHÔNG sửa file .env / .env.example / bất kỳ secret nào. Token chỉ đọc
 * từ bảng settings hoặc process.env tại runtime, không bao giờ hardcode.
 */
import { pool } from "@workspace/db";
import { resolvePublicUrl } from "./autopost-images";

const GRAPH = "https://graph.facebook.com/v22.0";

/**
 * Lấy page access token: ưu tiên settings.fb_page_access_token, fallback
 * process.env.FB_PAGE_ACCESS_TOKEN, cuối cùng null. Không bao giờ throw.
 */
async function getPageToken(): Promise<string | null> {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE key = 'fb_page_access_token' LIMIT 1`,
    );
    return r.rows[0]?.value ?? process.env.FB_PAGE_ACCESS_TOKEN ?? null;
  } catch {
    return process.env.FB_PAGE_ACCESS_TOKEN ?? null;
  }
}

/**
 * Xác định page id: nếu truyền vào thì dùng luôn; nếu không thì đọc
 * settings.fb_active_page_id, fallback process.env.FB_PAGE_ID, cuối cùng null.
 */
async function resolvePageId(pageId?: string): Promise<string | null> {
  if (pageId) return pageId;
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE key = 'fb_active_page_id' LIMIT 1`,
    );
    return r.rows[0]?.value ?? process.env.FB_PAGE_ID ?? null;
  } catch {
    return process.env.FB_PAGE_ID ?? null;
  }
}

/**
 * MẶC ĐỊNH true (dry-run BẬT). Chỉ đúng chuỗi "false" mới tắt dry-run.
 */
export function isDryRun(): boolean {
  return (process.env.AUTOPOST_DRY_RUN ?? "true").toLowerCase() !== "false";
}

export type PublishResult = { postId: string; permalink: string | null; dryRun: boolean };

/**
 * Đăng bài lên Facebook Page. MAY throw khi thiếu token/page id hoặc khi Graph
 * API trả lỗi — đây là hành vi mong muốn (scheduler ở Task 6 sẽ bắt lỗi và đánh
 * dấu bài đăng thất bại).
 */
export async function publishToPage(p: {
  pageId?: string;
  message: string;
  imageUrls: string[];
}): Promise<PublishResult> {
  const token = await getPageToken();
  const pageId = await resolvePageId(p.pageId);
  if (!token || !pageId) throw new Error("Thiếu fb_page_access_token hoặc page_id");

  const urls = (p.imageUrls || [])
    .map(resolvePublicUrl)
    .filter((u) => typeof u === "string" && u.length > 0);

  if (isDryRun()) {
    console.log(
      "[AutoPost][DRY_RUN] page=" + pageId + " imgs=" + urls.length + " caption=" + p.message.slice(0, 60),
    );
    return { postId: "dryrun_" + Date.now(), permalink: null, dryRun: true };
  }

  // SINGLE: 0 hoặc 1 ảnh -> đăng trực tiếp lên /photos kèm caption.
  if (urls.length <= 1) {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("caption", p.message);
    if (urls[0]) body.set("url", urls[0]);
    const r = await fetch(GRAPH + "/" + pageId + "/photos", { method: "POST", body });
    const j = (await r.json()) as { post_id?: string; id?: string };
    if (!r.ok) throw new Error("FB photos " + r.status + ": " + JSON.stringify(j).slice(0, 200));
    const postId = j.post_id || j.id || "";
    return {
      postId,
      permalink: j.post_id ? "https://www.facebook.com/" + j.post_id : null,
      dryRun: false,
    };
  }

  // MULTI: >=2 ảnh -> upload từng ảnh published=false, lấy media_fbid, rồi
  // tạo feed post đính kèm tất cả ảnh.
  const mediaFbids: string[] = [];
  for (const url of urls.slice(0, 10)) {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("url", url);
    body.set("published", "false");
    const r = await fetch(GRAPH + "/" + pageId + "/photos", { method: "POST", body });
    const j = (await r.json()) as { id?: string };
    if (!r.ok) throw new Error("FB upload " + r.status + ": " + JSON.stringify(j).slice(0, 200));
    mediaFbids.push(j.id ?? "");
  }

  const feed = new URLSearchParams();
  feed.set("access_token", token);
  feed.set("message", p.message);
  mediaFbids.forEach((id, i) => feed.set("attached_media[" + i + "]", JSON.stringify({ media_fbid: id })));
  const r = await fetch(GRAPH + "/" + pageId + "/feed", { method: "POST", body: feed });
  const j = (await r.json()) as { id?: string };
  if (!r.ok) throw new Error("FB feed " + r.status + ": " + JSON.stringify(j).slice(0, 200));
  return { postId: j.id ?? "", permalink: "https://www.facebook.com/" + (j.id ?? ""), dryRun: false };
}

/**
 * Kiểm tra token + page id còn hợp lệ. KHÔNG BAO GIỜ throw (luôn trả object).
 */
export async function verifyPageToken(
  pageId?: string,
): Promise<{ ok: boolean; pageName: string | null; canPost: boolean; error?: string }> {
  try {
    const token = await getPageToken();
    const pid = await resolvePageId(pageId);
    if (!token || !pid) {
      return { ok: false, pageName: null, canPost: false, error: "missing token or page id" };
    }
    const r = await fetch(
      GRAPH + "/" + pid + "?fields=name&access_token=" + token,
    );
    const j = (await r.json()) as { name?: string };
    if (r.ok) {
      return { ok: true, pageName: j.name ?? null, canPost: true };
    }
    return {
      ok: false,
      pageName: null,
      canPost: false,
      error: JSON.stringify(j).slice(0, 200),
    };
  } catch (e) {
    return {
      ok: false,
      pageName: null,
      canPost: false,
      error: String(e instanceof Error ? e.message : e),
    };
  }
}
