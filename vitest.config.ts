import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    setupFiles: ["./apps/web/vitest.setup.ts"],
    testTimeout: 15_000,
  },
});
