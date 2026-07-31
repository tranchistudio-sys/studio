import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  accessToken,
  credentialsMatch,
  isExemptPath,
  parseBasicAuthHeader,
  parseLoginForm,
  previewBasicAuth,
  PREVIEW_COOKIE,
  PREVIEW_LOGIN_PATH,
  readCookie,
  renderLoginPage,
  safeEqual,
  sanitizeNext,
  wantsHtml,
} from "./preview-basic-auth.js";

const PREVIEW_ENV = {
  PREVIEW_MODE: "1",
  PREVIEW_BASIC_AUTH_USER: "chu",
  PREVIEW_BASIC_AUTH_PASS: "mat-khau-du-dai",
};

function fakeReqRes(headerValue?: string, path = "/calendar", cookieHeader?: string, accept?: string) {
  const req = {
    path,
    method: "GET",
    originalUrl: path,
    protocol: "https",
    headers: { authorization: headerValue, cookie: cookieHeader, accept },
  } as unknown as Request;
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    cookie(name: string, value: string) {
      this.cookies[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { req, res: res as unknown as Response & typeof res, next: vi.fn() };
}

describe("previewBasicAuth — production KHÔNG bao giờ có middleware này", () => {
  it("không có PREVIEW_MODE=1 → trả null", () => {
    expect(previewBasicAuth({})).toBeNull();
    expect(previewBasicAuth({ PREVIEW_MODE: "0", PREVIEW_BASIC_AUTH_PASS: "x" })).toBeNull();
  });

  it("preview nhưng thiếu mật khẩu → ném lỗi, KHÔNG phục vụ trần", () => {
    expect(() => previewBasicAuth({ PREVIEW_MODE: "1" })).toThrow(/PREVIEW_BASIC_AUTH_PASS/);
  });
});

describe("previewBasicAuth — chặn/cho qua", () => {
  it("không có header, không phải trình duyệt (curl/API) → 401 kèm WWW-Authenticate", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const { req, res, next } = fakeReqRes(undefined);
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/^Basic realm=/);
  });

  // In-app browser trên iPhone KHÔNG hiện hộp Basic Auth → phải trả trang HTML
  // nhập mật khẩu, tuyệt đối không dựa vào hộp của trình duyệt (lỗi màn hình
  // trắng đã gặp thật 31/07).
  it("trình duyệt mở trang (Accept: text/html) → TRANG NHẬP MẬT KHẨU, không có WWW-Authenticate", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const { req, res, next } = fakeReqRes(undefined, "/calendar", undefined, "text/html,application/xhtml+xml");
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    // 200 chứ không phải 401: webview nhúng nào cũng render chắc chắn.
    expect(res.statusCode).toBe(200);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
    expect(String(res.body)).toContain(`action="${PREVIEW_LOGIN_PATH}"`);
    expect(String(res.body)).toContain('name="password"');
    // Quay về đúng trang đang mở sau khi nhập mật khẩu.
    expect(String(res.body)).toContain('value="/calendar"');
  });

  it("đúng user + mật khẩu → đi tiếp", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const token = Buffer.from("chu:mat-khau-du-dai").toString("base64");
    const { req, res, next } = fakeReqRes(`Basic ${token}`);
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("sai mật khẩu hoặc sai user → 401", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    for (const cred of ["chu:sai-mat-khau", "nguoi-la:mat-khau-du-dai", "chu:"]) {
      const { req, res, next } = fakeReqRes(`Basic ${Buffer.from(cred).toString("base64")}`);
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    }
  });

  it("/api/healthz được miễn để health check của Fly không bị 401", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const { req, res, next } = fakeReqRes(undefined, "/api/healthz");
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  it("đúng mật khẩu → CẤP COOKIE phiên xem thử", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const token = Buffer.from("chu:mat-khau-du-dai").toString("base64");
    const { req, res, next } = fakeReqRes(`Basic ${token}`);
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.cookies[PREVIEW_COOKIE]).toBe(accessToken("mat-khau-du-dai"));
  });

  // Đây là lỗi đã tái hiện được khi chạy thử thật: frontend gắn Bearer token vào
  // header Authorization → mất Basic Auth → nếu không có cookie thì mọi lệnh gọi
  // /api trong bản xem thử đều 401.
  it("request mang Bearer token nhưng CÓ cookie → vẫn đi tiếp", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const cookie = `${PREVIEW_COOKIE}=${accessToken("mat-khau-du-dai")}`;
    const { req, res, next } = fakeReqRes("Bearer jwt-cua-app", "/api/customers", cookie);
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("cookie sai/giả → vẫn 401", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const { req, res, next } = fakeReqRes(
      "Bearer jwt-cua-app",
      "/api/customers",
      `${PREVIEW_COOKIE}=cookie-gia-mao`,
    );
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("đổi mật khẩu xem thử → cookie cũ hết hiệu lực", () => {
    const mw = previewBasicAuth({ ...PREVIEW_ENV, PREVIEW_BASIC_AUTH_PASS: "mat-khau-moi-hon" })!;
    const { req, res, next } = fakeReqRes(
      undefined,
      "/api/customers",
      `${PREVIEW_COOKIE}=${accessToken("mat-khau-du-dai")}`,
    );
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("user mặc định là 'amazing' khi không đặt PREVIEW_BASIC_AUTH_USER", () => {
    const mw = previewBasicAuth({ PREVIEW_MODE: "1", PREVIEW_BASIC_AUTH_PASS: "mat-khau-du-dai" })!;
    const token = Buffer.from("amazing:mat-khau-du-dai").toString("base64");
    const { req, res, next } = fakeReqRes(`Basic ${token}`);
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("hàm phụ trợ", () => {
  it("isExemptPath chỉ miễn đúng healthz", () => {
    expect(isExemptPath("/api/healthz")).toBe(true);
    expect(isExemptPath("/api/healthz/extra")).toBe(false);
    expect(isExemptPath("/api/customers")).toBe(false);
    expect(isExemptPath("/")).toBe(false);
  });

  it("safeEqual so sánh đúng kể cả khi khác độ dài", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("parseBasicAuthHeader chịu được header rác", () => {
    expect(parseBasicAuthHeader(undefined)).toBeNull();
    expect(parseBasicAuthHeader("Bearer xyz")).toBeNull();
    expect(parseBasicAuthHeader("Basic khong-phai-base64-hop-le!!!")).toBeNull();
    expect(parseBasicAuthHeader(`Basic ${Buffer.from("a:b:c").toString("base64")}`)).toEqual({
      user: "a",
      pass: "b:c",
    });
  });

  it("credentialsMatch từ chối null", () => {
    expect(credentialsMatch(null, { user: "a", pass: "b" })).toBe(false);
  });

  it("readCookie lấy đúng cookie giữa nhiều cookie khác", () => {
    expect(readCookie("a=1; amazing_preview_access=abc123; b=2", PREVIEW_COOKIE)).toBe("abc123");
    expect(readCookie("a=1; b=2", PREVIEW_COOKIE)).toBeNull();
    expect(readCookie(undefined, PREVIEW_COOKIE)).toBeNull();
  });

  it("accessToken khác nhau theo từng mật khẩu", () => {
    expect(accessToken("mat-khau-1")).not.toBe(accessToken("mat-khau-2"));
    expect(accessToken("mat-khau-1")).toBe(accessToken("mat-khau-1"));
  });

  it("wantsHtml — chỉ GET có Accept text/html mới là điều hướng trình duyệt", () => {
    expect(wantsHtml("GET", "text/html,application/xhtml+xml")).toBe(true);
    expect(wantsHtml("GET", "*/*")).toBe(false); // curl mặc định
    expect(wantsHtml("GET", undefined)).toBe(false);
    expect(wantsHtml("POST", "text/html")).toBe(false);
  });

  it("sanitizeNext — chặn open-redirect, chỉ cho path nội bộ", () => {
    expect(sanitizeNext("/calendar?d=2026-07-31")).toBe("/calendar?d=2026-07-31");
    expect(sanitizeNext("//ke-xau.com/lua-dao")).toBe("/");
    expect(sanitizeNext("https://ke-xau.com")).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
    expect(sanitizeNext("")).toBe("/");
  });

  it("parseLoginForm — đọc đúng password + next từ body form", () => {
    expect(parseLoginForm("password=mat-khau-du-dai&next=%2Fcalendar")).toEqual({
      password: "mat-khau-du-dai",
      next: "/calendar",
    });
    expect(parseLoginForm("")).toEqual({ password: "", next: "/" });
    expect(parseLoginForm("next=//ke-xau.com")).toEqual({ password: "", next: "/" });
  });

  it("renderLoginPage — escape giá trị next, có báo lỗi khi sai mật khẩu", () => {
    const ok = renderLoginPage("/calendar");
    expect(ok).toContain('value="/calendar"');
    expect(ok).not.toContain("chưa đúng");
    const bad = renderLoginPage('/x" onmouseover="alert(1)', true);
    expect(bad).toContain("&quot;"); // đã escape dấu nháy
    expect(bad).not.toContain('"/x" onmouseover'); // không chèn được attribute
    expect(bad).toContain("chưa đúng");
  });
});
