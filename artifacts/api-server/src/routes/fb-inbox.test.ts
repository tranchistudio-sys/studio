import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
}));
vi.mock("@workspace/db/schema", () => ({
  settingsTable: {},
  crmLeadsTable: {},
  customersTable: {},
}));
vi.mock("../lib/publicUrl.js", () => ({
  getPublicBaseUrl: () => "http://localhost",
}));
vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: {
    bucket: vi.fn(() => ({
      file: vi.fn(() => ({ save: vi.fn(), exists: vi.fn(() => [false]) })),
    })),
  },
  ObjectStorageService: class {
    getPrivateObjectDir() { return "/bucket/dir"; }
  },
}));
vi.mock("./auth.js", () => ({
  verifyToken: vi.fn(),
}));
vi.mock("./webhook-log.js", () => ({
  webhookEvents: { emit: vi.fn() },
}));
vi.mock("./ai-engine.js", () => ({
  splitIntoChunks: vi.fn(),
  naturalDelayMs: vi.fn(),
  loadQaRows: vi.fn(),
  matchQaRow: vi.fn(),
  buildStudioContext: vi.fn(),
  askChatGptForReply: vi.fn(),
  loadScriptSettings: vi.fn(),
  resolveImagePath: vi.fn(),
}));
vi.mock("multer", () => {
  const middleware = vi.fn((_req: unknown, _res: unknown, next: unknown) => (next as () => void)());
  const multerFn = vi.fn(() => ({ single: vi.fn(() => middleware) }));
  (multerFn as unknown as Record<string, unknown>).memoryStorage = vi.fn(() => ({}));
  return { default: multerFn };
});

import { formatImageMessage, parseImageMessage, resolveMessageTagLabel } from "./fb-inbox.js";

// ─── formatImageMessage ───────────────────────────────────────────────────────

describe("formatImageMessage", () => {
  it("wraps a URL in the [image:] format", () => {
    const url = "https://storage.googleapis.com/bucket/photo.jpg";
    expect(formatImageMessage(url)).toBe(`[image:${url}]`);
  });

  it("produces exactly the format the frontend parseMessageContent regex expects", () => {
    const url = "https://example.com/img.png";
    const msg = formatImageMessage(url);
    const frontendRegex = /^\[image:(.+)\]$/;
    const match = msg.match(frontendRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(url);
  });
});

// ─── parseImageMessage ────────────────────────────────────────────────────────

describe("parseImageMessage", () => {
  it("extracts the URL from a properly formatted image message", () => {
    const url = "https://storage.googleapis.com/bucket/photo.jpg";
    expect(parseImageMessage(`[image:${url}]`)).toBe(url);
  });

  it("returns null for plain text", () => {
    expect(parseImageMessage("Xin chào bạn!")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseImageMessage("")).toBeNull();
  });

  it("returns null when there is no URL after the colon", () => {
    expect(parseImageMessage("[image:]")).toBeNull();
  });

  it("round-trips with formatImageMessage", () => {
    const url = "https://cdn.example.com/staff-sent-image.webp";
    expect(parseImageMessage(formatImageMessage(url))).toBe(url);
  });
});

// ─── resolveMessageTagLabel — staff attribution ───────────────────────────────

describe("resolveMessageTagLabel — manual_sent (text)", () => {
  it("shows the staff name when sent_by is set", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_sent", "Nguyễn Văn A")).toBe("Nguyễn Văn A");
  });

  it("falls back to Nhân viên when sent_by is null", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_sent", null)).toBe("Nhân viên");
  });

  it("falls back to Nhân viên when sent_by is empty string", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_sent", "")).toBe("Nhân viên");
  });
});

describe("resolveMessageTagLabel — manual_image (image)", () => {
  it("shows the staff name when sent_by is set", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_image", "Trần Thị B")).toBe("Trần Thị B");
  });

  it("falls back to Nhân viên when sent_by is null", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_image", null)).toBe("Nhân viên");
  });

  it("falls back to Nhân viên when sent_by is empty string", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_image", "")).toBe("Nhân viên");
  });
});

describe("resolveMessageTagLabel — manual_sent vs manual_image are identical", () => {
  const staffName = "Phạm Văn C";
  it("shows the same label for manual_sent and manual_image when sent_by is set", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_sent", staffName))
      .toBe(resolveMessageTagLabel("outgoing", "manual_image", staffName));
  });

  it("shows the same fallback for manual_sent and manual_image when sent_by is null", () => {
    expect(resolveMessageTagLabel("outgoing", "manual_sent", null))
      .toBe(resolveMessageTagLabel("outgoing", "manual_image", null));
  });
});

describe("resolveMessageTagLabel — other decision types", () => {
  it("returns AI for auto_replied messages", () => {
    expect(resolveMessageTagLabel("outgoing", "auto_replied", null)).toBe("AI");
    expect(resolveMessageTagLabel("outgoing", "auto_replied_pricing", null)).toBe("AI");
  });

  it("returns the staff name for page_sent messages that have sent_by", () => {
    expect(resolveMessageTagLabel("outgoing", "page_sent", "Lê Văn D")).toBe("Lê Văn D");
  });

  it("returns null for page_sent messages without sent_by (Facebook Inbox native)", () => {
    expect(resolveMessageTagLabel("outgoing", "page_sent", null)).toBeNull();
  });

  it("returns null for incoming messages regardless of ai_decision", () => {
    expect(resolveMessageTagLabel("incoming", "manual_sent", "Staff")).toBeNull();
    expect(resolveMessageTagLabel("incoming", null, null)).toBeNull();
  });

  it("falls back to Nhân viên for unknown outgoing types with no sentBy", () => {
    expect(resolveMessageTagLabel("outgoing", "some_unknown_type", null)).toBe("Nhân viên");
  });

  it("shows sentBy for unknown outgoing types when sentBy is present", () => {
    expect(resolveMessageTagLabel("outgoing", "some_unknown_type", "Nguyễn A")).toBe("Nguyễn A");
  });

  it("falls back to Nhân viên when aiDecision is null for outgoing messages", () => {
    expect(resolveMessageTagLabel("outgoing", null, null)).toBe("Nhân viên");
  });
});
