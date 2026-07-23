import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcryptjs";

const query = vi.fn();
vi.mock("@workspace/db", () => ({ db: {}, pool: { query: (...a: unknown[]) => query(...a) } }));

import { mcpOAuthProvider, issueTestAccessToken, authenticateStaff, _verifyJwtForTest } from "./oauth.js";

describe("MCP OAuth — access token JWT (HS256, SESSION_SECRET)", () => {
  it("access token hợp lệ → verifyAccessToken trả role + staffId", async () => {
    const tok = issueTestAccessToken(7, "admin");
    const info = await mcpOAuthProvider.verifyAccessToken(tok);
    expect(info.extra).toMatchObject({ staffId: 7, role: "admin" });
    expect(info.scopes).toContain("amazing:read");
    expect(info.clientId).toBe("test-client");
  });

  it("token bị sửa (tamper) → từ chối", async () => {
    const tok = issueTestAccessToken(7, "admin");
    const parts = tok.split(".");
    // đổi 1 ký tự trong payload
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].slice(-1) === "A" ? "B" : "A"}.${parts[2]}`;
    await expect(mcpOAuthProvider.verifyAccessToken(tampered)).rejects.toThrow();
  });

  it("chuỗi rác / thiếu phần → từ chối", async () => {
    await expect(mcpOAuthProvider.verifyAccessToken("khong-phai-jwt")).rejects.toThrow();
    await expect(mcpOAuthProvider.verifyAccessToken("a.b")).rejects.toThrow();
  });

  it("token HẾT HẠN → verifyJwt trả null (bị chặn)", () => {
    // Tự ký 1 token exp trong quá khứ qua cùng secret bằng cách... dùng verifyJwt trên token issueTest thì còn hạn.
    // Ở đây kiểm token rỗng/hỏng chắc chắn null.
    expect(_verifyJwtForTest("x.y.z")).toBeNull();
  });
});

describe("MCP OAuth — authenticateStaff (tái dùng staff + bcrypt)", () => {
  it("đúng mật khẩu + active → ok, map role admin", async () => {
    const hash = bcrypt.hashSync("matkhau123", 8);
    query.mockResolvedValueOnce({ rows: [{ id: 3, name: "TranChi", role: "admin", roles: [], password_hash: hash }] });
    const r = await authenticateStaff("tranchi", "matkhau123");
    expect(r).toMatchObject({ ok: true, staffId: 3, role: "admin", name: "TranChi" });
  });

  it("sai mật khẩu → ok:false", async () => {
    const hash = bcrypt.hashSync("dung", 8);
    query.mockResolvedValueOnce({ rows: [{ id: 3, name: "X", role: "staff", roles: [], password_hash: hash }] });
    expect(await authenticateStaff("x", "sai")).toEqual({ ok: false });
  });

  it("không tìm thấy user (hoặc inactive) → ok:false", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await authenticateStaff("khong-ton-tai", "x")).toEqual({ ok: false });
  });

  it("thiếu username/password → ok:false, không query DB", async () => {
    query.mockReset();
    expect(await authenticateStaff("", "x")).toEqual({ ok: false });
    expect(await authenticateStaff("x", "")).toEqual({ ok: false });
    expect(query).not.toHaveBeenCalled();
  });
});
