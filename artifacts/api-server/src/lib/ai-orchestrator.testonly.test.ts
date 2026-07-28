import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTestProviderOverride, buildClaudeClientOptions } from "./ai-test-provider";

// Test wiring override ShopAIKey test-only — KHÔNG gọi mạng, chỉ kiểm env-logic + option dựng client.

const ENV_KEYS = ["LULU_TEST_PROVIDER", "SHOPAIKEY_API_KEY", "SHOPAIKEY_BASE_URL", "SHOPAIKEY_MODEL"];

describe("resolveTestProviderOverride (test-only ShopAIKey)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("chưa bật cờ → undefined (giữ nguyên production)", () => {
    process.env.SHOPAIKEY_API_KEY = "sk-shop-xxx";
    expect(resolveTestProviderOverride()).toBeUndefined();
  });

  it("bật cờ nhưng thiếu key → undefined", () => {
    process.env.LULU_TEST_PROVIDER = "shopaikey";
    expect(resolveTestProviderOverride()).toBeUndefined();
  });

  it("bật cờ + có key → trả override đầy đủ", () => {
    process.env.LULU_TEST_PROVIDER = "shopaikey";
    process.env.SHOPAIKEY_API_KEY = "sk-shop-xxx";
    process.env.SHOPAIKEY_BASE_URL = "https://api.shopaikey.com";
    process.env.SHOPAIKEY_MODEL = "claude-sonnet-4-5";
    expect(resolveTestProviderOverride()).toEqual({
      apiKey: "sk-shop-xxx",
      baseURL: "https://api.shopaikey.com",
      model: "claude-sonnet-4-5",
      label: "shopaikey",
    });
  });

  it("cờ hoa/thường + trim đều nhận; base/model rỗng → undefined field", () => {
    process.env.LULU_TEST_PROVIDER = "  ShopAIKey ";
    process.env.SHOPAIKEY_API_KEY = "  sk-shop-yyy  ";
    process.env.SHOPAIKEY_BASE_URL = "";
    process.env.SHOPAIKEY_MODEL = "";
    expect(resolveTestProviderOverride()).toEqual({
      apiKey: "sk-shop-yyy", baseURL: undefined, model: undefined, label: "shopaikey",
    });
  });
});

describe("buildClaudeClientOptions", () => {
  it("không override → dùng key production, KHÔNG baseURL", () => {
    const o = buildClaudeClientOptions("sk-ant-prod", undefined, 12000);
    expect(o).toEqual({ apiKey: "sk-ant-prod", maxRetries: 0, timeout: 12000 });
    expect("baseURL" in o).toBe(false);
  });

  it("có override → dùng key + baseURL ShopAIKey (không đụng key production)", () => {
    const o = buildClaudeClientOptions("sk-ant-prod", { apiKey: "sk-shop", baseURL: "https://api.shopaikey.com" }, 30000);
    expect(o).toEqual({ apiKey: "sk-shop", baseURL: "https://api.shopaikey.com", maxRetries: 0, timeout: 30000 });
  });

  it("override không baseURL → không set baseURL", () => {
    const o = buildClaudeClientOptions("sk-ant-prod", { apiKey: "sk-shop" }, 30000);
    expect("baseURL" in o).toBe(false);
    expect(o.apiKey).toBe("sk-shop");
  });
});
