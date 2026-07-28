import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 60000,
    fileParallelism: true,
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
