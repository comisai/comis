---
phase: 57-web-cleanup
plan: 02
subsystem: web
tags: [vite, tailwind, devdeps, pnpm-lock, web-cleanup, supply-chain]

# Dependency graph
requires:
  - phase: 57-web-cleanup
    provides: "code-review §DEPS-TRIM-02 audit (1 stray Tailwind utility class verified)"
provides:
  - "@comis/web devDependency closure shrunk by 2 direct deps (tailwindcss, @tailwindcss/vite) + 36 transitive packages"
  - "Vite build pipeline for @comis/web with no Tailwind plugin step (cleaner build, smaller node_modules)"
  - "app.css reduced to single import: @import './tokens.css'"
  - "<body> min-height behavior preserved via inline style (min-height: 100vh) instead of utility class"
affects:
  - 57-03-dup-cons-sse
  - 57-04-dup-cons-elapsed
  - "Future @comis/web edits (no Tailwind classes available anywhere in src/)"

# Tech tracking
tech-stack:
  added: []
  removed:
    - "tailwindcss@4.2.4 (devDep)"
    - "@tailwindcss/vite@4.2.4 (devDep)"
  patterns:
    - "Inline-style replacement for single-use utility classes when removing a build toolchain (preserves runtime behavior 1:1)"

key-files:
  created: []
  modified:
    - "packages/web/package.json (removed 2 devDeps)"
    - "packages/web/src/app.css (removed `@import 'tailwindcss';`)"
    - "packages/web/vite.config.ts (removed import + plugin invocation)"
    - "packages/web/src/index.html (removed `class='min-h-screen'`, appended `min-height: 100vh;` to inline style)"
    - "pnpm-lock.yaml (regenerated; 38 package entries removed from the resolved tree)"

key-decisions:
  - "Removed plugins: [] entirely from vite.config.ts (array would be empty) rather than leaving as plugins: [] for diff-minimalism"
  - "Replaced min-h-screen with min-height: 100vh inline (Tailwind v4's exact CSS rule for that utility)"
  - "Removed the entire class attribute from <body> rather than leaving class='' — clean HTML"

patterns-established:
  - "Tailwind v4 teardown: 3 source edits + 1 markup substitution + lockfile regen (no tailwind.config.js to delete in v4)"
  - "When @comis/web vite.config.ts aliases @comis/core to a single dist module, --filter @comis/web build requires @comis/core/dist/ to exist first — use `pnpm build` at root for topological order"

requirements-completed:
  - DEPS-TRIM-02

# Metrics
duration: 14min
completed: 2026-05-22
---

# Phase 57 Plan 02: Tailwind Toolchain Removal Summary

**Removed `tailwindcss@4.2.4` + `@tailwindcss/vite@4.2.4` devDeps from `@comis/web` (38 transitive packages dropped); replaced the one stray `min-h-screen` utility class with inline `min-height: 100vh`; `pnpm validate` green.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-05-22T10:44:41Z
- **Completed:** 2026-05-22T10:58:30Z
- **Tasks:** 3 (Task 1 read-only audit, Task 2 source edits, Task 3 lockfile + validate)
- **Files modified:** 5 (4 source + lockfile)

## Accomplishments

- Dropped `tailwindcss@4.2.4` and `@tailwindcss/vite@4.2.4` from `packages/web/package.json` devDependencies.
- Removed `@import "tailwindcss";` from `packages/web/src/app.css` — file is now a one-line `@import "./tokens.css";`.
- Removed `import tailwindcss from "@tailwindcss/vite"` and `plugins: [tailwindcss()]` from `packages/web/vite.config.ts`.
- Replaced `class="min-h-screen"` on `<body>` with `min-height: 100vh;` appended to the existing inline `style` attribute (1:1 CSS equivalent to what Tailwind v4 generated).
- Regenerated `pnpm-lock.yaml` — net **38 package entries removed** from the resolved tree (Tailwind + its transitive closure: lightningcss-* native bindings, postcss-related packages, etc.).
- Verified CI parity: `pnpm install --frozen-lockfile` exits 0 with "Lockfile is up to date".
- Verified web bundle: `pnpm --filter @comis/web build` exits 0 (139ms, 207 modules transformed, 27 lazy chunks emitted).
- Verified full validation chain: `pnpm validate` (= build + 23,958 tests + lint:security + cycles) exits 0.

