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
    // Eight route test files call `vi.stubGlobal("fetch", ...)`. Vitest does
    // not undo a stubbed global on its own — `restoreAllMocks`/`resetMocks`
    // only affect mock functions, not globals replaced by `stubGlobal` — so
    // without this, a stub from one test file would otherwise leak into
    // whichever file runs next in the same worker. It works today only
    // because every file that stubs `fetch` re-stubs it before each of its
    // own tests; this is the backstop for the next test file that doesn't.
    unstubGlobals: true,
  },
});
