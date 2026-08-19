import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyFacebookWebhookSignature } from "./facebook-webhook-signature";

describe("Facebook webhook signature", () => {
  it("chỉ chấp nhận HMAC SHA-256 của raw body", () => {
    const secret = "test-facebook-app-secret";
    const body = Buffer.from('{"object":"page","entry":[]}');
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyFacebookWebhookSignature(body, `sha256=${signature}`, secret)).toBe(true);
    expect(verifyFacebookWebhookSignature(Buffer.from("tampered"), `sha256=${signature}`, secret)).toBe(false);
    expect(verifyFacebookWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyFacebookWebhookSignature(body, `sha256=${signature}`, null)).toBe(false);
  });
});
