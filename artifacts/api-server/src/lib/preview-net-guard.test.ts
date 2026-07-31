import { describe, it, expect } from "vitest";
import {
  extractHost,
  installPreviewNetGuard,
  isOutboundAllowed,
  parseNetAllowlist,
} from "./preview-net-guard.js";

describe("installPreviewNetGuard — production không bao giờ bị vá", () => {
  it("không có PREVIEW_MODE=1 → không cài gì, trả false", () => {
    expect(installPreviewNetGuard({})).toBe(false);
    expect(installPreviewNetGuard({ PREVIEW_MODE: "0" })).toBe(false);
  });
});

describe("parseNetAllowlist", () => {
  it("luôn cho phép host nội bộ", () => {
    const set = parseNetAllowlist(undefined);
    expect(set.has("localhost")).toBe(true);
    expect(set.has("127.0.0.1")).toBe(true);
  });

  it("thêm host từ env, chuẩn hoá chữ thường + bỏ khoảng trắng", () => {
    const set = parseNetAllowlist(" Example.COM , api.dich-vu.vn ,, ");
    expect(set.has("example.com")).toBe(true);
    expect(set.has("api.dich-vu.vn")).toBe(true);
    expect(set.has("graph.facebook.com")).toBe(false);
  });
});

describe("extractHost — nhận diện host từ mọi kiểu tham số", () => {
  it("chuỗi URL", () => {
    expect(extractHost("https://graph.facebook.com/v21.0/me/messages")).toBe("graph.facebook.com");
  });

  it("đối tượng URL", () => {
    expect(extractHost(new URL("https://api.openai.com/v1/chat"))).toBe("api.openai.com");
  });

  it("đối tượng kiểu Request (có .url)", () => {
    expect(extractHost({ url: "https://api.anthropic.com/v1/messages" })).toBe("api.anthropic.com");
  });

  it("options của http.request — hostname hoặc host kèm cổng", () => {
    expect(extractHost({ hostname: "WWW.googleapis.com", path: "/upload" })).toBe("www.googleapis.com");
    expect(extractHost({ host: "fcm.googleapis.com:443" })).toBe("fcm.googleapis.com");
  });

  it("dạng (url, options) — lấy từ tham số nào có", () => {
    expect(extractHost("https://a.example.com/x", { hostname: "b.example.com" })).toBe("a.example.com");
    expect(extractHost(undefined, { hostname: "b.example.com" })).toBe("b.example.com");
  });

  it("không xác định được → null", () => {
    expect(extractHost(undefined)).toBeNull();
    expect(extractHost("khong-phai-url")).toBeNull();
    expect(extractHost({})).toBeNull();
  });
});

describe("isOutboundAllowed — MẶC ĐỊNH CẤM", () => {
  const allow = parseNetAllowlist("api.dich-vu.vn");

  it("host lạ → cấm", () => {
    for (const h of ["graph.facebook.com", "api.openai.com", "api.anthropic.com", "www.googleapis.com"]) {
      expect(isOutboundAllowed(h, allow)).toBe(false);
    }
  });

  it("không biết host → cấm (fail-closed)", () => {
    expect(isOutboundAllowed(null, allow)).toBe(false);
  });

  it("host trong allowlist hoặc nội bộ → cho phép", () => {
    expect(isOutboundAllowed("api.dich-vu.vn", allow)).toBe(true);
    expect(isOutboundAllowed("localhost", allow)).toBe(true);
  });
});
