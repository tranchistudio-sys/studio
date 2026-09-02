const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function publicTenantSlugFromPath(pathname = typeof window !== "undefined" ? window.location.pathname : "/"): string {
  const match = pathname.match(/^\/studio\/([^/]+)(?:\/|$)/i);
  const candidate = match?.[1]?.toLowerCase();
  return candidate && SLUG.test(candidate) ? candidate : "amazing-studio";
}

export function publicTenantBase(slug = publicTenantSlugFromPath()): string {
  return slug === "amazing-studio" ? "" : `/studio/${encodeURIComponent(slug)}`;
}

export function publicTenantPagePath(path: string, slug = publicTenantSlugFromPath()): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${publicTenantBase(slug)}${normalized}` || "/";
}

export function publicApiUrl(path: string, slug = publicTenantSlugFromPath()): string {
  const url = new URL(path, typeof window !== "undefined" ? window.location.origin : "https://tranchistudio.com");
  url.searchParams.set("tenant", slug);
  return typeof window !== "undefined" ? `${url.pathname}${url.search}` : url.toString();
}

export function publicTenantRoute(location: string): { base: string; slug: string } | null {
  const match = location.match(/^\/studio\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/i);
  return match ? { base: `/studio/${match[1]!.toLowerCase()}`, slug: match[1]!.toLowerCase() } : null;
}
