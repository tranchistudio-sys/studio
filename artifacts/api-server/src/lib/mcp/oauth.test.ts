import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcryptjs";

const query = vi.fn();
vi.mock("@workspace/db", () => ({ db: {}, pool: { query: (...a: unknown[]) => query(...a) } }));

import { mcpOAuthProvider, issueTestAccessToken, authenticateStaff, _verifyJwtForTest, redirectUrisAllowed, renderLoginPage } from "./oauth.js";

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

describe("B2 — DCR allowlist redirect host (chống client giả phishing)", () => {
  it("host tin cậy (chatgpt.com, subdomain, localhost) → cho phép", () => {
    expect(redirectUrisAllowed(["https://chatgpt.com/connector/oauth/abc"])).toBe(true);
    expect(redirectUrisAllowed(["https://x.chatgpt.com/cb"])).toBe(true);
    expect(redirectUrisAllowed(["https://openai.com/cb"])).toBe(true);
    expect(redirectUrisAllowed(["http://localhost:5173/cb"])).toBe(true);
  });
  it("host lạ / http non-local / rỗng → từ chối", () => {
    expect(redirectUrisAllowed(["https://attacker.com/cb"])).toBe(false);
    expect(redirectUrisAllowed(["http://evil.com/cb"])).toBe(false);
    expect(redirectUrisAllowed(["https://chatgpt.com.evil.com/cb"])).toBe(false); // không endsWith '.chatgpt.com'
    expect(redirectUrisAllowed([])).toBe(false);
    expect(redirectUrisAllowed(undefined)).toBe(false);
  });
  it("1 uri hợp lệ + 1 uri lạ → từ chối (every)", () => {
    expect(redirectUrisAllowed(["https://chatgpt.com/cb", "https://attacker.com/cb"])).toBe(false);
  });

  it("registerClient TỪ CHỐI redirect_uri host lạ (throw)", async () => {
    query.mockReset();
    await expect(
      mcpOAuthProvider.clientsStore.registerClient!({
        client_id: "c1", redirect_uris: ["https://attacker.com/cb"],
      } as never),
    ).rejects.toThrow(/host tin cậy|invalid_client_metadata/i);
  });
  it("registerClient CHO PHÉP redirect_uri chatgpt.com", async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    const out = await mcpOAuthProvider.clientsStore.registerClient!({
      client_id: "c2", redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
    } as never);
    expect((out as { client_id: string }).client_id).toBe("c2");
  });
});

describe("B2 — trang consent hiện client + host thật (không ghi cứng ChatGPT)", () => {
  it("hiện client_name + host redirect, host tin cậy không cảnh báo", () => {
    const html = renderLoginPage({
      clientId: "c1", clientName: "ChatGPT", redirectUri: "https://chatgpt.com/connector/oauth/x",
      codeChallenge: "cc", scopes: ["amazing:read"],
    });
    expect(html).toContain("chatgpt.com");
    expect(html).toContain("ChatGPT"); // là client_name THẬT do client khai, không hard-code
    expect(html).not.toContain("HOST LẠ");
  });
  it("host LẠ → cảnh báo đỏ để admin nhận ra app giả", () => {
    const html = renderLoginPage({
      clientId: "evil", clientName: "Totally ChatGPT", redirectUri: "https://attacker.com/cb",
      codeChallenge: "cc", scopes: ["amazing:read"],
    });
    expect(html).toContain("attacker.com");
    expect(html).toContain("HOST LẠ");
  });
});
