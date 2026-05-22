---
phase: 55-gateway-web-observability-infra-cli-comis-deletions
plan: 02
subsystem: web
tags: [web, router, sidebar, lit, alias-deletion, bc-rem, spec-abs]
requires: []
provides:
  - "Direct sidebar->router routing for Overview (no alias hop)"
  - "Router interface without setQuery (zero-prod-caller SPA-side query mutator)"
  - "Hash router with no ROUTE_ALIASES indirection layer"
  - "Approvals route + sidebar item + app.ts wiring removed (BC-REM-15 partial)"
affects:
  - packages/web/src/components/shell/ic-sidebar.ts
  - packages/web/src/router.ts
  - packages/web/src/router.test.ts
  - packages/web/src/app.ts
  - packages/web/src/components/shell/ic-sidebar.test.ts
tech_stack:
  added: []
  patterns:
    - "Two-commit-ordering: retarget consumer BEFORE deleting the indirection (RESEARCH Pitfall 1)"
    - "Test-as-regression-coverage: pure deletion phase, no TDD; existing tests prove the deletion is safe"
key_files:
  created: []
  modified:
    - packages/web/src/components/shell/ic-sidebar.ts
    - packages/web/src/components/shell/ic-sidebar.test.ts
    - packages/web/src/router.ts
    - packages/web/src/router.test.ts
    - packages/web/src/app.ts
decisions:
  - "Sidebar test (ic-sidebar.test.ts) updated in Commit A even though plan task 1 only listed ic-sidebar.ts as modified — Rule 3 blocking fix: the test asserts a hardcoded nav-item count (24) that drops to 23 after the Approvals item is deleted, and asserts the existence of an Approvals badge that would no longer be rendered. Without the test update, pnpm validate fails between commits A and B (acceptance criterion 'pnpm vitest run packages/web/src/router.test.ts packages/web/src/components/shell/ic-sidebar.test.ts exits 0' would fail). Documented as deviation (Rule 3)."
  - "Preserved the badge type union 'pendingApprovals' on NavItem.badge in ic-sidebar.ts and the @property pendingApprovals on IcSidebar even though no nav item uses the badge name anymore. The property is still read by ic-topbar via .notificationCount in app.ts, and removing the type-union member is scope-creep relative to the plan must-haves."
  - "Preserved the stale JSDoc on ic-sidebar.ts:67 that lists 'approvals' as one of the badge sources. The comment is now slightly out of date relative to the live sidebar, but the property name still exists and the badge-type union still includes pendingApprovals — fixing the comment is scope-creep relative to the plan."
requirements_completed: [BC-REM-14, SPEC-ABS-06]
metrics:
  duration_minutes: 21
  commits: 2
  files_touched: 5
  insertions: 5
  deletions: 150
  net_loc: -145
  completed_date: 2026-05-22
---

# Phase 55 Plan 02: Web sidebar + router aliases Summary

**Two-commit deletion of the SPA's `ROUTE_ALIASES` redirect layer, the `Router.setQuery` zero-prod-caller mutator, and the `approvals` route wiring (route entry + sidebar item + app.ts lazy-import + render-case + tests). Sidebar retargeted to the canonical `observe/overview` route in commit A so the alias is no-op-safe to delete in commit B.**

## Performance

- **Duration:** 21 min
- **Started:** 2026-05-22T05:37:42Z
- **Completed:** 2026-05-22T05:58:42Z
- **Tasks:** 2 (Commit A, Commit B)
- **Files modified:** 5 (3 source + 2 test)

## Accomplishments

