import { createHmac, timingSafeEqual } from "node:crypto";

export function facebookAppSecret(): string | null {
  return process.env.FACEBOOK_APP_SECRET?.trim() || process.env.FB_APP_SECRET?.trim() || null;
}
export function secureStringEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyFacebookWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: unknown,
  appSecret: string | null,
): boolean {
  if (!rawBody || !appSecret || typeof signatureHeader !== "string") return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader);
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return secureStringEqual(match[1].toLowerCase(), expected);
}
