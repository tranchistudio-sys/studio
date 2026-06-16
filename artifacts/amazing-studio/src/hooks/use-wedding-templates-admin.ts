import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api-base";
import { authHeaders } from "@/components/cms-shared";

export const WEDDING_TEMPLATE_CATEGORIES = [
  "Hàn Quốc",
  "Hiện Đại",
  "Burgundy",
  "Lãng Mạn",
] as const;

export type WeddingTemplateCategory = (typeof WEDDING_TEMPLATE_CATEGORIES)[number];

export interface AdminWeddingTemplate {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  thumbnailUrl: string | null;
  previewImageUrl: string | null;
  mockupImageUrl: string | null;
  defaultBackgroundUrl: string | null;
  themeColor: string | null;
  themeKey: string;
  sortOrder: number;
  isActive: boolean;
}

export type WeddingTemplateInput = {
  name: string;
  slug: string;
  category: WeddingTemplateCategory;
  description?: string | null;
  thumbnailUrl?: string | null;
  previewImageUrl?: string | null;
  mockupImageUrl?: string | null;
  defaultBackgroundUrl?: string | null;
  themeColor?: string | null;
  themeKey?: string;
  sortOrder?: number;
  isActive?: boolean;
};

/** CMS router — ưu tiên (cùng home-settings). */
const TEMPLATE_API_PATHS = [
  "/api/cms/wedding-templates",
  "/api/wedding-cards/admin/templates",
] as const;

async function parseApiError(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as {
    error?: string;
    detail?: string;
    details?: { fieldErrors?: Record<string, string[]> };
  } | null;
  if (body?.error) {
    const fields = body.details?.fieldErrors;
    if (fields && Object.keys(fields).length) {
      const extra = Object.entries(fields)
        .map(([k, v]) => `${k}: ${v?.[0] ?? ""}`)
        .join("; ");
      return `${body.error} (${extra})`;
    }
    if (body.detail) return `${body.error} — ${body.detail}`;
    return body.error;
  }
  if (r.status === 404) {
    return "API chưa có route (404). Restart api-server: pnpm run start trong artifacts/api-server";
  }
  if (r.status === 403) return "Chỉ tài khoản admin mới tạo được mẫu thiệp";
  if (r.status === 401) return "Chưa đăng nhập — hãy đăng nhập lại";
  return `HTTP ${r.status}`;
}

async function fetchWithPaths(
  init: RequestInit,
  trash = false,
): Promise<Response> {
  let last404: Response | null = null;
  for (const path of TEMPLATE_API_PATHS) {
    const url = `${apiUrl(path)}${trash ? "?trash=1" : ""}`;
    const r = await fetch(url, init);
    if (r.status !== 404) return r;
    last404 = r;
  }
  return last404 ?? new Response(null, { status: 404 });
}

async function fetchTemplates(trash = false): Promise<AdminWeddingTemplate[]> {
  const r = await fetchWithPaths({ headers: authHeaders() }, trash);
  if (!r.ok) throw new Error(await parseApiError(r));
  return r.json();
}

export function useAdminWeddingTemplates(trash = false) {
  return useQuery({
    queryKey: ["cms-admin-wedding-templates", trash],
    queryFn: () => fetchTemplates(trash),
    retry: (n, err) => !String(err).includes("404") && n < 1,
    refetchOnWindowFocus: false,
  });
}

export function useCreateWeddingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: WeddingTemplateInput) => {
      const r = await fetchWithPaths({
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await parseApiError(r));
      return r.json() as Promise<AdminWeddingTemplate>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-admin-wedding-templates"] });
      qc.invalidateQueries({ queryKey: ["wedding-card-templates"] });
    },
  });
}

export function useUpdateWeddingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Partial<WeddingTemplateInput> }) => {
      let last404: Response | null = null;
      for (const path of TEMPLATE_API_PATHS) {
        const r = await fetch(apiUrl(`${path}/${id}`), {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        if (r.status !== 404) {
          if (!r.ok) throw new Error(await parseApiError(r));
          return r.json() as Promise<AdminWeddingTemplate>;
        }
        last404 = r;
      }
      throw new Error(await parseApiError(last404 ?? new Response(null, { status: 404 })));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-admin-wedding-templates"] });
      qc.invalidateQueries({ queryKey: ["wedding-card-templates"] });
    },
  });
}

export function useDeleteWeddingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      let last404: Response | null = null;
      for (const path of TEMPLATE_API_PATHS) {
        const r = await fetch(apiUrl(`${path}/${id}`), {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (r.status !== 404) {
          if (!r.ok) throw new Error(await parseApiError(r));
          return;
        }
        last404 = r;
      }
      throw new Error(await parseApiError(last404 ?? new Response(null, { status: 404 })));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-admin-wedding-templates"] });
      qc.invalidateQueries({ queryKey: ["wedding-card-templates"] });
    },
  });
}

export function useRestoreWeddingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      let last404: Response | null = null;
      for (const path of TEMPLATE_API_PATHS) {
        const r = await fetch(apiUrl(`${path}/${id}/restore`), {
          method: "POST",
          headers: authHeaders(),
        });
        if (r.status !== 404) {
          if (!r.ok) throw new Error(await parseApiError(r));
          return r.json() as Promise<AdminWeddingTemplate>;
        }
        last404 = r;
      }
      throw new Error(await parseApiError(last404 ?? new Response(null, { status: 404 })));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-admin-wedding-templates"] });
      qc.invalidateQueries({ queryKey: ["wedding-card-templates"] });
    },
  });
}
