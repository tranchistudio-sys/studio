const NON_ADVERTISING_PUBLIC_PREFIXES = ["/login", "/contract/", "/thiep-cuoi/"];

export function isAdvertisingTrackingAllowed(input: {
  authenticated: boolean;
  isPublicPath: boolean;
  path: string;
}) {
  if (input.authenticated || !input.isPublicPath) return false;
  return !NON_ADVERTISING_PUBLIC_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? input.path.startsWith(prefix) : input.path === prefix,
  );
}
