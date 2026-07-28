import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 60000,
    // Off on purpose: every suite starts its own Postgres container, and running
    // them in parallel exhausts Docker's port binding -- suites then fail with
    // "Timed out waiting for container ports to be bound to the host" depending
    // on machine load, which makes the suite unreliable rather than fast.
    // Measured on this repo: 64/64 in 64s sequential, vs. 4 suites failing in
    // 128s parallel. The containers contend for resources instead of overlapping.
    fileParallelism: false,
    maxWorkers: 1,
    exclude: [...configDefaults.exclude, "test/meta/field-contract.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      TESTCONTAINERS_RYUK_DISABLED: "true",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
