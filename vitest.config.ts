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
    // Roughly a dozen files now start a real Postgres container (via
    // packages/db/src/testing/harness.ts), which caches its container in a
    // module-level variable — one container per worker PROCESS, not one for
    // the whole run. Vitest's default is one
    // worker per CPU, so the default parallel run starts that many containers
    // at once, which starves Docker/Ryuk on this host and produces
    // nondeterministic "Test timed out in 15000ms" failures on container
    // startup — never a real assertion failure, and never the same file twice
    // in a row.
    //
    // A workspace split that serialized only the container-backed files
    // (fileParallelism: false in their own project) was tried first, since it
    // would keep the ~400 pure unit/component tests running at full
    // parallelism. It did not hold up: with the "unit" project's default
    // one-worker-per-CPU parallelism running at the same time, the "db"
    // project's single worker was still starved of scheduling time and its
    // container starts still occasionally exceeded 15s — reproduced directly,
    // not a theoretical concern. Serializing the whole suite is the version
    // that has actually run green, deterministically, repeatedly.
    fileParallelism: false,
  },
});
