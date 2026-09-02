import * as React from "react";
import { getPublicPreviewUrl, openPublicSite } from "@/lib/public-site-url";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

type PublicSiteLinkProps = React.ComponentPropsWithoutRef<"a"> & {
  path?: string;
};

/** Link that always opens the customer-facing website (never internal /calendar). */
export function PublicSiteLink({ path = "/", href, onClick, children, ...rest }: PublicSiteLinkProps) {
  const { activeTenant } = useStaffAuth();
  const tenantSlug = activeTenant?.slug ?? "amazing-studio";
  const url = href ?? getPublicPreviewUrl(path, tenantSlug);
  return (
    <a
      {...rest}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
        openPublicSite(path, tenantSlug);
      }}
    >
      {children}
    </a>
  );
}
