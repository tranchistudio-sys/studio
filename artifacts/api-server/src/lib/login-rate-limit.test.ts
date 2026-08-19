import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLoginRateLimitForTests, createLoginRateLimit } from "./login-rate-limit";

describe("login rate limit", () => {
  beforeEach(() => clearLoginRateLimitForTests());

  it("chặn request vượt quá giới hạn theo IP", () => {
    const middleware = createLoginRateLimit({ windowMs: 60_000, maxAttempts: 2 });
    const req = { ip: "203.0.113.7", socket: {} } as any;
    const next = vi.fn();
    const status = vi.fn();
    const json = vi.fn();
    const res = {
      setHeader: vi.fn(),
      status: status.mockReturnValue({ json }),
    } as any;

    middleware(req, res, next);
    middleware(req, res, next);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });
});
