/**
 * API origin for fetch() and api-client-react.
 *
 * Dev (trình duyệt): luôn dùng cùng origin + Vite proxy `/api` → :3000
 * để tránh 404 chập chờn khi gọi thẳng localhost:3000 (process cũ / sai máy).
 *
 * Production / SSR: dùng VITE_API_BASE_URL nếu có.
 */
export function getApiBase(): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "") || "";

  if (import.meta.env.DEV && typeof window !== "undefined") {
    return basePath;
  }

  const explicit = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (explicit?.trim()) {
    return explicit.trim().replace(/\/+$/, "");
  }
  return basePath;
}

/** URL đầy đủ cho fetch: `/api/...` (có tôn trọng BASE_PATH). */
export function apiUrl(path: string): string {
  const base = getApiBase();
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!base) return p;
  return `${base}${p}`;
}

export const API_BASE = getApiBase();
