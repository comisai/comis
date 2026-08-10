// SPDX-License-Identifier: Apache-2.0
/**
 * Self-driving kit unit project — the gate for the driver/oracle helpers under
 * `test/live/self-driving/scripts/**`.
 *
 * These files test the pure core of the kit a live campaign is driven WITH:
 * outbound/answer classification, session + trajectory path resolution, remote
 * root resolution, durable-resume candidate selection. They boot no daemon and
 * drive no emulator.
 *
 * Why a project of its own: the root config's `projects` list is what
 * `pnpm test` / `pnpm test:coverage` (and therefore `pnpm validate`) run. It
 * covered `packages/*`, `test/architecture`, `scripts/contracts` and
 * `test/live/bin` — so `drive-session-oracle.test.ts` and its neighbours here
 * matched NO project and ran in NO gate. They could pass by hand, land, and
 * then rot silently. That is not academic: the drive's progress classifier
 * discarded every answer whose text opened with a `✓`, which is the agent's own
 * Hebrew acknowledgement style, and turned three correctly-answered corpus rows
 * into FALSE FAILURES on a live campaign (comis-moshe, 2026-08-06).
 *
 * Include is `*.test.ts` ONLY. The `*.test.mjs` neighbours (`media-file-meta`,
 * `generic-runtime-probe`) are `node:test` suites — vitest collects them and
 * reports "No test suite found", so widening this include turns a healthy
 * helper test into a red gate.
 *
 * CONTRACT for anything added here: no `@comis/*` import. This project
 * registers no dist aliases on purpose, so it runs in the unit tier without a
 * `pnpm build` and a stale `dist/` cannot mask a `src/` change.
 *
 * `exclude` is that contract enforced rather than merely stated: a kit test
 * that genuinely needs a built package belongs to the integration tier, whose
 * config aliases every `@comis/*` to `packages/<pkg>/dist`. Collecting one here
 * cannot work — the repo root declares only `@comis/core`, so `@comis/memory`
 * resolves nowhere and the FILE fails to load, which reds the whole unit gate
 * regardless of whether a `dist/` exists.
 *
 * @module
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "live-kit",
    include: ["**/*.test.ts"],
    // Needs AppConfigSchema + offlineSecretGet to prove the generated config
    // validates and the gateway token really landed in the encrypted store.
    // Runs in the integration tier's aliased `live-scenarios` project instead.
    exclude: ["remote-root.test.ts"],
    // Several cases here decide a helper's behaviour by RUNNING it — the driver's
    // risk gate, the stdio fixtures, the redrive's argument handling — so a case
    // costs one or more `bash`/`node` spawns. Those subprocesses carry their own
    // 30s/60s budgets, which the runner's 5s default expires long before, and the
    // root config's four coverage-instrumented workers are exactly the scheduling
    // pressure that turns a correct-but-slow spawn into a red run. Give a case room
    // for the subprocess budget it already declares.
    testTimeout: 60_000,
    pool: "threads",
    passWithNoTests: true,
  },
});
