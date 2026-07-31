import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  accessToken,
  credentialsMatch,
  isExemptPath,
  parseBasicAuthHeader,
  previewBasicAuth,
  PREVIEW_COOKIE,
  readCookie,
  safeEqual,
} from "./preview-basic-auth.js";

const PREVIEW_ENV = {
  PREVIEW_MODE: "1",
  PREVIEW_BASIC_AUTH_USER: "chu",
  PREVIEW_BASIC_AUTH_PASS: "mat-khau-du-dai",
};

function fakeReqRes(headerValue?: string, path = "/calendar", cookieHeader?: string) {
  const req = {
    path,
    protocol: "https",
    headers: { authorization: headerValue, cookie: cookieHeader },
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
  it("không có header → 401 kèm WWW-Authenticate", () => {
    const mw = previewBasicAuth(PREVIEW_ENV)!;
    const { req, res, next } = fakeReqRes(undefined);
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/^Basic realm=/);
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
});
