/**
 * autopost-api.ts — API client + TanStack hooks cho trang AutoPost Facebook (Task 8).
 *
 * Mọi endpoint require admin (router backend tự kiểm). Token đọc từ
 * localStorage["amazingStudioToken_v2"], base API qua apiUrl() (tôn trọng BASE_URL).
 * Router backend mount ở "/api" → đường dẫn thực tế là "/api/autopost/*".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api-base";

// ─────────────────────────────── Types ───────────────────────────────────────

export type CaptionFlags = { suspiciousPrice: boolean; bannedWords: string[] };
export type CaptionOption = { text: string; flags?: CaptionFlags };

export type PoolItem = {
  id: number;
  sourceType: string;
  sourceTable: string | null;
  sourceItemId: string | null;
  contentType: string;
  title: string;
  images: string[];
  price: string | number | null;
  salePrice: string | number | null;
  goldenHourPercent: string | number | null;
  goldenHourName: string | null;
  category: string | null;
  badge: string | null;
  publicLink: string | null;
  imageHash: string | null;
  isEligible: boolean;
  timesPosted: number;
  lastPostedAt: string | null;
};

export type Slot = {
  id?: number;
  scheduleId?: number;
  postTime: string;
  contentType: string;
  imageCount: number;
  sourcePriority: string;
  enabled: boolean;
  sortOrder: number;
};

export type Schedule = {
  id: number;
  name: string;
  enabled: boolean;
  pageId: string | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  slots: Slot[];
};

export type Post = {
  id: number;
  scheduleId: number | null;
  slotId: number | null;
  contentPoolId: number | null;
  pageId: string | null;
  contentType: string | null;
  images: string[];
  captionOptions: CaptionOption[];
  captionRecommendedIndex: number | null;
  captionFinal: string | null;
  status: string;
  scheduledAt: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  postedAt: string | null;
  facebookPostId: string | null;
  facebookPostLink: string | null;
  errorMessage: string | null;
  retryCount: number;
  captionHash: string | null;
  imageHash: string | null;
  aiModel?: string | null;
  visionImageCount?: number | null;
  usedSampleIds?: number[] | null;
  footerEnabled?: boolean | null;
  /** Cửa sổ kiểm duyệt 30': mốc hết khoá "đang sửa" (auto-publish tạm dừng tới đây). */
  editingUntil?: string | null;
  /** Admin đã "Tạm ngưng tự đăng" riêng bài này. */
  autoPaused?: boolean;
  poolTitle: string | null;
  createdAt: string;
  updatedAt: string;
};

// Cấu hình vận hành (/autopost/config) — gồm công tắc tự đăng + số phút kiểm duyệt.
export type AutopostOpConfig = {
  postsPerTick: number;
  postsPerDay: number;
  captionOptionsPerPost: number;
  maxVisionImagesPerPost: number;
  autoApproveEnabled: boolean;
  autoApproveAfterMinutes: number;
  autoPublishAfterApproved: boolean;
  requireManualApproval: boolean;
  dryRun: boolean | null;
};

export type AutoPostSettings = {
  tone?: string;
  bannedWords?: string[];
  defaultPageId?: string;
  drive?: { folderId?: string; connected?: boolean };
  [k: string]: unknown;
};

export type FbTestResult = { ok: boolean; pageName: string | null; canPost: boolean; error?: string };

export type DriveTestResult = {
  ok: boolean;
  missing?: string[];
  folderName?: string | null;
  subfolders?: Array<{ name: string; mappedType: string; files: number }>;
  error?: string;
};
export type DriveSyncResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  byType: Record<string, number>;
  capped?: boolean;
  error?: string;
};
export type DriveStatus = {
  connected: boolean;
  hasClient: boolean;
  clientIdSource: string | null;
  clientSecretSource: string | null;
  folderId: string | null;
  folderConfigured: boolean;
};

// ─────────────────────────────── Fetch core ──────────────────────────────────

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem("amazingStudioToken_v2");
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(apiUrl(`/api${path}`), {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    // Hiện lỗi rõ ràng: ưu tiên `error`, kèm `reason` nếu có (vd OCR: "ocr_failed: claude=no_key")
    // để admin biết là thiếu API key / provider lỗi — KHÔNG chỉ là mã HTTP trống nghĩa.
    const obj = data && typeof data === "object" ? (data as { error?: string; reason?: string }) : null;
    const base = (obj && obj.error) || `HTTP ${r.status}`;
    const msg = obj?.reason ? `${base}: ${obj.reason}` : base;
    throw new Error(String(msg));
  }
  return data as T;
}

export const apGet = <T>(p: string) => req<T>("GET", p);
export const apPost = <T>(p: string, b?: unknown) => req<T>("POST", p, b ?? {});
export const apPut = <T>(p: string, b?: unknown) => req<T>("PUT", p, b ?? {});
export const apPatch = <T>(p: string, b?: unknown) => req<T>("PATCH", p, b ?? {});
export const apDelete = <T>(p: string) => req<T>("DELETE", p);

