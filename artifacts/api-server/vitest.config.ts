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
        // Subpath phải đứng TRƯỚC "@workspace/db" (khớp cụ thể hơn) — nếu không alias
        // gốc nuốt mất, vitest không resolve được (bookings.test import từ đây).
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
  },
});