## Task Commits

Each task was committed atomically:

1. **Task 1: Tailwind utility-class grep audit** — read-only, no commit (no files modified).
2. **Task 2: Edit the 4 source files (package.json, app.css, vite.config.ts, index.html)** — `64c0035b` (`refactor(57-02): remove Tailwind from @comis/web source files`)
3. **Task 3: Regenerate pnpm-lock.yaml + verify install + build + validate** — `cc7c9cfc` (`chore(57-02): regenerate pnpm-lock.yaml after Tailwind removal`)

_Note: Task 1 was a read-only sanity check (the audit grep). Per the plan's `<files>(none — read-only audit)</files>`, no commit was needed — the next task's commit implicitly establishes "audit passed → proceed"._

## Files Created/Modified

- `packages/web/package.json` — Removed 2 lines from `devDependencies`: `"@tailwindcss/vite": "4.2.4"` and `"tailwindcss": "4.2.4"`. Alphabetical ordering of remaining 6 devDeps preserved.
- `packages/web/src/app.css` — Removed line 2 (`@import "tailwindcss";`). File now has 1 import (`./tokens.css`) and stays as the entry stylesheet for the SPA.
- `packages/web/vite.config.ts` — Removed line 3 (`import tailwindcss from "@tailwindcss/vite";`) and the `plugins: [tailwindcss()],` line inside `defineConfig(...)`. The `plugins` key is gone entirely; the resolve alias for `@comis/core` and the proxy config are untouched.
- `packages/web/src/index.html` — Body tag changed from `<body style="background: var(--ic-bg); color: var(--ic-text);" class="min-h-screen">` to `<body style="background: var(--ic-bg); color: var(--ic-text); min-height: 100vh;">`. The `class` attribute is dropped entirely (it held only the single Tailwind utility); the inline style now carries the viewport-spanning min-height directly.
- `pnpm-lock.yaml` — Regenerated. Tailwind + transitive closure removed. Lockfile lines: 10,400 → 10,209 (−191 lines). Package entries: 2087 → 2049 (−38 packages).

## Verification Evidence

- `grep -c "tailwindcss" packages/web/package.json` → 0
- `grep -c "@tailwindcss/vite" packages/web/package.json` → 0
- `grep -c "tailwindcss" packages/web/src/app.css` → 0
- `grep -c "tailwindcss" packages/web/vite.config.ts` → 0
- `grep -c "min-h-screen" packages/web/src/index.html` → 0
- `grep -c "min-height: 100vh" packages/web/src/index.html` → 1
- `grep -c "class=" packages/web/src/index.html` → 0 (no class attributes on the body)
- Tailwind utility-class audit regex (post-edit) → **0 matches** across `packages/web/src/`
- `grep -c "name: tailwindcss$" pnpm-lock.yaml` → 0
- `pnpm install --frozen-lockfile` → exit 0, "Lockfile is up to date, resolution step is skipped"
- `pnpm --filter @comis/web build` → exit 0, 139ms, 207 modules, 27 lazy chunks
- `pnpm validate` → exit 0, **Test Files 1291 passed | Tests 23958 passed | 12 skipped**, lint **1615 warnings, 0 errors**, **No circular dependency found**

## Decisions Made

- **Removed the `plugins` array from `vite.config.ts` rather than leaving `plugins: []`.** The plan allowed either; the cleaner edit is to drop the key entirely since no other plugins are needed. Vite's `defineConfig` treats a missing `plugins` key identically to `plugins: []`.
- **Dropped the `class` attribute from `<body>` entirely instead of leaving `class=""`.** Empty class attributes are noise; cleanest HTML is no class attribute.
- **Did not delete `app.css`'s second line by truncating to 1 line.** The file was 3 lines (tokens import, tailwind import, trailing newline) — final state is 2 lines (tokens import + trailing newline). This is the minimum-diff change that preserves the file as a stylesheet entry point.
- **Used `pnpm build` (root) rather than chasing `--filter @comis/web build` standalone.** The `vite.config.ts` aliases `@comis/core` to `../core/dist/runtime/system-time.js` (L9-11); standalone web builds require core's `dist/` to exist first. Topological build at the root level resolves this naturally — this is a pre-existing pattern unrelated to Tailwind.

