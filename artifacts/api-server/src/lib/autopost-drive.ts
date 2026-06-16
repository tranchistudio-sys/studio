/**
 * autopost-drive.ts — Google Drive connector (Phase 2) cho AutoPost.
 *
 * CHỈ ĐỌC (read-only): chỉ gọi list + download (alt=media). KHÔNG xoá/sửa file Drive.
 * Refresh token nên được tạo với scope `https://www.googleapis.com/auth/drive.readonly`.
 *
 * CREDENTIAL — đọc từ BIẾN MÔI TRƯỜNG (không hardcode, không ghi vào code/DB, không log):
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   GOOGLE_DRIVE_REFRESH_TOKEN
 *   GOOGLE_DRIVE_FOLDER_ID        (folder cha "Amazing Studio AutoPost"; có thể override
 *                                  bằng settings.config.drive.folderId)
 *
 * Luồng: quét folder cha → từng folder con map sang contentType → lấy file ảnh/video →
 * bỏ trùng theo Drive fileId → tải ảnh về object storage (/objects/uploads/<uuid>) →
 * upsert vào autopost_content_pool (source_type='google_drive'). Video: chỉ lấy thumbnail
 * (không tải full video); ĐĂNG video lên FB hoãn Phase 2.1.
 */
import { OAuth2Client } from "google-auth-library";
import { pool } from "@workspace/db";
import { upsertPoolItem } from "./autopost-pool";
import { hashImageUrl } from "./autopost-images";
import { persistImageBuffer } from "./autopost-storage";

const DRIVE = "https://www.googleapis.com/drive/v3";
/** Trần số file tải về mỗi lần đồng bộ (tránh kéo hàng nghìn file một lúc). */
const MAX_IMPORT_PER_SYNC = 200;

export type DriveCreds = { clientId: string; clientSecret: string; refreshToken: string };
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  thumbnailLink?: string;
};

// ─────────────────────────── PURE helpers (test được, không IO) ──────────────

/** Bỏ dấu tiếng Việt + thường hoá để so khớp tên folder linh hoạt. */
export function normalizeVi(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim();
}

/** Thứ tự QUAN TRỌNG: cụm cụ thể hơn đặt trước. */
const FOLDER_MAP: Array<[string, string]> = [
  ["ao dai cuoi", "ao_dai_cuoi"],
  ["viet phuc", "viet_phuc"],
  ["vay moi ve", "new_arrival"],
  ["moi ve", "new_arrival"],
  ["vay cuoi", "vay_cuoi"],
  ["chup san pham", "product_real"],
  ["san pham that", "product_real"],
  ["album cuoi", "album_cuoi"],
  ["album", "album_cuoi"],
  ["hau truong", "hau_truong"],
  ["makeup", "makeup"],
  ["video reel", "reels"],
  ["reel", "reels"],
  ["feedback", "feedback"],
  ["bill", "bill"],
  ["beauty", "beauty"],
];

/** Map tên folder con → contentType. Không khớp → 'other'. */
export function folderNameToContentType(name: string): string {
  const n = normalizeVi(name);
  for (const [key, type] of FOLDER_MAP) {
    if (n.includes(key)) return type;
  }
  return "other";
}

/** Phân loại MIME: ảnh / video / null (bỏ qua). */
export function classifyMime(mime: string | undefined): "image" | "video" | null {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/** Đọc credential từ env. Không log giá trị; chỉ trả creds hoặc danh sách biến thiếu. */
export function readDriveEnv(): { creds: DriveCreds | null; missing: string[] } {
  const clientId = (process.env.GOOGLE_DRIVE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "").trim();
  const refreshToken = (process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "").trim();
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_DRIVE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_DRIVE_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_DRIVE_REFRESH_TOKEN");
  if (missing.length > 0) return { creds: null, missing };
  return { creds: { clientId, clientSecret, refreshToken }, missing: [] };
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** clientId/secret cho OAuth (từ env). null nếu thiếu. */
export function getOAuthClientEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.GOOGLE_DRIVE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Creds đầy đủ để gọi Drive: clientId/secret từ env; refreshToken từ env HOẶC
 * autopost_settings.config.drive.refreshToken (lưu sau khi kết nối OAuth). Không log token.
 */
export async function resolveDriveCreds(): Promise<{ creds: DriveCreds | null; missing: string[] }> {
  const clientId = (process.env.GOOGLE_DRIVE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "").trim();
  let refreshToken = (process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "").trim();
  if (!refreshToken) {
    try {
      const r = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
      const t = (r.rows[0]?.config as any)?.drive?.refreshToken;
      if (typeof t === "string" && t.trim()) refreshToken = t.trim();
    } catch {
      /* dùng env */
    }
  }
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_DRIVE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_DRIVE_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_DRIVE_REFRESH_TOKEN (hoặc bấm Kết nối Google Drive)");
  if (missing.length > 0) return { creds: null, missing };
  return { creds: { clientId, clientSecret, refreshToken }, missing: [] };
}

/** URL Google OAuth consent. access_type=offline + prompt=consent để CHẮC CHẮN có refresh_token. */
export function getDriveAuthUrl(redirectUri: string, state: string): string {
  const env = getOAuthClientEnv();
  if (!env) throw new Error("Thiếu GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET");
  const client = new OAuth2Client(env.clientId, env.clientSecret, redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [DRIVE_SCOPE],
    state,
  });
}

/** Đổi authorization code → refresh_token (read-only). KHÔNG log token. */
export async function exchangeCodeForRefreshToken(code: string, redirectUri: string): Promise<string> {
  const env = getOAuthClientEnv();
  if (!env) throw new Error("Thiếu GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET");
  const client = new OAuth2Client(env.clientId, env.clientSecret, redirectUri);
  const { tokens } = await client.getToken(code);
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) throw new Error("Google không trả refresh_token — thử lại (cần prompt=consent + access_type=offline)");
  return refreshToken;
}

