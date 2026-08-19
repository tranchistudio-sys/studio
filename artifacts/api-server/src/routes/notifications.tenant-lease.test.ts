import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const release = vi.fn();
const retain = vi.fn(() => ({ context: {}, release }));
const sendPush = vi.fn();

vi.mock("@workspace/db", () => ({
  db: { execute },
}));
vi.mock("@workspace/db/schema", () => ({
  notificationsTable: {},
  staffTable: {},
}));
vi.mock("../lib/tenant-scope", () => ({
  currentTenantScope: () => "tenant-a",
}));
vi.mock("../platform/tenant-database-router", () => ({
  retainCurrentTenantDatabaseLease: retain,
}));
vi.mock("./web-push", () => ({ sendPushToStaff: sendPush }));
vi.mock("./auth", () => ({ verifyToken: vi.fn() }));
vi.mock("../lib/legacy-auth-token", () => ({ readLegacyToken: vi.fn() }));
vi.mock("../platform/session", () => ({ watchPlatformSessionValidity: vi.fn() }));

describe("emitNotification tenant lease", () => {
  beforeEach(() => {
    process.env.PLATFORM_DATABASE_URL = "postgresql://platform";
    execute.mockResolvedValue({
      rows: [{
        id: 1,
        recipient_staff_id: null,
        sender_staff_id: null,
        type: "test",
        priority: "normal",
        title: "Test",
        body: "Body",
        link_type: "",
        link_id: null,
        booking_id: null,
        is_read: false,
        dedupe_key: null,
        created_at: new Date(),
      }],
    });
    release.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PLATFORM_DATABASE_URL;
  });

  it("retains the request lease until database and push work finish", async () => {
    let finishPush!: () => void;
    sendPush.mockReturnValue(new Promise<void>((resolve) => { finishPush = resolve; }));
    const { emitNotification } = await import("./notifications");

    emitNotification({ staffId: null, type: "test", title: "Test", message: "Body" });

    await vi.waitFor(() => expect(sendPush).toHaveBeenCalledOnce());
    expect(retain).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    finishPush();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});