// Query keys
const K = {
  pool: (f?: PoolFilters) => ["autopost", "pool", f ?? {}] as const,
  schedules: () => ["autopost", "schedules"] as const,
  posts: (status?: string) => ["autopost", "posts", status ?? "all"] as const,
  settings: () => ["autopost", "settings"] as const,
  dryRun: () => ["autopost", "dryrun"] as const,
  styleSamples: () => ["autopost", "style-samples"] as const,
  footer: () => ["autopost", "footer"] as const,
  signatures: () => ["autopost", "signatures"] as const,
  signatureDefault: () => ["autopost", "signature-default"] as const,
};

// Trạng thái dry-run hiệu lực: env thắng → db → mặc định BẬT.
export type DryRunState = {
  dryRun: boolean;
  source: "env" | "db" | "default";
  envForced: boolean;
  canToggle: boolean;
};

// Bài mẫu trong "Kho văn phong mẫu" (RAG nhẹ).
export type StyleSample = {
  id: number;
  title: string;
  content: string;
  tags: string[];
  contentType: string | null;
  tone: string | null;
  isActive: boolean;
  priority: number;
  images?: string[];
  /** Chủ đề văn phong (14 chủ đề) — AI lấy mẫu đúng chủ đề khi viết caption. */
  styleTopicKey?: string;
  styleTopicLabel?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type OcrResult = { url: string | null; text: string; provider?: string };

// Chữ ký cuối bài (footer thương hiệu). `text` = footer đã dựng sẵn (preview).
export type BrandFooter = {
  enabled: boolean;
  template: string;
  name: string; address: string; phone: string; website: string;
  facebook: string; tiktok: string; note: string;
  text?: string;
};

// Chữ ký tiệm (bảng autopost_signatures) — admin tự quản, chọn 1 mặc định.
export type Signature = {
  id: number;
  name: string;
  content: string;
  isActive: boolean;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
};

// ─────────────────────────────── Queries ─────────────────────────────────────

export type PoolFilters = { contentType?: string; sourceType?: string; eligible?: string };

export function usePool(filters?: PoolFilters) {
  return useQuery({
    queryKey: K.pool(filters),
    queryFn: () => {
      const q = new URLSearchParams();
      if (filters?.contentType) q.set("contentType", filters.contentType);
      if (filters?.sourceType) q.set("sourceType", filters.sourceType);
      if (filters?.eligible) q.set("eligible", filters.eligible);
      const qs = q.toString();
      return apGet<PoolItem[]>(`/autopost/pool${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useSchedules() {
  return useQuery({ queryKey: K.schedules(), queryFn: () => apGet<Schedule[]>(`/autopost/schedules`) });
}

export function usePosts(status?: string, opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: K.posts(status),
    queryFn: () => apGet<Post[]>(`/autopost/posts${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    ...(opts?.refetchInterval ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

// Giờ server (ISO) để tính đếm ngược chuẩn, không lệ thuộc đồng hồ máy client.
// Refresh mỗi 5 phút là đủ (offset gần như không đổi).
export function useServerTime() {
  return useQuery({
    queryKey: ["autopost", "server-time"],
    queryFn: () => apGet<{ now: string }>(`/autopost/server-time`),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
}

// Cấu hình vận hành (công tắc tự đăng + số phút kiểm duyệt…).
export function useConfig() {
  return useQuery({ queryKey: ["autopost", "config"], queryFn: () => apGet<AutopostOpConfig>(`/autopost/config`) });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AutopostOpConfig>) => apPut<AutopostOpConfig>(`/autopost/config`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "config"] }),
  });
}

export function useSettings() {
  return useQuery({ queryKey: K.settings(), queryFn: () => apGet<AutoPostSettings>(`/autopost/settings`) });
}

export function useDryRun() {
  return useQuery({ queryKey: K.dryRun(), queryFn: () => apGet<DryRunState>(`/autopost/dryrun`) });
}

export function useSetDryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) => apPut<DryRunState>(`/autopost/dryrun`, { dryRun }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.dryRun() }),
  });
}

// ─── Kho văn phong mẫu ───
export function useStyleSamples() {
  return useQuery({ queryKey: K.styleSamples(), queryFn: () => apGet<StyleSample[]>(`/autopost/style-samples`) });
}

export function useSaveStyleSample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: Record<string, unknown> }) =>
      v.id ? apPut(`/autopost/style-samples/${v.id}`, v.body) : apPost(`/autopost/style-samples`, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.styleSamples() }),
  });
}

