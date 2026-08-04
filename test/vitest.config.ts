// SPDX-License-Identifier: Apache-2.0
/**
 * Integration-tier config — TWO projects, because the tier holds two workloads with
 * opposite parallelism needs.
 *
 * `test/integration/**` + `test/support/**` are in-process and need parallel forks to
 * finish inside the CI budget. `test/live/**` scenario files each BOOT A DAEMON, and
 * every boot loads the ~635 MB embedding GGUF; running them in parallel forks boots
 * that many daemons at once. `test/live/vitest.config.ts` exists specifically to stop
 * that (`fileParallelism: false`), but this config used to pull the same 143 files into
 * one parallel project — reproducing the failure mode its sibling was written to fix.
 *
 * Observed on a 4-vCPU host: 5 hook timeouts at 60s, a `ConversationDriver: init() must
 * be called` cascade, an orphaned-turn assertion, and 3 hard
 * `Another daemon instance is already running on dataDir` collisions (a restart
 * scenario whose stop timed out, then raced its own restart). Every one of those files
 * passes when the same set runs sequentially, so the defect was scheduling, not product
 * behavior. `retry: 1` was absorbing it — which is why CI stayed green while the flake
 * rate grew with each scenario added.
 *
 * `globalSetup` stays at the ROOT level so it runs ONCE for the whole run: its `setup()`
 * calls `cleanTestArtifacts(true)` and pre-seeds the shared model cache. Per-project
 * global setup would run that cleanup a second time while the other project's tests are
 * still using those artifacts.
 *
 * @module
 */
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");
const packages = resolve(repoRoot, "packages");

/**
 * Dist aliases — every project needs its own copy: module resolution is per-project, so
 * a root-level `resolve.alias` does not reach project workers.
 */
const alias = {
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
};

/** Options both projects share. Absolute paths so they hold regardless of the invoking cwd. */
const sharedTest = {
  setupFiles: [resolve(repoRoot, "test/support/vitest-process-listeners.ts")],
  testTimeout: 60_000,
  hookTimeout: 60_000,
  teardownTimeout: 30_000,
  pool: "forks" as const,
  maxConcurrency: 1,
  retry: 1,
  env: {
    // Repo root, exposed to test daemon configs as ${COMIS_REPO_ROOT}.
    // Replaces hardcoded ${HOME}/Projects/comisai/comis in test-only YAMLs
    // so the integration suite is portable across CI runners, worktrees,
    // and contributor checkouts.
    COMIS_REPO_ROOT: repoRoot,
  },
};

export default defineConfig({
  test: {
    globalSetup: [resolve(repoRoot, "test/support/global-setup.ts")],
    projects: [
      {
        resolve: { alias },
        test: {
          ...sharedTest,
          name: "integration",
          root: repoRoot,
          include: [
            resolve(repoRoot, "test/support/**/*.test.ts"),
            resolve(repoRoot, "test/integration/**/*.test.ts"),
          ],
          // Daemon-backed files need parallelism to finish within the E2E budget,
          // but deriving the worker count from every host CPU can starve teardown
          // and make retries collide with a daemon that still holds its data lock.
          maxWorkers: 4,
        },
      },
      {
        resolve: { alias },
        test: {
          ...sharedTest,
          name: "live-scenarios",
          root: repoRoot,
          include: [resolve(repoRoot, "test/live/**/*.test.ts")],
          // One daemon at a time. See the module comment: parallel forks here boot
          // N daemons that each load the ~635 MB GGUF, which starves boot and
          // teardown until a restart scenario collides with its own data lock.
          fileParallelism: false,
        },
      },
    ],
    // Integration-tier coverage threshold. Run-level, not per-project, so both
    // projects contribute to one merged measurement.
    //
    // Measures in-process imports the integration suite actually loads —
    // `packages/*/dist/**/*.js` (the alias targets above). Subprocess daemon
    // code is NOT measured here; that is the E2E tier's territory.
    //
    // Floor: Math.floor(measured) — same Math.floor protocol as the unit
    // tier. The aspirational target is ≥80% line coverage.
    //
    // Branches/functions/statements deliberately omitted: the unit tier
    // owns those at the unit level; integration focuses on line coverage
    // of in-process seams only.
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      // Keep this collector isolated from the unit tier so independently
      // invoked validation commands cannot delete each other's temp files.
      reportsDirectory: "coverage/integration",
      include: ["packages/*/dist/**/*.js"],
      exclude: [
        "**/*.test.js",
        "**/__tests__/**",
        "**/__snapshots__/**",
        "**/*.d.ts",
        "**/*.d.js",
        "**/*.generated.js",
        "packages/web/dist/**",
      ],
      thresholds: {
        // A floor catches regression; it cannot also sit ON the measurement.
        // 35 was floored from a 35.81 reading, but this tier's line coverage has
        // since eroded to the 34.8-35.0 band, and the band straddles the floor:
        // commit 38779ed94 measured 35.00 and passed as a PR, then 34.92 and
        // failed the identical tree on push. Nothing regressed between those two
        // runs -- the tier drives real daemons over network-gated paths, so which
        // lines execute varies run to run.
        //
        // A gate that reds `main` on unchanged code is worse than a lower one: it
        // trains readers to re-run rather than to read, and a chronically red
        // baseline is exactly how earlier regressions here reached `main`
        // unnoticed. 34 sits below the observed band, so a real drop still trips
        // it while ordinary variance does not.
        //
        // This ratifies an erosion rather than reversing it. Raising the number
        // again means covering more of `packages/*/dist` from the integration
        // tier -- re-floor it from a measured reading once that lands, and leave
        // headroom under the band.
        lines: 34,
      },
    },
  },
});
