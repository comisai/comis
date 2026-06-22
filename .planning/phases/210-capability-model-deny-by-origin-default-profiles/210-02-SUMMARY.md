---
phase: 210-capability-model-deny-by-origin-default-profiles
plan: 02
subsystem: config
tags: [zod, autonomy, capability-model, named-profiles, security-posture, schema-leaf, arch-test]

# Dependency graph
requires:
  - phase: 210 (wave-base 0d7391e6)
    provides: PerAgentConfigSchema composition root (schema-agent-runtime.ts), the schema-agent leaf split + barrels, the section-registry-parity snapshot harness, the public-api-policy + file-size + no-backward-compat arch-gates
provides:
  - "AutonomyConfigSchema — a strictObject Zod leaf whose .default() resolves an omitted block to the `standard` posture (zero-config default + MIG-01 target)"
  - "AUTONOMY_PROFILES — the four §3.8 resolved cap/guard sets (assistant/standard/unattended/max), with unattended/max CLAMPED to standard's cap set in M1"
  - "resolveAutonomy(cfg?) — a PURE profile→§3.3-block resolver: floor-contained caps + per-surface-toggle caps, explicit-field override, per-cap autoApprovable bit"
  - "ResolvedAutonomy / ResolvedCapability / AgentCapability types + the AGENT_CAPABILITIES + STANDARD_FLOOR_CAPABILITIES vocabularies, exported from @comis/core"
  - "autonomy: defaulted on PerAgentConfigSchema (every agent now resolves a fully-defaulted standard block)"
  - "test/architecture/autonomy-profile-floor.test.ts — the PROFILE-02 floor-subset / guards-on / assistant-zero / max-clamp arch-test against the live resolver"
