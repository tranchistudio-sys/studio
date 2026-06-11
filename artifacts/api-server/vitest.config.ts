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
