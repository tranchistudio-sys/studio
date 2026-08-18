import { describe, expect, it } from "vitest";
import {
  installRuntimeConsoleRedaction,
  redactRuntimeLogString,
  sanitizeRuntimeLogValue,
} from "./runtime-log-redaction";

describe("runtime log redaction", () => {
  it("redacts bearer, JWT, database password and secret query values", () => {
    const raw = [
      "Bearer session-token-that-must-never-reach-logs",
      "postgresql://runtime_user:database-canary-password@db.internal/amazing",
      "credential=google-credential-canary",
      "?sig=signed-url-canary&token=session-canary",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signature-canary-value",
    ].join(" ");
    const redacted = redactRuntimeLogString(raw);
    for (const canary of [
      "session-token-that-must-never-reach-logs",
      "database-canary-password",
      "google-credential-canary",
      "signed-url-canary",
      "session-canary",
      "eyJhbGciOiJIUzI1NiJ9",
    ]) {
      expect(redacted).not.toContain(canary);
    }
  });

  it("redacts nested objects and Error metadata without serializing buffers", () => {
    const error = Object.assign(new Error("request token=error-canary"), {
      connectionString: "postgresql://user:error-db-canary@db/app",
      response: { headers: { authorization: "Bearer error-bearer-canary" } },
      payload: Buffer.from("private-proof-canary"),
    });
    const serialized = JSON.stringify(sanitizeRuntimeLogValue(error));
    expect(serialized).not.toContain("error-canary");
    expect(serialized).not.toContain("error-db-canary");
    expect(serialized).not.toContain("private-proof-canary");
  });

  it("wraps legacy console methods once and forwards only sanitized arguments", () => {
    const calls: unknown[][] = [];
    const fake = {
      debug: (...args: unknown[]) => calls.push(args),
      info: (...args: unknown[]) => calls.push(args),
      log: (...args: unknown[]) => calls.push(args),
      warn: (...args: unknown[]) => calls.push(args),
      error: (...args: unknown[]) => calls.push(args),
    } as unknown as Console;
    installRuntimeConsoleRedaction(fake);
    installRuntimeConsoleRedaction(fake);
    fake.error("cookie=raw-cookie-canary", { refresh_token: "refresh-canary" });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toMatch(/raw-cookie-canary|refresh-canary/);
  });
});
