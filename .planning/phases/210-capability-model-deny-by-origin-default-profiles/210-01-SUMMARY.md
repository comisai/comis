---
phase: 210-capability-model-deny-by-origin-default-profiles
plan: 01
subsystem: security
tags: [capability, authorization, rpc, audit, closed-union, deny-by-origin, internal-fields]

# Dependency graph
requires:
  - phase: (none — wave 1, depends_on [])
    provides: pre-existing @comis/core security primitives (audit.ts closed-union idiom, sub-agent-tool-denylist @allow-throw error class, internals.ts stripInternalFields)
provides:
  - "AGENT_CAPABILITIES — the closed orch:* capability union (10 members) + AgentCapability type"
  - "checkCapability(held, required) — pure non-wildcard membership predicate (the deliberate divergence from checkScope's *-implies-all)"
  - "requireCapability(held, required) — the §3.7 handler-boundary gate, throws CapabilityDeniedError"
  - "CapabilityDeniedError — @allow-throw error discriminated by kind='capability_denied'"
  - "_capabilities — the 16th INTERNAL_FIELD_NAMES entry (stripped from external callers so caps cannot be forged)"
  - "capability_denied — a new AuditKind classified as a security signal"
  - "capability-scope-disjoint.test.ts — the CAP-01/CAP-02 arch-test (Scope ∩ AgentCapability = ∅; no member implies admin/rpc/*)"
affects: [210-02 default-profiles, 210-04 in-process-bypass-close, 210-05 deny-by-origin, 211 lease-endpoint, 212 orchestrate-surface]

# Tech tracking
tech-stack:
  added: []  # no new dependencies — pure authorization-layer source (zod/typescript/vitest already in-tree)
  patterns:
    - "Closed-union-from-const-array + const _exhaustive: never guard (AGENTS §2.8) — copied from audit.ts to AGENT_CAPABILITIES and the new AuditKind"
    - "@allow-throw handler-boundary error class (mirrors RequiredToolsUnreachableError) — pure predicate (checkCapability) vs throwing gate (requireCapability)"
    - "Import-the-runtime-value + assert-a-set-relation arch-test with a `satisfies readonly Scope[]` drift guard"

key-files:
  created:
    - packages/core/src/security/capability.ts
    - packages/core/src/security/capability.test.ts
    - test/architecture/capability-scope-disjoint.test.ts
  modified:
    - packages/core/src/api-contracts/internals.ts
    - packages/core/src/api-contracts/internals.test.ts
    - packages/core/src/security/audit.ts
    - packages/core/src/security/audit.test.ts
    - packages/core/src/security/index.ts
    - packages/core/src/exports/security.ts

key-decisions:
  - "Named the type AgentCapability (not Capability) — verified collisions with CapabilityId/ChannelCapability/CapabilityDescriptor"
  - "checkCapability is a plain held.includes(required) with NO wildcard branch — least-privilege by construction (CAP-02)"
  - "orch:browse is in the union but OFF in every default profile (Plan 02 owns defaults); the union must still contain it so the type is total"
  - "The capability_denied AuditKind's GREEN proof is the build itself — the const _exhaustive: never guard fails until the switch branch is added"

patterns-established:
  - "Pattern: a security primitive lives in @comis/core/security so daemon (handlers) + agent (tool-assembly) import it with no package cycle"
  - "Pattern: a new dispatcher-injected control field is registered in INTERNAL_FIELD_NAMES (not modeled in any contract request) so it is stripped, not declared"

requirements-completed: [CAP-01, CAP-02, CAP-05]

# Metrics
duration: 10min
completed: 2026-06-22
---

# Phase 210 Plan 01: Capability model foundation Summary

**The net-new capability primitive — a closed `AgentCapability` orch:* union, a non-wildcard `checkCapability` predicate, the `requireCapability` handler-boundary gate, and `CapabilityDeniedError` — plus the 16th internal field `_capabilities`, a `capability_denied` AuditKind, and the CAP-01/CAP-02 disjointness arch-test that everything else in Phase 210 imports.**

## Performance

- **Duration:** ~10 min (active execution; excludes the one-time `pnpm install` in the fresh worktree)
- **Started:** 2026-06-22T22:23Z (worktree dependency install)
- **Completed:** 2026-06-22T22:33Z
- **Tasks:** 3 (all TDD, RED→GREEN)
- **Files modified:** 9 (3 created, 6 modified)

