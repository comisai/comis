// SPDX-License-Identifier: Apache-2.0
/**
 * Harness-core unit project — the gate for `test/live/bin/**` pure unit tests.
 *
 * These files (`vps-emu-group-options.test.ts`, `chan.test.ts`) test the
 * side-effect-free core of the live-drive CLIs: argument/spec parsing, exit-code
 * mapping, validation. They boot no daemon and drive no emulator.
 *
 * Why a project of its own: the ROOT config's `projects` list is what
 * `pnpm test` / `pnpm test:coverage` (and therefore `pnpm validate`) actually
 * run, and it covered `packages/*`, `test/architecture`, `scripts/contracts`
 * only. `test/live/**` was reachable exclusively through
 * `test/live/vitest.config.ts`, which no gate invokes (`pnpm test:live` runs
 * `test/live/runner.ts`, which selects SCENARIO files). So a harness unit test
 * could pass by hand, land, and then never run again — the silent-rot class the
 * bare root config's `include: []` makes invisible (0 files → false green).
 *
 * CONTRACT for anything added here: no `@comis/*` import. This project
 * deliberately registers no dist aliases, so a test needing the BUILT runtime
 * cannot live here — it belongs under `test/live/vitest.config.ts` with the
 * alias map and the sequential daemon pool. Keeping this project alias-free is
 * what lets it run in the unit tier without a `pnpm build` first, and keeps a
 * stale `dist/` from masking a `src/` change.
 *
 * @module
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "live-harness",
    include: ["**/*.test.ts"],
    pool: "threads",
    passWithNoTests: true,
  },
});
