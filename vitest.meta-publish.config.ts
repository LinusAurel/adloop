import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 60000,
    fileParallelism: false,
    maxWorkers: 1,
    include: ["test/meta/publish-sandbox.test.ts"],
    exclude: configDefaults.exclude,
    env: {
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
