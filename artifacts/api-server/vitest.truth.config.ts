// Config RIÊNG cho Financial Truth Test (GĐ0): chạy trên DB THẬT qua `pnpm truth`,
// tách khỏi `pnpm test` thường (unit test mock DB). Alias giữ y hệt vitest.config.ts.
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@workspace/db/schema",
        replacement: path.resolve(__dirname, "../../lib/db/src/schema/index.ts"),
      },
      {
        // Subpath phải đứng TRƯỚC "@workspace/db" — itest máy cọc mount bookings router.
        find: "@workspace/db/additional-services",
        replacement: path.resolve(__dirname, "../../lib/db/src/additional-services.ts"),
      },
      {
        find: "@workspace/db",
        replacement: path.resolve(__dirname, "../../lib/db/src/index.ts"),
      },
      {
        find: "@workspace/api-zod",
        replacement: path.resolve(__dirname, "../../lib/api-zod/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/truth/**/*.itest.ts"],
    // DB thật + tuần tự để log ledger đọc được theo thứ tự
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
