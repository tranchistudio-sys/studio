import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: ["src/platform/**/*.itest.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
}));