/** Lưu refresh token vào autopost_settings.config.drive.refreshToken (không log, không commit). */
export async function saveDriveRefreshToken(refreshToken: string): Promise<void> {
  await pool.query(
    `UPDATE autopost_settings
        SET config = config || jsonb_build_object(
              'drive',
              COALESCE(config->'drive', '{}'::jsonb) || jsonb_build_object('refreshToken', $1::text)
            ),
            updated_at = now()
      WHERE id = 1`,
    [refreshToken],
  );
}

// ─────────────────────────── Drive REST (read-only) ─────────────────────────

async function getAccessToken(creds: DriveCreds): Promise<string> {
  const client = new OAuth2Client(creds.clientId, creds.clientSecret);
  client.setCredentials({ refresh_token: creds.refreshToken });
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res?.token;
  if (!token) throw new Error("Không lấy được access token (refresh token sai/hết hạn?)");
  return token;
}

async function driveGet(token: string, pathAndQuery: string): Promise<any> {
  const r = await fetch(`${DRIVE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Drive API ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function listSubfolders(token: string, parentId: string): Promise<Array<{ id: string; name: string }>> {
  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const j = await driveGet(token, `/files?q=${q}&fields=files(id,name)&pageSize=100&orderBy=name`);
  return (j.files as Array<{ id: string; name: string }>) ?? [];
}

async function listMediaFiles(token: string, folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(
      `'${folderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`,
    );
    const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const j = await driveGet(
      token,
      `/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,md5Checksum,size,thumbnailLink)&pageSize=1000${pageParam}`,
    );
    out.push(...((j.files as DriveFile[]) ?? []));
    pageToken = j.nextPageToken as string | undefined;
  } while (pageToken);
  return out;
}

async function downloadDriveFile(token: string, fileId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const r = await fetch(`${DRIVE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive download ${r.status}`);
  const contentType = r.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, contentType };
}

async function fetchThumbnail(token: string, thumbnailLink?: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!thumbnailLink) return null;
  try {
    const r = await fetch(thumbnailLink, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const contentType = r.headers.get("content-type") || "image/jpeg";
    return { buffer: Buffer.from(await r.arrayBuffer()), contentType };
  } catch {
    return null;
  }
}

/** Folder cha: ưu tiên settings.config.drive.folderId, fallback env. */
async function resolveParentFolderId(): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    const folderId = (r.rows[0]?.config as any)?.drive?.folderId;
    if (typeof folderId === "string" && folderId.trim()) return folderId.trim();
  } catch {
    /* dùng env */
  }
  return (process.env.GOOGLE_DRIVE_FOLDER_ID ?? "").trim() || null;
}

// ─────────────────────────── Public API ─────────────────────────────────────

export type DriveTestResult = {
  ok: boolean;
  missing?: string[];
  folderName?: string | null;
  subfolders?: Array<{ name: string; mappedType: string; files: number }>;
  error?: string;
};

