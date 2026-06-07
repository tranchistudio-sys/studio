import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api-base";
import { FALLBACK_WEDDING_TEMPLATES } from "@/components/wedding-card/wedding-card-config";

const WC_BASE = `${API_BASE}/api/wedding-cards`;

export interface WeddingCardTemplate {
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
}

export interface PublicWeddingCard {
  id: number;
  slug: string;
  status: string;
  templateId: number;
  templateSlug: string | null;
  themeKey: string | null;
  groomName: string;
  brideName: string;
  weddingDate: string | null;
  ceremonyTime: string | null;
  receptionTime: string | null;
  venueGroom: string | null;
  venueBride: string | null;
  venueReception: string | null;
  mapsUrlGroom: string | null;
  mapsUrlBride: string | null;
  mapsUrlReception: string | null;
  invitationMessage: string | null;
  coverImageUrl: string | null;
  coupleImageUrl: string | null;
  contactPhone: string | null;
  viewCount: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface CreateWeddingCardInput {
  templateSlug: string;
  groomName: string;
  brideName: string;
  weddingDate?: string | null;
  ceremonyTime?: string | null;
  receptionTime?: string | null;
  venueGroom?: string | null;
  venueBride?: string | null;
  venueReception?: string | null;
  mapsUrlGroom?: string | null;
  mapsUrlBride?: string | null;
  mapsUrlReception?: string | null;
  invitationMessage?: string | null;
  coverImageUrl?: string | null;
  coupleImageUrl?: string | null;
  contactPhone?: string | null;
}

export interface GuestEntry {
  id: number;
  guestName: string | null;
  message: string | null;
  attendance: string;
  guestCount: number;
  createdAt: string;
}

function normalizeTemplates(raw: unknown): WeddingCardTemplate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is Record<string, unknown> => row != null && typeof row === "object")
    .map((row) => ({
      id: Number(row.id) || 0,
      slug: String(row.slug ?? ""),
      name: String(row.name ?? row.slug ?? ""),
      description: row.description != null ? String(row.description) : null,
      category: row.category != null ? String(row.category) : null,
      thumbnailUrl:
        row.thumbnailUrl != null
          ? String(row.thumbnailUrl)
          : row.thumbnail_url != null
            ? String(row.thumbnail_url)
            : null,
      previewImageUrl:
        row.previewImageUrl != null
          ? String(row.previewImageUrl)
          : row.preview_image_url != null
            ? String(row.preview_image_url)
            : null,
      mockupImageUrl:
        row.mockupImageUrl != null
          ? String(row.mockupImageUrl)
          : row.mockup_image_url != null
            ? String(row.mockup_image_url)
            : null,
      defaultBackgroundUrl:
        row.defaultBackgroundUrl != null
          ? String(row.defaultBackgroundUrl)
          : row.default_background_url != null
            ? String(row.default_background_url)
            : null,
      themeColor: row.themeColor != null ? String(row.themeColor) : null,
      themeKey: String(row.themeKey ?? row.theme_key ?? row.slug ?? "classic"),
      sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
    }))
    .filter((t) => t.slug.length > 0);
}

async function fetchTemplates(): Promise<{
  templates: WeddingCardTemplate[];
  fromApi: boolean;
  apiError?: string;
}> {
  const url = `${WC_BASE}/public/templates`;
  try {
    const r = await fetch(url);
    const body: unknown = await r.json().catch(() => null);
    if (!r.ok) {
      const err =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${r.status}`;
      if (import.meta.env.DEV) {
        console.error("[thiep-cuoi] templates API error", { url, status: r.status, body });
      }
      return { templates: FALLBACK_WEDDING_TEMPLATES, fromApi: false, apiError: err };
    }
    const list = normalizeTemplates(body);
    if (import.meta.env.DEV) {
      console.info("[thiep-cuoi] templates API OK", {
        count: list.length,
        slugs: list.map((t) => t.slug),
        raw: body,
      });
    }
    if (list.length === 0) {
      return { templates: FALLBACK_WEDDING_TEMPLATES, fromApi: false, apiError: "API trả mảng rỗng" };
    }
    return { templates: list, fromApi: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network error";
    if (import.meta.env.DEV) {
      console.error("[thiep-cuoi] templates fetch failed", { url, error: msg });
    }
    return { templates: FALLBACK_WEDDING_TEMPLATES, fromApi: false, apiError: msg };
  }
}

export function useWeddingCardTemplates() {
  const query = useQuery({
    queryKey: ["wedding-card-templates"],
    queryFn: fetchTemplates,
    staleTime: 10 * 60 * 1000,
    retry: 2,
  });

  useEffect(() => {
    if (!import.meta.env.DEV || !query.data) return;
    console.info("[thiep-cuoi] UI render templates", {
      count: query.data.templates.length,
      fromApi: query.data.fromApi,
      templates: query.data.templates,
    });
  }, [query.data]);

  return {
    ...query,
    templates: query.data?.templates ?? [],
    fromApi: query.data?.fromApi ?? false,
    apiError: query.data?.apiError,
    isEmpty: !query.isLoading && (query.data?.templates.length ?? 0) === 0,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Lỗi ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export function useWeddingCardTemplate(slug: string | undefined) {
  return useQuery({
    queryKey: ["wedding-card-template", slug],
    queryFn: () => fetchJson<WeddingCardTemplate>(`${WC_BASE}/public/templates/${slug}`),
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
  });
}

export function useWeddingCardBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: ["wedding-card", slug],
    queryFn: () => fetchJson<PublicWeddingCard>(`${WC_BASE}/public/${slug}`),
    enabled: !!slug,
  });
}

export function useWeddingCardGuestEntries(slug: string | undefined) {
  return useQuery({
    queryKey: ["wedding-card-guests", slug],
    queryFn: () => fetchJson<GuestEntry[]>(`${WC_BASE}/public/${slug}/guest-entries`),
    enabled: !!slug,
  });
}

export function useCreateWeddingCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWeddingCardInput) =>
      fetchJson<{ id: number; slug: string; url: string; status: string; themeKey: string }>(
        `${WC_BASE}/public`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wedding-card-templates"] });
    },
  });
}

export function useSubmitGuestEntry(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      guestName?: string | null;
      message?: string | null;
      attendance?: "yes" | "no" | "unknown";
      guestCount?: number;
    }) =>
      fetchJson<GuestEntry>(`${WC_BASE}/public/${slug}/guest-entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wedding-card-guests", slug] });
    },
  });
}
