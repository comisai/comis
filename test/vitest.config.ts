// SPDX-License-Identifier: Apache-2.0
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
      // Three skills subpath entries (per SKILLS-SPLIT-03; Phase 33).
      // ORDER MATTERS: Vite alias matching is prefix-based with `/` separator
      // semantics, so the most-specific subpaths MUST come BEFORE the bare
      // `@comis/skills` alias -- otherwise `@comis/skills/tools` would be
      // matched as bare-prefix + `/tools` and routed to the `.` subpath
      // target. Surfaced in Phase 33 Plan 03 when daemon's setup-tools.ts
      // started importing from `@comis/skills/tools` (Rule 3 fix).
      "@comis/skills/platform-tools": resolve(packages, "skills/dist/platform-tools/index.js"),
      "@comis/skills/tools": resolve(packages, "skills/dist/tools/index.js"),
      "@comis/skills": resolve(packages, "skills/dist/skills/index.js"),
      "@comis/orchestrator": resolve(packages, "orchestrator/dist/index.js"),
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
    env: {
      // Repo root, exposed to test daemon configs as ${COMIS_REPO_ROOT}.
      // Replaces hardcoded ${HOME}/Projects/comisai/comis in test-only YAMLs
      // so the integration suite is portable across CI runners, worktrees,
      // and contributor checkouts.
      COMIS_REPO_ROOT: resolve(__dirname, ".."),
    },
  },
});