## Accomplishments
- `AGENT_CAPABILITIES` closed 10-member `orch:*` union + inferred `AgentCapability` type (single-source-of-truth, AGENTS §2.8).
- `checkCapability` pure membership predicate with **no wildcard branch** (the deliberate CAP-02 divergence from `checkScope`'s `*`-implies-all), `requireCapability` §3.7 boundary gate, and `CapabilityDeniedError` (`@allow-throw`, `kind='capability_denied'`).
- `_capabilities` registered as the 16th `INTERNAL_FIELD_NAMES` entry — `stripInternalFields` now projects it away from external WS/REST callers (caps cannot be forged; T-210-02).
- `capability_denied` added to `AUDIT_KINDS` and classified a security signal; the `const _exhaustive: never` guard made the build the structural proof (T-210-03).
- Symbols re-exported from the `@comis/core` root barrel; CAP-01/CAP-02 arch-test proves `Scope ∩ AgentCapability = ∅` and no member implies admin/rpc/* against the **live** union (also proving the barrel wiring).

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1: AgentCapability union + checkCapability/requireCapability + CapabilityDeniedError** — `f0ed91da` (test, RED) → `34b90e4d` (feat, GREEN)
2. **Task 2: _capabilities internal field + capability_denied AuditKind + barrels** — `6c6322f5` (test, RED) → `31df1fd1` (feat, GREEN)
3. **Task 3: CAP-01/CAP-02 disjointness arch-test** — `90bab581` (test; RED+GREEN combined — the import cannot resolve against pre-Task-1 code, AGENTS §2.10; genuine-RED verified by stripping the dist export)

_No separate plan-metadata commit: STATE.md / ROADMAP.md are owned by the orchestrator after the wave merges (per the plan's constraint)._

## Files Created/Modified
- `packages/core/src/security/capability.ts` (NEW) — AGENT_CAPABILITIES, AgentCapability, checkCapability, requireCapability, CapabilityDeniedError.
- `packages/core/src/security/capability.test.ts` (NEW) — 10 unit cases: held/missing/wildcard-absent + error discriminant.
- `test/architecture/capability-scope-disjoint.test.ts` (NEW) — CAP-01 empty-intersection, CAP-02 no-implication + static no-wildcard source guard, with a `satisfies readonly Scope[]` drift guard.
- `packages/core/src/api-contracts/internals.ts` — added `_capabilities` (16th field, alphabetical) + docstring 15→16.
- `packages/core/src/api-contracts/internals.test.ts` — strip-projects-`_capabilities` assertion + length 16.
- `packages/core/src/security/audit.ts` — `capability_denied` AUDIT_KINDS member + `kindIsSecuritySignal` branch.
- `packages/core/src/security/audit.test.ts` — `kindIsSecuritySignal('capability_denied') === true` + AUDIT_KINDS membership.
- `packages/core/src/security/index.ts` — barrel re-export of the capability symbols.
- `packages/core/src/exports/security.ts` — `@comis/core` root barrel re-export.

## Decisions Made
- **Type name `AgentCapability`** (not bare `Capability`) — `CapabilityId`/`CapabilityDescriptor` (`config/capability-activation.ts`), `ChannelCapability` (`domain/channel-capability.ts`), `CapabilitySourceRef` (`ports/tool-capability.ts`) already exist; bare `Capability` would collide on import.
- **`checkCapability` has no wildcard branch** — a plain `held.includes(required)`. Copying `checkScope` verbatim would fail the CAP-02 arch-test; the no-lattice/no-`*` shape is the least-privilege guarantee.
- **`capability_denied` GREEN proof is the build** — the `const _exhaustive: never` exhaustiveness guard fails compilation until the switch branch classifies the new member; the unit test additionally pins it at the test level.
- **`orch:browse` is in the union but OFF in every default profile** — Plan 02 owns profile defaults; the union must still contain the member so `AgentCapability` is total.

## Deviations from Plan

None — plan executed exactly as written. No deviation rules (1–4) were triggered; no auth gates; no architectural decisions.

## Issues Encountered
- **Fresh worktree had no `node_modules` and no `dist/`.** The worktree was created at the wave base without `pnpm install`/build. Resolved by running `pnpm install` once, then building `@comis/shared` (a `@comis/core` dependency) before `@comis/core` so project-reference types (`@comis/shared` TS2307) resolved. Not a code change — environment bootstrap.
- **Incremental `tsc` does not re-emit dist after a hand-mutated dist file.** While proving the Task 3 RED, I temporarily stripped the `AGENT_CAPABILITIES` export from the *compiled* `dist/security/index.js`; `tsc` keyed off the unchanged *source* mtime and skipped re-emitting it. Resolved by `rm -rf packages/core/dist *.tsbuildinfo && pnpm --filter @comis/core build` to force a clean re-emit. The final dist is fully restored (verified: 10 caps, 16 internal fields) — relevant only to local verification, no shipped artifact affected (`dist/` is gitignored).

## Threat surface
No new trust-boundary surface beyond the plan's `<threat_model>`. The four registered threats (T-210-01 EoP via wildcard, T-210-02 spoofed `_capabilities`, T-210-03 unaudited denial, T-210-04 admin-implying union member) are each mitigated and arch-test- or build-proven, exactly as the register specifies.

## Known Stubs
None. `capability.ts`, the predicate, the error, the union, and the arch-test are fully wired — no placeholder/empty-stub/TODO patterns. (The `orch:browse`-OFF-in-profiles behavior is Plan 02's scope by design, not a stub here: the union member exists and is type-total.)

## Next Phase Readiness
- The predicate, union, error, the 16th internal field, the AuditKind, and the disjointness arch-test are all in place and GREEN — Plan 02 (default profiles → `resolveAutonomy`), Plan 04 (close the in-process bypass; inject `_capabilities` in `createAgentRpcCall`), and Plan 05 (deny-by-origin emitting `capability_denied`) can all import this foundation from `@comis/core`.
- `@comis/core` builds clean and the barrel exposes every symbol. No blockers.
- Verification not in scope for a per-plan executor (orchestrator owns it post-merge): full `pnpm validate` (`build:clean` + `cycles` + `cycles:refs` + `lint:security` + `test:coverage`) and the docs-current MDX pages (`capability-model.mdx`, `autonomy.mdx`) called out in CONTEXT.md belong to the phase-level Docs/Validate plans, not this foundation plan.

## Self-Check: PASSED

- Created files exist: `packages/core/src/security/capability.ts`, `packages/core/src/security/capability.test.ts`, `test/architecture/capability-scope-disjoint.test.ts` — all FOUND.
- Commits exist: `f0ed91da`, `34b90e4d`, `6c6322f5`, `31df1fd1`, `90bab581` — all FOUND.
- STATE.md / ROADMAP.md NOT modified — confirmed.

---
*Phase: 210-capability-model-deny-by-origin-default-profiles*
*Completed: 2026-06-22*
