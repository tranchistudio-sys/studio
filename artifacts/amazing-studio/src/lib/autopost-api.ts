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
  poolTitle: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutoPostSettings = {
  tone?: string;
  bannedWords?: string[];
  defaultPageId?: string;
  [k: string]: unknown;
};

export type FbTestResult = { ok: boolean; pageName: string | null; canPost: boolean; error?: string };

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
    const msg = (data && typeof data === "object" && "error" in data && (data as { error?: string }).error) || `HTTP ${r.status}`;
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

export function usePosts(status?: string) {
  return useQuery({
    queryKey: K.posts(status),
    queryFn: () => apGet<Post[]>(`/autopost/posts${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  });
}

export function useSettings() {
  return useQuery({ queryKey: K.settings(), queryFn: () => apGet<AutoPostSettings>(`/autopost/settings`) });
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
    mutationFn: (body: { poolId: number; scheduleId?: number; slotId?: number; imageCount?: number }) =>
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
    mutationFn: (v: { id: number; captionFinal: string; scheduledAt: string }) =>
      apPost(`/autopost/posts/${v.id}/approve`, { captionFinal: v.captionFinal, scheduledAt: v.scheduledAt }),
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
