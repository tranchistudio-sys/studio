import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authHeaders } from "@/components/cms-shared";
import { apiUrl } from "@/lib/api-base";
import type { PublicHomeContent } from "@/hooks/use-public-cms";

export type HomeSettingsForm = PublicHomeContent;

const HOME_SETTINGS_PATHS = [
  "/api/cms/home-settings",
  "/api/cms/admin/public-home",
] as const;

export const EMPTY_HOME_SETTINGS: HomeSettingsForm = {
  heroImageUrl: null,
  aboutImageUrl: null,
  eyebrow: null,
  titleLine1: null,
  titleLine2: null,
  subtitle: null,
  ctaPrimaryLabel: null,
  ctaPrimaryHref: null,
  ctaSecondaryLabel: null,
  ctaSecondaryHref: null,
  featuredConceptImageUrl: null,
  featuredServiceImageUrl: null,
  footerBannerImageUrl: null,
  footerCtaTitle: null,
  footerCtaSubtitle: null,
  footerCtaButtonLabel: null,
  footerCtaButtonHref: null,
};

function parseHomeSettings(raw: unknown): HomeSettingsForm {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => {
    const v = row[k];
    if (v == null || v === "") return null;
    return String(v);
  };
  const concepts = row.featuredConcepts;
  const services = row.featuredServices;
  const conceptFromArr =
    Array.isArray(concepts) && typeof concepts[0] === "string" ? concepts[0] : null;
  const serviceFromArr =
    Array.isArray(services) && typeof services[0] === "string" ? services[0] : null;

  return {
    ...EMPTY_HOME_SETTINGS,
    heroImageUrl: str("heroImageUrl") ?? str("heroImage"),
    aboutImageUrl: str("aboutImageUrl") ?? str("aboutImage"),
    eyebrow: str("eyebrow"),
    titleLine1: str("titleLine1") ?? str("heroTitle"),
    titleLine2: str("titleLine2"),
    subtitle: str("subtitle") ?? str("heroSubtitle"),
    ctaPrimaryLabel: str("ctaPrimaryLabel"),
    ctaPrimaryHref: str("ctaPrimaryHref"),
    ctaSecondaryLabel: str("ctaSecondaryLabel"),
    ctaSecondaryHref: str("ctaSecondaryHref"),
    featuredConceptImageUrl: str("featuredConceptImageUrl") ?? conceptFromArr,
    featuredServiceImageUrl: str("featuredServiceImageUrl") ?? serviceFromArr,
    footerBannerImageUrl: str("footerBannerImageUrl"),
    footerCtaTitle: str("footerCtaTitle"),
    footerCtaSubtitle: str("footerCtaSubtitle"),
    footerCtaButtonLabel: str("footerCtaButtonLabel"),
    footerCtaButtonHref: str("footerCtaButtonHref"),
  };
}

async function fetchHomeSettingsOnce(url: string): Promise<HomeSettingsForm> {
  const r = await fetch(url, { headers: authHeaders() });
  const body: unknown = await r.json().catch(() => null);
  if (!r.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${r.status}`;
    const err = new Error(msg || "Không tải được dữ liệu");
    (err as Error & { status?: number }).status = r.status;
    throw err;
  }
  return parseHomeSettings(body);
}

async function loadHomeSettings(): Promise<HomeSettingsForm> {
  let last404: Error | null = null;
  for (const path of HOME_SETTINGS_PATHS) {
    const url = apiUrl(path);
    try {
      return await fetchHomeSettingsOnce(url);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const status = (err as Error & { status?: number }).status;
      if (status === 404) {
        last404 = err;
        continue;
      }
      throw err;
    }
  }
  throw (
    last404 ??
    new Error(
      "API chưa có route cài đặt trang chủ. Restart api-server: pnpm run start (artifacts/api-server).",
    )
  );
}

async function saveHomeSettings(body: HomeSettingsForm): Promise<HomeSettingsForm> {
  let last404: Error | null = null;
  for (const path of HOME_SETTINGS_PATHS) {
    const url = apiUrl(path);
    try {
      const r = await fetch(url, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const resBody: unknown = await r.json().catch(() => null);
      if (!r.ok) {
        const msg =
          resBody && typeof resBody === "object" && "error" in resBody
            ? String((resBody as { error: unknown }).error)
            : `HTTP ${r.status}`;
        const err = new Error(msg || "Lưu thất bại");
        (err as { status?: number }).status = r.status;
        throw err;
      }
      return parseHomeSettings(resBody);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if ((err as Error & { status?: number }).status === 404) {
        last404 = err;
        continue;
      }
      throw err;
    }
  }
  throw last404 ?? new Error("Không lưu được — API chưa có route. Restart api-server.");
}

export function useAdminHomeSettings() {
  return useQuery({
    queryKey: ["cms-home-settings"],
    queryFn: loadHomeSettings,
    retry: (count, err) => {
      const status = (err as Error & { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) return false;
      return count < 1;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
}

export function useSaveAdminHomeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveHomeSettings,
    onSuccess: (data) => {
      qc.setQueryData(["cms-home-settings"], data);
      qc.invalidateQueries({ queryKey: ["public-home"] });
    },
  });
}
