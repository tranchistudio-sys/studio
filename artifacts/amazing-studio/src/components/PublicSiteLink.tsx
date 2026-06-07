import * as React from "react";
import { getPublicPageUrl, openPublicSite } from "@/lib/public-site-url";

type PublicSiteLinkProps = React.ComponentPropsWithoutRef<"a"> & {
  path?: string;
};

/** Link that always opens the customer-facing website (never internal /calendar). */
export function PublicSiteLink({ path = "/", href, onClick, children, ...rest }: PublicSiteLinkProps) {
  const url = href ?? getPublicPageUrl(path);
  return (
    <a
      {...rest}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
        openPublicSite(path);
      }}
    >
      {children}
    </a>
  );
}
