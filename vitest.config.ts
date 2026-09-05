import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@baaki/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
});
