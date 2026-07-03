// SPDX-License-Identifier: Apache-2.0
/**
 * Dedicated live-tier Vitest config — the fix for the live-tier
 * daemon-concurrency flake, for gate reliability.
 *
 * Mirrors `test/vitest.config.ts` (the integration project) for the `@comis/*`
 * dist-alias map, `globalSetup`, the `forks` pool, timeouts, and the
 * `COMIS_REPO_ROOT` env — but adds the one piece the flake todo needs:
 *
 *   test.fileParallelism: false
 *
 * Without it, ~6+ daemon-booting `test/live/**` scenario files run in parallel
 * vitest forks → 6+ daemons boot simultaneously → intermittent boot/port-free
 * timeout flakes on a single host (the symptom this config addresses; it worsens
 * as more daemon-booting scenarios are added). `fileParallelism: false`
 * runs the live files SEQUENTIALLY so daemons don't oversubscribe the host —
 * reliable, slightly slower — making `pnpm test:live` repeatable WITHOUT the
 * manual `--no-file-parallelism` flag the gate previously required. `retry: 1`
 * is kept for the residual daemon-boot transient.
 *
 * Path note: this config lives at `test/live/`, TWO levels below the repo root
 * (vs `test/vitest.config.ts` at one level), so `packages` and `globalSetup`
 * resolve from `../../` / `../` respectively.
 *
 * @module
 */
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(__dirname, "../../packages");

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
      // Three skills subpath entries.
      // ORDER MATTERS: Vite alias matching is prefix-based with `/` separator
      // semantics, so the most-specific subpaths MUST come BEFORE the bare
      // `@comis/skills` alias -- otherwise `@comis/skills/tools` would be
      // matched as bare-prefix + `/tools` and routed to the `.` subpath
      // target. Required for daemon's setup-tools.ts (which imports from
      // `@comis/skills/tools`).
      "@comis/skills/platform-tools": resolve(packages, "skills/dist/platform-tools/index.js"),
      "@comis/skills/tools": resolve(packages, "skills/dist/tools/index.js"),
      "@comis/skills": resolve(packages, "skills/dist/skills/index.js"),
      "@comis/orchestrator": resolve(packages, "orchestrator/dist/index.js"),
      "@comis/observability": resolve(packages, "observability/dist/index.js"),
      "@comis/cli": resolve(packages, "cli/dist/index.js"),
    },
  },
  // globalSetup + include are resolved relative to Vitest's `root`, which is the
  // invocation cwd (the repo root, where `pnpm test:live` runs) — NOT this config
  // file's dir. So they use the SAME repo-root-relative paths as
  // test/vitest.config.ts. (Only the JS `resolve(__dirname, …)` alias/env paths
  // above are config-file-relative — those DO use ../../.)
  test: {
    globalSetup: ["./test/support/global-setup.ts"],
    // Live-tier scope only — the deterministic Stage-A/B + the env-gated
    // Stage-C/operator scenarios under test/live/**.
    include: ["test/live/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    pool: "forks",
    maxConcurrency: 1,
    // THE flake fix: run live files sequentially so daemon-booting scenarios
    // do not oversubscribe the host (the live-tier daemon-concurrency
    // flake). This replaces the manual `--no-file-parallelism` flag.
    fileParallelism: false,
    retry: 1,
    env: {
      // Repo root, exposed to test daemon configs as ${COMIS_REPO_ROOT}.
      COMIS_REPO_ROOT: resolve(__dirname, "../.."),
    },
  },
});
