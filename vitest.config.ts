import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one Postgres instance. Running suites in parallel against the same
    // database would have them truncating each other's rows mid-assertion, producing failures that
    // look like race conditions in the code under test rather than in the test harness. Single file
    // at a time; within a file, tests are ordered and isolated by an explicit truncate.
    fileParallelism: false,
    // Vitest isolates each test file in its own module registry, so `prisma migrate deploy` runs once
    // per file — and a cold Prisma client import is itself several seconds. 30s was not enough for the
    // file that also boots an HTTP server and a WebSocket relay. This is a slow setup, honestly, and
    // budgeting for it is better than the alternative: a suite that intermittently fails in CI on a
    // loaded machine and gets marked flaky.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/**/*.test.ts"],
    },
  },
});
