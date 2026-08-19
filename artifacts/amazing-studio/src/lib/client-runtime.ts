import type { QueryClient } from "@tanstack/react-query";

/**
 * React Query keys in the legacy UI are resource-based rather than tenant-
 * prefixed. A hard cache boundary is therefore mandatory whenever the browser
 * principal/tenant/role scope changes.
 */
export function resetClientCacheForScope(
  queryClient: QueryClient,
  previousScope: string,
  nextScope: string,
  force = false,
): boolean {
  if (!force && previousScope === nextScope) return false;
  queryClient.clear();
  return true;
}
