import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBackendPath, resolveFrontendDist } from "./serve-frontend.js";

describe("isBackendPath — path backend KHÔNG bao giờ rơi vào SPA fallback", () => {
  it("mọi path backend → true (giữ JSON/handler, không index.html)", () => {
    for (const p of [
      "/api", "/api/healthz", "/api/dashboard/simple",
      "/mcp", "/mcp/oauth/login",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
      "/authorize", "/token", "/register",
    ]) {
      expect(isBackendPath(p)).toBe(true);
    }
  });

  it("route giao diện → false (được trả index.html)", () => {
    for (const p of [
      "/", "/calendar", "/dashboard", "/bookings/123", "/login",
      "/assets/index-abc.js", "/quotes", "/staff/5",
      "/apixyz", "/authorized", "/tokenizer", // KHÔNG trùng prefix backend
    ]) {
      expect(isBackendPath(p)).toBe(false);
    }
  });
});

describe("resolveFrontendDist — tìm bản build FE", () => {
  const tmps: string[] = [];
  afterEach(() => {
    delete process.env.FRONTEND_DIST;
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("FRONTEND_DIST có index.html → trả đúng dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fe-dist-"));
    tmps.push(dir);
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>x</title>");
    process.env.FRONTEND_DIST = dir;
    expect(resolveFrontendDist()).toBe(dir);
  });

  it("FRONTEND_DIST KHÔNG có index.html → không nhận (thử candidate khác/null)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fe-empty-"));
    tmps.push(dir);
    process.env.FRONTEND_DIST = dir;
    expect(resolveFrontendDist()).not.toBe(dir); // dir rỗng không được chọn
  });
});
