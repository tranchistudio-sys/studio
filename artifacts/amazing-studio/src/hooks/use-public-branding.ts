import { useQuery } from "@tanstack/react-query";
import { publicApiUrl, publicTenantSlugFromPath } from "@/lib/public-tenant";
import {
  STUDIO_ADDRESS,
  STUDIO_EMAIL,
  STUDIO_PHONE,
  STUDIO_PHONE_DISPLAY,
} from "@/lib/public-site-config";

export interface PublicBranding {
  publicName: string;
  phone: string | null;
  address: string | null;
  logoUrl: string | null;
}

export function publicBrandingView(tenantSlug: string, branding?: PublicBranding) {
  const isAmazingLegacy = tenantSlug === "amazing-studio";
  const phone = branding?.phone?.trim() || (isAmazingLegacy ? STUDIO_PHONE : null);
  return {
    tenantSlug,
    isAmazingLegacy,
    publicName: branding?.publicName?.trim() || (isAmazingLegacy ? "Amazing Studio" : "Studio"),
    phone,
    phoneDisplay: branding?.phone?.trim() || (isAmazingLegacy ? STUDIO_PHONE_DISPLAY : null),
    address: branding?.address?.trim() || (isAmazingLegacy ? STUDIO_ADDRESS : null),
    email: isAmazingLegacy ? STUDIO_EMAIL : null,
  };
}

export function usePublicBranding() {
  const tenantSlug = publicTenantSlugFromPath();
  const query = useQuery<PublicBranding>({
    queryKey: ["public-branding", tenantSlug],
    queryFn: async () => {
      const response = await fetch(publicApiUrl("/api/platform/public-site", tenantSlug));
      if (!response.ok) throw new Error("Không tìm thấy website studio");
      return response.json();
    },
    retry: false,
  });
  return { ...query, view: publicBrandingView(tenantSlug, query.data) };
}
