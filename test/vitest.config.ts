import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(__dirname, "../packages");

export default defineConfig({
  resolve: {
    alias: {
      "@comis/daemon": resolve(packages, "daemon/dist/index.js"),
      "@comis/core": resolve(packages, "core/dist/index.js"),
      "@comis/shared": resolve(packages, "shared/dist/index.js"),
      "@comis/infra": resolve(packages, "infra/dist/index.js"),
      "@comis/agent": resolve(packages, "agent/dist/index.js"),
      "@comis/channels": resolve(packages, "channels/dist/index.js"),
      "@comis/gateway": resolve(packages, "gateway/dist/index.js"),
      "@comis/memory": resolve(packages, "memory/dist/index.js"),
      "@comis/scheduler": resolve(packages, "scheduler/dist/index.js"),
      "@comis/skills": resolve(packages, "skills/dist/index.js"),
      "@comis/cli": resolve(packages, "cli/dist/index.js"),
    },
  },
  test: {
    globalSetup: ["./test/support/global-setup.ts"],
    include: ["test/support/**/*.test.ts", "test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    pool: "forks",
    maxConcurrency: 1,
    retry: 1,
  },
});