affects: [210-04 (cap injection — createAgentRpcCall reads resolveAutonomy for _capabilities), 210-06 (legible boot logging of the resolved profile/caps/ceiling), 211 (lease carries the resolved caps), 212 (orchestrate cap→tool map reuses AGENT_CAPABILITIES)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Self-contained config schema leaf: the orch:* vocabulary is defined locally in the leaf (no config→security package edge), keeping cycles:refs clean while the canonical security predicate stays in the security layer"
    - "Pure config→caps resolver (no env/clock/fs, AGENTS §2.2): profile downshift is driven by a preflight-result INPUT, not a live probe (the probe is Phase 211)"
    - "M1 clamp: unattended/max resolve to standard-equivalent caps + an `m1Notice` rather than over-granting caps whose enforcement floor is unbuilt"
    - "Per-cap autoApprovable bit modeled on ResolvedCapability so the §22.3 floor (orch:browse always-escalate) is machine-readable by Plan-04 auto-allow logic + the PROFILE-02 arch-test"
    - "Arch-test asserts set-relations against the COMPILED resolver from @comis/core (RED-state = an over-granting resolver, proven this session by injecting orch:browse into the max profile)"

key-files:
  created:
    - packages/core/src/config/schema-agent/schema-agent-autonomy.ts
    - packages/core/src/config/schema-agent/schema-agent-autonomy.test.ts
    - test/architecture/autonomy-profile-floor.test.ts
  modified:
    - packages/core/src/config/schema-agent/schema-agent-runtime.ts
    - packages/core/src/config/schema-agent/index.ts
    - packages/core/src/config/index.ts
    - packages/core/src/exports/config.ts
    - test/support/public-api-policy.ts
    - packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap

key-decisions:
  - "Defined AGENT_CAPABILITIES locally in the autonomy leaf instead of importing from the (not-yet-landed) Plan-01 security/capability.ts — Plan 02 declares depends_on: [] and must be self-sufficient; this also avoids a config→security package cycle (cycles:refs exit 0)"
  - "Modeled orch:message via the separate `message:` config block (origin-only), NOT as a member of the resolved `capabilities` array — so the PROFILE-02 arch-test's `capabilities ⊆ the eight floor caps` holds exactly, while origin/non-origin auto-approvability rides the message config (§3.5/§22.3)"
  - "autonomy: is .default(() => parse({})) NOT .optional() — §6.4: consumers always see a fully-defaulted standard block; a missing block resolving to standard IS the MIG-01 migration (an explicit grant, never a back-compat shim)"
  - "Tracked the new @comis/core exports in PUBLIC_API_POLICY (shrink-as-consumers-land), mirroring the OrchestrationConfigSchema Plans-02-05 precedent, since Plan 04/06 are the production consumers and aren't in this worktree"

patterns-established:
  - "Named-profile resolver: profile → full knob block, explicit field overrides the profile (progressive disclosure), guards always-on under autonomy-bearing profiles"
  - "Floor-subset arch-test guarding a security posture against future over-grant, asserted against the compiled runtime value"

requirements-completed: [PROFILE-01, PROFILE-02]

# Metrics
duration: 17min
completed: 2026-06-22
---

# Phase 210 Plan 02: Capability model + deny-by-origin + default profiles Summary

**The v8 §3.8 named-profile resolver: an `AutonomyConfigSchema` Zod leaf that defaults an omitted block to `standard` (the zero-config great-out-of-box posture + MIG-01 target), a pure `resolveAutonomy()` that expands `profile:` into the §3.3 cap/guard block with `unattended`/`max` clamped to standard-equivalent in M1, and the PROFILE-02 floor-subset arch-test — wired into `PerAgentConfigSchema` + the `@comis/core` barrels.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-06-22T19:25:02Z
- **Completed:** 2026-06-22T19:41:38Z
- **Tasks:** 3 (all TDD/auto; 6 commits)
- **Files created/modified:** 9 (3 created, 6 modified)

## Accomplishments
- `AutonomyConfigSchema` + `AUTONOMY_PROFILES` + the pure `resolveAutonomy()` resolver — zero-config → `standard`, `assistant` → zero orchestration surfaces, `unattended`/`max` CLAMPED to standard's caps + an "available in M2/M3" `m1Notice` (no silent over-grant), explicit-field override (progressive disclosure), and a per-cap `autoApprovable` bit (orch:browse `false` in every profile forever).
- `autonomy:` defaulted on `PerAgentConfigSchema` — every agent now resolves a fully-defaulted standard block; exported (`resolveAutonomy`, `AUTONOMY_PROFILES`, `AGENT_CAPABILITIES`, `STANDARD_FLOOR_CAPABILITIES`, the types) from `@comis/core`.
- The PROFILE-02 floor-subset arch-test (`test/architecture/autonomy-profile-floor.test.ts`) — asserts every profile's caps ⊆ the eight floor caps, no always-escalate cap is auto-allowable, standard/unattended/max ship the budget/rate/spawn ceiling ON, assistant has zero caps, and max ⊆ standard + notice. Its genuine RED state (an over-granting resolver) was proven by temporarily injecting `orch:browse` into the `max` profile (2 invariants flipped red) and reverted.

## Task Commits

Each task was committed atomically (TDD: test → feat; plus in-scope gate fixes):

1. **Task 1 RED: failing autonomy schema/resolver test** - `4bfaedad` (test)
2. **Task 1 GREEN: AutonomyConfigSchema + AUTONOMY_PROFILES + resolveAutonomy (PROFILE-01)** - `e3de96b7` (feat)
3. **Task 2: wire autonomy into PerAgentConfigSchema + @comis/core barrels** - `4555a217` (feat)
4. **Task 3: PROFILE-02 floor-subset arch-test** - `85205471` (test)
5. **Deviation: satisfy file-size + public-export-consumers gates** - `d374afb5` (chore)
6. **Deviation: static surface-toggle reads (drop object-injection warning)** - `e108c3a0` (refactor)

_No separate plan-metadata commit: STATE.md/ROADMAP.md are orchestrator-owned (per the plan objective), and `.planning/` is gitignored in this repo (user policy `feedback_no_planning_commits`: never `git add -f` a `.planning/` file) — this SUMMARY is written to the `.planning/` filesystem path but is NOT committed into the worktree branch. See "Issues Encountered" for the orchestrator note._

## Files Created/Modified
- `packages/core/src/config/schema-agent/schema-agent-autonomy.ts` (created, 361 lines) - The schema leaf: `AGENT_CAPABILITIES`/`STANDARD_FLOOR_CAPABILITIES` vocabularies, `AutonomyConfigSchema` (strictObject, `.default("standard")`), `AUTONOMY_PROFILES`, the pure `resolveAutonomy()`, and the `ResolvedAutonomy`/`ResolvedCapability` types.
- `packages/core/src/config/schema-agent/schema-agent-autonomy.test.ts` (created, 127 lines) - 14 cases: zero-config default, strictObject typo guard, the eight floor caps, assistant-zero, guards-on, origin-only message, unattended/max clamp + notice, explicit override, toggle→cap, resolver purity.
- `test/architecture/autonomy-profile-floor.test.ts` (created, 179 lines) - The PROFILE-02 arch-test (5 invariants) against the compiled resolver.
- `packages/core/src/config/schema-agent/schema-agent-runtime.ts` (modified) - `autonomy: AutonomyConfigSchema.default(...)` beside `skills` + the leaf import (condensed to keep the file ≤500 lines).
- `packages/core/src/config/schema-agent/index.ts` (modified) - export-star the new leaf.
- `packages/core/src/config/index.ts` + `packages/core/src/exports/config.ts` (modified) - re-export the autonomy symbols + types from `@comis/core`.
- `test/support/public-api-policy.ts` (modified) - track the new exports (Plan 04/06 are the production consumers).
- `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap` (modified) - regenerated; purely additive (18 new `agents.autonomy.*` field-metadata entries, zero removed).

## Decisions Made
- **Local cap vocabulary (not Plan-01 import).** Plan 02 is `depends_on: []` and Plan 01's `security/capability.ts` is not in this worktree; defining `AGENT_CAPABILITIES` locally in the leaf keeps the plan self-sufficient AND avoids a config→security package edge (`cycles:refs` exit 0). The strings are identical to the §3.8 table by construction.
- **`orch:message` rides the `message:` block, not the cap array.** Lets the arch-test's `capabilities ⊆ the eight floor caps` hold exactly while origin/non-origin auto-approvability is governed by `message.channels` (§3.5/§22.3).
- **`autonomy:` is `.default(...)`, not `.optional()`.** §6.4 + MIG-01: a missing block resolving to `standard` is an explicit grant, never a back-compat shim (the no-backward-compat arch-test stays green, the file is NOT added to its allowlist).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree had no node_modules / dependency dists**
- **Found during:** Task 1 (running the RED test)
- **Issue:** The parallel-executor worktree was a fresh checkout with no `node_modules` (no test runner), and `@comis/core` build needs its workspace deps built first (`@comis/shared` etc.).
- **Fix:** `pnpm install --prefer-offline` (14.8s, relinked from the store), then full `pnpm build` to populate all package dists (so the architecture project's dist-aliased imports resolve).
- **Verification:** `node_modules/.bin/vitest` runs; full `test/architecture` project 502/502 green.
- **Committed in:** N/A (environment setup, no source change).

**2. [Rule 1 - Bug] TS2339 on `base.m1Notice` (caught by tsc, not vitest's transpile)**
- **Found during:** Task 1 (build verification after the GREEN impl)
- **Issue:** `as const satisfies Record<...>` narrowed `AUTONOMY_PROFILES` to a 4-member literal union; `.m1Notice` is absent on the assistant/standard members, so `base.m1Notice` failed to typecheck.
- **Fix:** Widened the lookup to `const base: ProfileEntry = AUTONOMY_PROFILES[profileName]` (ProfileEntry has `m1Notice?`).
- **Verification:** `pnpm --filter @comis/core build` exits 0; the 14 unit cases stay green.
- **Committed in:** `e3de96b7` (Task 1 GREEN commit).

**3. [Rule 1 - Bug] file-size per-subdirectory cap (502 > 500 lines)**
- **Found during:** Task 3 (full architecture-project run)
- **Issue:** The autonomy field's 5-line docblock pushed `schema-agent-runtime.ts` to 502 lines, over the 500-line `schema-agent/` cap.
- **Fix:** Condensed the field docblock to one line → 496 lines (full rationale lives in the schema file's own docblock).
- **Verification:** `file-size.test.ts` green.
- **Committed in:** `d374afb5`.

**4. [Rule 3 - Blocking] public-export-consumers: new exports had no in-repo consumer**
- **Found during:** Task 3 (full architecture-project run)
- **Issue:** The new `@comis/core` autonomy exports have no in-repo consumer yet (Plan 04 cap injection + Plan 06 boot logging are the consumers, not in this worktree), tripping the public-export-consumers gate.
- **Fix:** Tracked them in `PUBLIC_API_POLICY` under `@comis/core` with a shrink-as-consumers-land rationale, mirroring the `OrchestrationConfigSchema` Plans-02-05 precedent.
- **Verification:** `public-export-consumers.test.ts` green.
- **Committed in:** `d374afb5`.

**5. [Rule 2 - Code quality] security/detect-object-injection warning on the dynamic toggle read**
- **Found during:** Final `lint:security` gate
- **Issue:** The `cfg?.[field]` dynamic per-surface-toggle access raised a `security/detect-object-injection` warning (provably safe — `field` is a typed `keyof`).
- **Fix:** Replaced the dynamic loop with explicit, statically-named field reads (`cfg?.web`/`analyze`/`write`/`browse`) over a typed tuple list — warning gone without an eslint-disable; behavior identical.
- **Verification:** `lint:security` on the file: 0 errors (the one remaining warning is the typed-Record `AUTONOMY_PROFILES[profileName]` lookup, which matches repo convention); PROFILE-01-S12 stays green.
- **Committed in:** `e108c3a0`.

---

**Total deviations:** 5 auto-fixed (2 blocking, 2 bug, 1 code-quality). **Impact on plan:** All in-scope and necessary; the design intent (resolver, schema, arch-test) is unchanged. No scope creep — the deviations are environment setup + policy-gate compliance for the exact files the plan specified.

## Issues Encountered
- **Worktree path vs shared-checkout path.** The Read tool initially resolved the plan/analog paths to the shared checkout; all Edit/Write operations were redirected to the worktree copy (`.claude/worktrees/agent-a93e93b99541d79ba/...`) per the worktree isolation guard. No content impact (the worktree mirrors the wave base).
- **SUMMARY commit vs `.planning/` gitignore (ORCHESTRATOR NOTE).** worktree-mode asks to commit the SUMMARY so it survives worktree removal, but `.planning/` is gitignored in this repo and the user policy `feedback_no_planning_commits` forbids `git add -f` on `.planning/` files. The hard user policy wins: this SUMMARY is written to the worktree `.planning/` filesystem path (and the same content was authored for the shared-checkout phase dir) but is NOT committed into the worktree branch. The six source/test commits (the load-bearing deliverable) ARE committed normally on the branch and will merge. **If the orchestrator needs the SUMMARY post-worktree-removal, read it from the shared-checkout `.planning/phases/210-.../210-02-SUMMARY.md` or capture it from this run's final message before removing the worktree.**
- **11 transient architecture-suite load failures** before the full build — `Cannot find package '@comis/observability'` etc. (the other package dists weren't compiled yet). Resolved by a full `pnpm build`; they were environmental, never caused by this change (zero failed assertions, only suite-load errors). Out-of-scope pre-existing `lint:security` errors (6, in unrelated files like `error-classifier.ts`) were left untouched per the scope boundary.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- **Plan 04 (cap injection):** `resolveAutonomy(agent.autonomy)` is ready to compute `_capabilities` in `createAgentRpcCall`; `ResolvedCapability.autoApprovable` is ready for the auto-allow door.
- **Plan 06 (legible boot logging):** the resolved `{ profile, capabilities, aggregateBudgetUsd, m1Notice }` is ready to log at boot.
- **PROFILE-03 (legible degrade) NOT in this plan** — the resolver is pure and the downshift is driven by a preflight-result INPUT; the bwrap/namespace probe + the `doctor` finding land in a later plan / Phase 211 (Pitfall 5 / Assumption A4). No `bwrap-provider.ts` was touched.
- **Caveat:** `AGENT_CAPABILITIES` is defined locally in the config leaf; when Plan 01's `security/capability.ts` lands, a future plan should reconcile the two vocabularies (the strings are identical — a single-source consolidation, not a behavior change).

---
*Phase: 210-capability-model-deny-by-origin-default-profiles*
*Completed: 2026-06-22*