export function useDeleteStyleSample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apDelete(`/autopost/style-samples/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.styleSamples() }),
  });
}

// OCR 1 ảnh screenshot → { url (ảnh đã lưu), text (chữ đọc được) }. Gọi lần lượt từng ảnh.
export function useOcrStyleImage() {
  return useMutation({
    mutationFn: (v: { dataBase64: string; mediaType: string }) =>
      apPost<OcrResult>(`/autopost/style-samples/ocr`, v),
  });
}

// ─── Chữ ký cuối bài (footer) ───
export function useFooter() {
  return useQuery({ queryKey: K.footer(), queryFn: () => apGet<BrandFooter>(`/autopost/footer`) });
}

export function useSaveFooter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<BrandFooter>) => apPut<BrandFooter>(`/autopost/footer`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.footer() }),
  });
}

// ─── Chữ ký tiệm (signatures) ───
export function useSignatures() {
  return useQuery({ queryKey: K.signatures(), queryFn: () => apGet<Signature[]>(`/autopost/signatures`) });
}

// Chữ ký mặc định đang bật (nội dung để preview nút "Gắn chữ ký cuối bài").
export function useDefaultSignature() {
  return useQuery({ queryKey: K.signatureDefault(), queryFn: () => apGet<{ content: string }>(`/autopost/signatures/default`) });
}

export function useSaveSignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: Record<string, unknown> }) =>
      v.id ? apPut(`/autopost/signatures/${v.id}`, v.body) : apPost(`/autopost/signatures`, v.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.signatures() });
      qc.invalidateQueries({ queryKey: K.signatureDefault() });
    },
  });
}

export function useDeleteSignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apDelete(`/autopost/signatures/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.signatures() });
      qc.invalidateQueries({ queryKey: K.signatureDefault() });
    },
  });
}

// Viết lại caption cho bài chờ duyệt theo phong cách/mood (Tạo lại / Ngắn hơn / Tình hơn / Vui hơn).
export function useRegeneratePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; style?: string; captionCount?: number; styleSampleIds?: number[] }) =>
      apPost<Post>(`/autopost/posts/${v.id}/regenerate`, {
        style: v.style, captionCount: v.captionCount, styleSampleIds: v.styleSampleIds,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

// ─────────────────────────────── Mutations ───────────────────────────────────

export function useSyncPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apPost<{ dresses: number; albums: number; ideas: number }>(`/autopost/pool/sync`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "pool"] }),
  });
}

export function useUploadPoolItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apPost<{ id: number }>(`/autopost/pool/upload`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "pool"] }),
  });
}

export function useUpdatePoolItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: Record<string, unknown> }) => apPatch(`/autopost/pool/${v.id}`, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "pool"] }),
  });
}

export function useDeletePoolItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apDelete(`/autopost/pool/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "pool"] }),
  });
}

export function useGenerate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { poolId: number; scheduleId?: number; slotId?: number; imageCount?: number; style?: string; captionCount?: number; styleSampleIds?: number[] }) =>
      apPost<Post>(`/autopost/posts/generate`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export function useUpdatePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; patch: Record<string, unknown> }) => apPatch(`/autopost/posts/${v.id}`, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export function useApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; captionFinal: string; scheduledAt: string; footerEnabled?: boolean }) =>
      apPost(`/autopost/posts/${v.id}/approve`, { captionFinal: v.captionFinal, scheduledAt: v.scheduledAt, footerEnabled: v.footerEnabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export function useSkipPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost(`/autopost/posts/${id}/skip`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export function useRetryPost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost(`/autopost/posts/${id}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export type PublishNowResult = {
  ok: boolean;
  status: string;
  dryRun?: boolean;
  postId?: string;
  permalink?: string | null;
  error?: string;
};

// Đăng NGAY 1 bài đã duyệt / đang chờ tự đăng (bỏ qua giờ hẹn).
export function usePublishNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost<PublishNowResult>(`/autopost/posts/${id}/publish-now`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

// "Sửa" bài đang chờ tự đăng → khoá auto-publish ~15' (editing_until) cho khỏi bị
// tự đăng mất trong lúc đang chỉnh.
export function useLockEdit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost<{ id: number; editingUntil: string }>(`/autopost/posts/${id}/lock-edit`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

// "Tạm ngưng tự đăng" riêng 1 bài (rời đếm ngược) / bỏ tạm ngưng.
export function usePausePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost(`/autopost/posts/${id}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export function useResumePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost(`/autopost/posts/${id}/resume`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "posts"] }),
  });
}

export function useSaveSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: Record<string, unknown> }) =>
      v.id ? apPut(`/autopost/schedules/${v.id}`, v.body) : apPost(`/autopost/schedules`, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.schedules() }),
  });
}

export function useToggleSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apPost(`/autopost/schedules/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.schedules() }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apDelete(`/autopost/schedules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.schedules() }),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: AutoPostSettings) => apPut<AutoPostSettings>(`/autopost/settings`, config),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.settings() }),
  });
}

export function useTestFacebook() {
  return useMutation({ mutationFn: () => apPost<FbTestResult>(`/autopost/facebook/test`) });
}

export function useDriveStatus() {
  return useQuery({ queryKey: ["autopost", "drive", "status"], queryFn: () => apGet<DriveStatus>(`/autopost/drive/status`) });
}

export function useTestDrive() {
  return useMutation({ mutationFn: () => apPost<DriveTestResult>(`/autopost/drive/test`) });
}

export function useSyncDrive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apPost<DriveSyncResult>(`/autopost/drive/sync`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopost", "pool"] }),
  });
}