## Deviations from Plan

None - plan executed exactly as written.

The plan's three tasks (audit → edit 4 files → regenerate lockfile + validate) executed in the documented order with no rule-driven auto-fixes. All acceptance criteria matched exactly:

- Task 1 audit returned exactly 1 line (the expected `packages/web/src/index.html:13` with `class="min-h-screen"`).
- Task 2 edits matched the plan's diff snippets exactly (line-for-line equivalent to 57-RESEARCH.md §"Tailwind teardown — three-file diff").
- Task 3 lockfile regen produced the expected `--frozen-lockfile` parity, build success, and `pnpm validate` green.

## Issues Encountered

**1. `pnpm validate` first-run test flake (resolved by re-run; NOT a plan issue)**

- **What happened:** First run of `pnpm validate` failed with 1 test failure: `@comis/skills > exec-tool.test.ts:851 > uses spill file for persistence when output > ROLLING_BUFFER_MAX` — assertion `expected 94622 to be greater than 102400`. 23,957 of 23,958 tests passed.
- **Diagnosis:** The failing test is in `packages/skills/src/tools/builtin/exec-tool.test.ts`, completely unrelated to `@comis/web`, vite config, app.css, or `index.html`. The assertion was about runtime spill-file persistence size in an exec-tool — no dependency on Tailwind, build-time plugins, or any file changed by this plan. Re-running the test in isolation (`pnpm vitest run src/tools/builtin/exec-tool.test.ts -t "uses spill file for persistence"`) PASSED immediately. Two subsequent full `pnpm validate` runs PASSED clean (final exit 0, all 23,958 tests green).
- **Conclusion:** Pre-existing flake (parallel-worker I/O contention truncated the generated spill output to 94,622 bytes instead of the >102,400 the test expected). Per `<scope_boundary>`: this is out of scope (unrelated file, unrelated subsystem, and reproducibly passes on re-run). Logged here for visibility; no fix applied.
- **Recommendation:** A separate quick task could harden the test by writing a known-size payload rather than depending on generated output size, but that's a separate concern.

## Threat Surface

No runtime attack surface changes. Per the plan's `<threat_model>`:
- `T-57-02-01` (lockfile tampering) — accepted; `--frozen-lockfile` enforces integrity in CI.
- `T-57-02-02` (net negative surface) — accepted; removing the Tailwind devDep tree REDUCES supply-chain surface by 38 packages.

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The single inline-style substitution (`min-height: 100vh`) is functionally identical to Tailwind v4's generated rule.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **57-03 (DUP-CONS-04 SSE consolidation):** Unblocked. Touches `packages/web/src/api/api-client.ts` + `views/dashboard.ts` + 10 view test files. Disjoint from this plan's file set.
- **57-04 (DUP-CONS-07 formatElapsed):** Already landed in parallel (commits `41800ddd`, `e033e2df`, `88832da3`, `688a6d86` in this worktree's ancestor branch).
- **Future @comis/web edits:** No Tailwind classes are available — any future `class="..."` additions must use component-scoped Lit `css\`\`` blocks (the project's established pattern). The CSS Module-style classes already in place (`output-block`, `skeleton-block`, `hidden-input`, etc.) remain — they were never Tailwind, just project-local CSS class names.

## Self-Check: PASSED

- [x] `packages/web/package.json` exists and contains no `tailwindcss` / `@tailwindcss/vite` references.
- [x] `packages/web/src/app.css` exists and contains no `tailwindcss` import.
- [x] `packages/web/vite.config.ts` exists and contains no `tailwindcss` references.
- [x] `packages/web/src/index.html` exists with `min-height: 100vh` in the inline style and no `class` attribute on `<body>`.
- [x] `pnpm-lock.yaml` exists and contains no `tailwindcss` entries (0 matches for all three audit greps).
- [x] Commit `64c0035b` (Task 2 source edits) exists in git history.
- [x] Commit `cc7c9cfc` (Task 3 lockfile regen) exists in git history.
- [x] `pnpm install --frozen-lockfile` exits 0.
- [x] `pnpm --filter @comis/web build` exits 0.
- [x] `pnpm validate` exits 0 (after one transient unrelated flake, confirmed green in two subsequent full runs).

---
*Phase: 57-web-cleanup*
*Completed: 2026-05-22*