/** Kiểm tra kết nối Drive + liệt kê folder con đã map (cho nút Test). Không throw. */
export async function verifyDriveConnection(): Promise<DriveTestResult> {
  const { creds, missing } = await resolveDriveCreds();
  if (!creds) return { ok: false, missing, error: "Thiếu cấu hình Google Drive" };
  const parentId = await resolveParentFolderId();
  if (!parentId) return { ok: false, error: "Chưa cấu hình Folder ID cha (GOOGLE_DRIVE_FOLDER_ID hoặc trong cấu hình)" };
  try {
    const token = await getAccessToken(creds);
    const meta = await driveGet(token, `/files/${parentId}?fields=id,name`);
    const subs = await listSubfolders(token, parentId);
    const subfolders: Array<{ name: string; mappedType: string; files: number }> = [];
    for (const s of subs) {
      let files = 0;
      try {
        files = (await listMediaFiles(token, s.id)).length;
      } catch {
        /* đếm 0 nếu lỗi 1 folder */
      }
      subfolders.push({ name: s.name, mappedType: folderNameToContentType(s.name), files });
    }
    return { ok: true, folderName: (meta?.name as string) ?? null, subfolders };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

export type DriveSyncResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  byType: Record<string, number>;
  capped?: boolean;
  error?: string;
};

/**
 * Đồng bộ nội dung từ Google Drive vào pool. Bỏ trùng theo fileId (đã import → skip).
 * Ảnh: tải về object storage. Video: chỉ lấy thumbnail (đăng video hoãn Phase 2.1).
 */
export async function syncGoogleDrivePool(): Promise<DriveSyncResult> {
  const { creds } = await resolveDriveCreds();
  if (!creds) return { ok: false, imported: 0, skipped: 0, byType: {}, error: "Thiếu cấu hình Google Drive (chưa kết nối / thiếu env)" };
  const parentId = await resolveParentFolderId();
  if (!parentId) return { ok: false, imported: 0, skipped: 0, byType: {}, error: "Chưa cấu hình Folder ID cha" };

  let token: string;
  try {
    token = await getAccessToken(creds);
  } catch (e) {
    return { ok: false, imported: 0, skipped: 0, byType: {}, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }

  // Bộ fileId đã import (dedup chủ động — req 10).
  const existing = new Set<string>();
  try {
    const r = await pool.query(
      `SELECT source_item_id FROM autopost_content_pool WHERE source_table = 'google_drive' AND source_item_id IS NOT NULL`,
    );
    for (const row of r.rows) existing.add(String((row as { source_item_id: string }).source_item_id));
  } catch {
    /* coi như chưa có gì */
  }

  let subs: Array<{ id: string; name: string }>;
  try {
    subs = await listSubfolders(token, parentId);
  } catch (e) {
    return { ok: false, imported: 0, skipped: 0, byType: {}, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }

  let imported = 0;
  let skipped = 0;
  let capped = false;
  const byType: Record<string, number> = {};

  for (const sub of subs) {
    if (capped) break;
    const contentType = folderNameToContentType(sub.name);
    let files: DriveFile[];
    try {
      files = await listMediaFiles(token, sub.id);
    } catch (e) {
      console.error(`[AutoPost][Drive] liệt kê folder "${sub.name}" lỗi:`, e);
      continue;
    }

    for (const f of files) {
      if (existing.has(f.id)) { skipped++; continue; }
      const kind = classifyMime(f.mimeType);
      if (!kind) { skipped++; continue; }
      if (imported >= MAX_IMPORT_PER_SYNC) { capped = true; break; }

      try {
        const isVideo = kind === "video";
        let imageUrl: string | null = null;
        if (kind === "image") {
          const { buffer, contentType: ct } = await downloadDriveFile(token, f.id);
          imageUrl = await persistImageBuffer(buffer, ct, f.name);
        } else {
          // Video: chỉ lấy thumbnail (không tải full video).
          const thumb = await fetchThumbnail(token, f.thumbnailLink);
          if (thumb) imageUrl = await persistImageBuffer(thumb.buffer, thumb.contentType, `${f.name}.thumb.jpg`);
        }

        await upsertPoolItem({
          sourceType: "google_drive",
          sourceTable: "google_drive",
          sourceItemId: f.id,
          contentType,
          title: f.name.replace(/\.[a-z0-9]+$/i, "").trim() || f.name,
          images: imageUrl ? [imageUrl] : [],
          price: null,
          salePrice: null,
          goldenHourPercent: null,
          goldenHourName: null,
          category: sub.name,
          badge: isVideo ? "video" : null,
          publicLink: null,
          meta: { driveFileId: f.id, mimeType: f.mimeType, folder: sub.name, md5: f.md5Checksum ?? null, isVideo },
          imageHash: imageUrl ? hashImageUrl(imageUrl) : null,
          // Video chưa có thumbnail → không đủ điều kiện đăng (đăng video hoãn Phase 2.1).
          isEligible: !!imageUrl,
        });
        existing.add(f.id);
        imported++;
        byType[contentType] = (byType[contentType] ?? 0) + 1;
      } catch (e) {
        console.error(`[AutoPost][Drive] import file "${f.name}" lỗi:`, e);
        skipped++;
      }
    }
  }

  console.log(`[AutoPost][Drive] đồng bộ xong: imported=${imported} skipped=${skipped}${capped ? " (đạt trần, chạy lại để lấy tiếp)" : ""}`);
  return { ok: true, imported, skipped, byType, capped };
}