- BC-REM-14 satisfied: `ROUTE_ALIASES` const + alias-resolution loop deleted from `packages/web/src/router.ts`.
- SPEC-ABS-06 satisfied: `Router.setQuery` interface method + implementation deleted; 4 test-only callers in the `describe("setQuery", …)` block deleted.
- BC-REM-15 partial: approvals route entry deleted from `ROUTE_TABLE`, sidebar Approvals item deleted, `app.ts` lazy-import + render-case for `ic-approvals-view` deleted (the remaining BC-REM-15 work — `views/approvals.ts` + `views/approvals.test.ts` + `e2e/approvals.spec.ts` + LEGACY_ALIASES + rpc-registry shim + nav-bar — is plan 55-03's scope).
- Two-commit ordering enforced: sidebar Overview retarget (commit A) → router cleanup (commit B). Alias was operational throughout commit A so `pnpm validate` stayed green between commits.
- 7 router tests deleted (1 approvals route test + 2 route-aliases describe-block tests + 4 setQuery describe-block tests); 41 → 34 router tests, all green.

## Task Commits

| # | Commit | Task | Type |
|---|--------|------|------|
| 1 | `1c844106` | Task 1: Commit A — Retarget sidebar Overview + drop Approvals sidebar item | refactor |
| 2 | `2157079f` | Task 2: Commit B — Delete ROUTE_ALIASES + setQuery + approvals route + app.ts wiring + retarget tests | refactor |

## What Changed

### Task 1 / Commit A (`1c844106`): Retarget sidebar Overview + drop Approvals (BC-REM-14 prep, BC-REM-15 partial)

`packages/web/src/components/shell/ic-sidebar.ts`:
- Line 36: `{ route: "observe", label: "Overview", … }` → `{ route: "observe/overview", label: "Overview", … }`. Sidebar now navigates directly to the canonical hash; the alias becomes a no-op for this entry.
- Line 51: `{ route: "approvals", label: "Approvals", icon: "✓", badge: "pendingApprovals" }` deleted from the `Configure` section. Approvals UI is reached via the Security view's Pending Approvals / Approval Rules tabs per `approvals.ts` JSDoc.

`packages/web/src/components/shell/ic-sidebar.test.ts` (Rule 3 blocking fix, see Deviations):
- `it("renders nav items grouped under sections … = 24", …)` → `… = 23` (1 Home + 7 Operate + 6 Observe + **8** Configure + 1 Setup; Approvals removed from Configure).
- Deleted `it("shows badge count on Approvals item when pendingApprovals > 0", …)` and `it("hides badge on Approvals when pendingApprovals is 0", …)` — both selected the Approvals nav item by text and asserted on its badge; the item no longer exists.

`router.ts` was intentionally untouched in commit A. `ROUTE_ALIASES` still operational; the sidebar's direct `observe/overview` link bypasses it. `pnpm vitest run packages/web/src/router.test.ts packages/web/src/components/shell/ic-sidebar.test.ts` → 62/62 green between commits.

### Task 2 / Commit B (`2157079f`): Delete ROUTE_ALIASES + setQuery + approvals route + app.ts wiring + retarget tests

`packages/web/src/router.ts`:
- Lines 36-38: `setQuery(params: Record<string, string>): void;` removed from the `Router` interface.
- Line 86: `{ pattern: "approvals", view: "ic-approvals-view" }` removed from `ROUTE_TABLE`.
- Lines 162-170: `/** Route aliases for backward compatibility … */ const ROUTE_ALIASES: ReadonlyArray<…> = […]` deleted.
- Lines 210-223: alias-resolution `for (const alias of ROUTE_ALIASES) { … history.replaceState(…) … }` loop deleted from `resolveHash()`.
- Lines 253-261: `setQuery(params)` implementation removed from the returned `Router` object.

`packages/web/src/router.test.ts`:
- Lines 228-237: `it("#/approvals -> ic-approvals-view, …", …)` deleted (route entry gone).
- Lines 288-307: entire `describe("route aliases", …)` block deleted — both alias-redirect tests (`"#/observe alias redirects to #/observe/overview via replaceState"` and `"alias preserves query parameters during redirect"`). Alias mechanism no longer exists.
- Lines 349-393: entire `describe("setQuery", …)` block deleted — all 4 `setQuery` tests removed.
- Preserved: the canonical `#/observe/overview -> ic-observe-dashboard` test (line 184 in post-edit file) which proves the retarget works without alias indirection.

`packages/web/src/app.ts`:
- Line 44 in `VIEW_LOADERS`: `"ic-approvals-view": () => import("./views/approvals.js"),` removed (lazy-import path retired).
- Lines 570-571: `case "ic-approvals-view": return html\`<ic-approvals-view …></ic-approvals-view>\`;` removed from `_renderView` switch.

## Verification

| Acceptance criterion | Result |
|---|---|
| `grep -nE 'route:\s*"observe"'` packages/web/src/components/shell/ic-sidebar.ts → 0 | OK |
| `grep -nE 'route:\s*"observe/overview"'` packages/web/src/components/shell/ic-sidebar.ts → 1 | OK |
| `grep -nE 'route:\s*"approvals"'` packages/web/src/components/shell/ic-sidebar.ts → 0 | OK |
| `grep -n 'ROUTE_ALIASES'` packages/web/src/router.ts → 0 | OK |
| `grep -nE 'setQuery\s*[(:]'` packages/web/src/router.ts → 0 | OK |
| `grep -nE 'pattern:\s*"approvals"'` packages/web/src/router.ts → 0 | OK |
| `grep -n 'ic-approvals-view'` packages/web/src/app.ts → 0 | OK |
| `grep -n 'setQuery'` packages/web/src/router.test.ts → 0 | OK |
| `pnpm vitest run packages/web/src/router.test.ts` → 34/34 green (was 41; -7 deletions) | OK |
| `pnpm vitest run packages/web/src/components/shell/ic-sidebar.test.ts` → 21/21 green (was 23; -2 Approvals tests) | OK |
| `pnpm build --filter @comis/web` → built in 373ms | OK |
| `pnpm build` (full workspace project references) → green | OK |
| `pnpm test` (full workspace, 1311 test files / 24278 tests / 12 skipped) → green | OK |
| `pnpm cycles` → 0 circular deps | OK |
| `pnpm lint:security` → 1 PRE-EXISTING error (not introduced; see Deferred Issues) | RED (pre-existing only) |

## Decisions Made

1. **Sidebar test updated in commit A (Rule 3 blocking fix).** Plan task 1's acceptance criterion required `pnpm vitest run packages/web/src/components/shell/ic-sidebar.test.ts exits 0`, but the test asserted hardcoded values (`navItems.length === 24`, two Approvals-item badge tests) that became false after deleting the Approvals nav-item. The plan listed only `ic-sidebar.ts` in `<files>` for task 1, but updating the test in the same commit was the only way to satisfy the acceptance criterion and keep `pnpm validate` green between commits A and B. Documented as a Rule 3 deviation.
2. **Preserved `pendingApprovals` field + `"pendingApprovals"` badge-type union member.** The `@property pendingApprovals` on `IcSidebar` is still piped from `app.ts` to `ic-topbar.notificationCount` (`app.ts:413`); the global-state field and 10+ test cases reference it. Removing it is scope-creep relative to plan 55-02's must-haves; will land in 55-03 if/when the global-state field is retired.
3. **Preserved the stale "approvals" mention in the `IcSidebar` JSDoc** (line 67). The comment describes the badge-count plumbing in general terms ("agents, channels, sessions, approvals, and errors"); the `pendingApprovals` field and badge-name union still exist, just without a nav-item that uses them. Scope-creep to fix; left for 55-03.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Updated `ic-sidebar.test.ts` in Commit A**
- **Found during:** Task 1 acceptance check (`pnpm vitest run … ic-sidebar.test.ts`).
- **Issue:** The plan's task 1 `<files>` block listed only `packages/web/src/components/shell/ic-sidebar.ts`, but the test file asserted on properties of the now-deleted Approvals nav item:
  - `it("renders nav items grouped under sections (22 total: 1+7+6+9) plus 1 Setup = 24", …)` → after deletion the count is 23.
  - `it("shows badge count on Approvals item when pendingApprovals > 0", …)` and `it("hides badge on Approvals when pendingApprovals is 0", …)` selected the Approvals item by text and asserted on its badge; the item no longer exists.
- **Fix:** Updated the count from 24 to 23 (and the in-name title + inline comment to `8` Configure items); deleted the two Approvals-badge tests. The remaining 21 sidebar tests continue to assert on the Operate / Observe / Configure sections and other unrelated UI affordances.
- **Files modified:** `packages/web/src/components/shell/ic-sidebar.test.ts`.
- **Verification:** `pnpm vitest run packages/web/src/router.test.ts packages/web/src/components/shell/ic-sidebar.test.ts` → 62/62 green; followed by `pnpm test` showing 24278/24278 green at end of commit B.
- **Committed in:** `1c844106` (Task 1 / Commit A — same atomic commit as the sidebar source edit).

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep. The fix is the minimum-necessary edit to satisfy task 1's `pnpm vitest run … ic-sidebar.test.ts exits 0` acceptance criterion. The two-commit ordering invariant (sidebar before router) held.

## Deferred Issues

### Pre-existing lint:security error (out of scope; logged in deferred-items.md)

`packages/core/src/hooks/plugin-registry.ts:38` — `@typescript-eslint/no-empty-object-type` error on `export interface PluginRegistryOptions {}`. Introduced in commit `dca65926` (Phase 52 EVENT-CLEAN-07) via comment-annotated intent ("Reserved for future option keys; intentionally empty post-EVENT-CLEAN-07"). Pre-existence verified by `git checkout c700e5c0 -- packages/core/src/hooks/plugin-registry.ts && pnpm exec eslint …` reproducing the error on the spawn base.

Out of scope for plan 55-02 (touches `packages/web/src/{router,router.test,app,components/shell/ic-sidebar,components/shell/ic-sidebar.test}.ts` only). Logged at `.planning/phases/55-gateway-web-observability-infra-cli-comis-deletions/deferred-items.md` for a dedicated agent or Phase 55 cleanup commit.

## Issues Encountered

- Initial `pnpm validate` run flaked on `packages/channels/src/email/imap-lifecycle-branches.test.ts > "logs error and returns err when client.connect rejects"` with a 5004ms timeout. Re-running the test in isolation produced 11/11 green in 712ms; second full `pnpm test` produced 1311 test files / 24278 tests / 12 skipped (no failures). Flake is timing-sensitive (IMAP client connection-rejection branch); not related to plan 55-02. No follow-up needed.
- Worktree node_modules were missing after the `<worktree_branch_check>` `git reset --hard` — re-ran `pnpm install --frozen-lockfile --prefer-offline` before running any tests. ~17s of install time included in plan duration.

## Authentication Gates

None.

## Threat Surface Scan

No new threat surface introduced. All three threats in the plan's threat model are accepted-class (T-55-02-01 stale `#/observe` bookmark fall-through to default route; T-55-02-02 `setQuery` deletion REMOVES a SPA-side query-mutation surface; T-55-02-03 `#/approvals` bookmark fall-through to default route). All deletions reduce attack surface; no new endpoints, auth paths, file access patterns, or schema changes introduced. The sidebar-first ordering preserves operator navigability through the deletion sequence.

## Next Phase Readiness

- Plan 55-03 (`web-deprecated-views-and-shims`) can begin immediately. Plan 55-03's scope (per RESEARCH §"Recommended Plan Decomposition"): `nav-bar.ts` + `.test.ts`, `views/approvals.ts` + `.test.ts`, `e2e/approvals.spec.ts`, `api-client.ts:414-450` session.list tightening, `health-status.ts:119-125` LEGACY_ALIASES, `rpc-registry.ts` shim. None of these are touched by plan 55-02; file-disjoint with the SUMMARY changes here.
- The `pendingApprovals` field on global state is still live and pumped to `ic-topbar.notificationCount`. Removing it is a separate concern (Security-view consolidation work) and is not in any active plan.

## Self-Check

- **Commits exist on branch `worktree-agent-ac67d5b365e9a8f89`:**
  - `1c844106` (Task 1 / Commit A) — FOUND
  - `2157079f` (Task 2 / Commit B) — FOUND
- **Modified files exist with expected post-conditions:**
  - `packages/web/src/components/shell/ic-sidebar.ts` — FOUND (line 36 retargets to `observe/overview`; no Approvals nav item)
  - `packages/web/src/components/shell/ic-sidebar.test.ts` — FOUND (nav-item count 23; no Approvals-badge tests)
  - `packages/web/src/router.ts` — FOUND (no `ROUTE_ALIASES`; no `setQuery`; no `approvals` pattern entry)
  - `packages/web/src/router.test.ts` — FOUND (no `setQuery`; no `#/approvals` test; canonical `#/observe/overview` test preserved)
  - `packages/web/src/app.ts` — FOUND (no `ic-approvals-view` lazy-import or render case)
- **Verification commands all green:** see Verification table above.

## Self-Check: PASSED

---
*Phase: 55-gateway-web-observability-infra-cli-comis-deletions*
*Completed: 2026-05-22*
