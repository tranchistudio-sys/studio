export function getPublicBaseUrl(): string {
  if (process.env.PUBLIC_APP_URL) {
    const u = process.env.PUBLIC_APP_URL;
    const full = u.startsWith("http") ? u : `https://${u}`;
    return full.replace(/\/+$/, "");
  }

  const domains = (process.env.REPLIT_DOMAINS || "").split(",").map(d => d.trim()).filter(Boolean);
  if (domains.length > 0) {
    const prodDomain = domains.find(d => d.endsWith(".replit.app")) ?? domains[0];
    return `https://${prodDomain}`;
  }

  const devDomain = process.env.REPLIT_DEV_DOMAIN || "localhost:8080";
  return devDomain.startsWith("http") ? devDomain : `https://${devDomain}`;
}
