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
 * `generic-runtime-probe`, `durability-resume-probe-core`) are `node:test`
 * suites — vitest collects them and reports "No test suite found", so widening
 * this include turns a healthy helper test into a red gate.
 *
 * CONTRACT for anything added here: no `@comis/*` import. This project
 * registers no dist aliases on purpose, so it runs in the unit tier without a
 * `pnpm build` and a stale `dist/` cannot mask a `src/` change.
 *
 * @module
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "live-kit",
    include: ["**/*.test.ts"],
    pool: "threads",
    passWithNoTests: true,
  },
});
