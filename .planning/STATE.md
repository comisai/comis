---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: MCP Hardening II
status: executing
stopped_at: v1.2 roadmap created
last_updated: "2026-05-27T17:35:24.802Z"
last_activity: 2026-05-27
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 8
  completed_plans: 6
  percent: 75
---

# Project State: Comis

**Last Updated:** 2026-05-27
**Reference:** `.planning/PROJECT.md`

## Project Reference

**Project:** Comis — security-first AI agent platform connecting agents to 9 chat channels. TypeScript monorepo, 15 packages, hexagonal architecture, Node.js ≥ 22, Linux-only.

**Core value:** A fleet-wide bug must be diagnosable from one structured artifact with one command in under five minutes.
**Current focus:** Phase 2 — EGRESS — Secret egress firewall + secure credential home

## Current Position

Phase: 2 (EGRESS — Secret egress firewall + secure credential home) — EXECUTING
Plan: 4 of 5
Status: Ready to execute
Last activity: 2026-05-27

### Phases (v1.2 — restart at 1)

- [ ] **Phase 1: REGR — Critical regressions** (R0, R1, R5) · Depends on: nothing
- [ ] **Phase 2: EGRESS — Secret egress firewall + secure credential home** (R4, R8) · Depends on: Phase 1
- [ ] **Phase 3: CONNECT — MCP connect correctness + delivery UX** (R2, R3, R9, R10) · Depends on: Phase 1 (may proceed after Phase 2)
- [ ] **Phase 4: OAUTH — OAuth refresh robustness** (R6) · Depends on: — (parallel with Phase 5 after Phase 1)
- [ ] **Phase 5: SANDBOX — Sandbox ergonomics** (R7) · Depends on: — (parallel with Phase 4 after Phase 1)

## Performance Metrics

**Velocity (cumulative across milestones):**

- Total plans completed: 23 (v1.1)
- Average duration: ~11 min/plan
- v1.2 plans completed: 0

**v1.2 by Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 — REGR | 0 | - | - |
| 2 — EGRESS | 0 | - | - |
| 3 — CONNECT | 0 | - | - |
| 4 — OAUTH | 0 | - | - |
| 5 — SANDBOX | 0 | - | - |
| 1 | 3 | - | - |

*Updated after each plan completion*
| Phase 01-regr-critical-regressions P02 | 43min | 2 tasks | 8 files |
| Phase 01-regr-critical-regressions P03 | 15 | 2 tasks | 2 files |
| Phase 02-egress P01 | 23 | 2 tasks | 10 files |
| Phase 02-egress-secret-egress-firewall-secure-credential-home P02 | 19 | 2 tasks | 10 files |

## Accumulated Context

### Decisions

From PROJECT.md Key Decisions + the source plan + research corrections:

- **Phase numbers restart at 1 for v1.2** (v1.0 was 1-8, v1.1 was 1-5, both archived to `milestones/`). `.planning/phases/` is empty — no collision.
- **R#→phase mapping is locked** by the source plan's Part D and confirmed dependency-correct by research: Phase 1 = R0/R1/R5; Phase 2 = R4/R8; Phase 3 = R2/R3/R9/R10; Phase 4 = R6; Phase 5 = R7. Preserve `R0–R10` IDs verbatim.
- **Forced build orders**: R0 → {R1 ∥ R5}; R4-core → its 4 wirings; R8-store → R8-handoff; R2 → R10.
- **No new runtime dependency**: every required API is in already-installed packages (`@anthropic-ai/sdk@0.91.1`, `@earendil-works/pi-ai@0.75.3`, `@modelcontextprotocol/sdk@1.29.0`, `pino@10.3.1`, `pino-abstract-transport@3.0.0`). Do not upgrade the Anthropic SDK (R5) or rely on a device-flow the MCP SDK lacks (R6-DEV deferred).
- **No new detection regexes from scratch**: reuse the `@comis/core` keystone; only R0's curated-prefix additions, behind the parity guard.
- **Parallel non-code Ops workstream** (plan Part C) runs alongside Phase 2: token revocation, `~/.comis/.git` history scrub, plaintext-artifact deletion, `daemon.log` rotation. Tracked separately, not a code requirement (mirrors v1.1's git-scrub workstream).
- **`.planning/` stays local** (`commit_docs: false`); code commits carry the audit trail via TDD-first RED commits referencing R# requirements.

### Pending Todos

None yet — Phase 1 planning is the next action.

### Blockers/Concerns

Carried from research as load-bearing constraints (the verifier and planner rely on these):

- **R4 cycle trap (Phase 2, non-negotiable)**: `secret-egress-guard` in `@comis/core` must own its own text scrubber over the R0 prefix list and must **NOT** import `redactSecretsInText` from `@comis/observability` (inverts the one-way `core ← observability` graph → fails `pnpm cycles` + `architecture-graph.test.ts`). Run `pnpm cycles` + `no-cycles.test.ts` after every cross-package move; never add a `TARGET_GRAPH` edge to "fix" a cycle.
- **R8 adapter location (Phase 2, non-negotiable)**: MCP token-store adapter constructed in `daemon` and injected via `oauthDeps.createTokenStore` — never built in `skills` (forbidden `skills → memory` edge); `skills` imports only the `OAuthCredentialStorePort` *type*.
- **R8 no AES-at-rest this milestone**: AES conflicts with the chokidar disk-watch refresh (stale refresh-token → `invalid_grant`). P1 = one `0600` home in the data dir, never the workspace; AES deferred (R8-AES, P3). Confirm the chokidar watch survives the port wrapping.
- **R1 pipeline, not parallel target (Phase 1)**: the redact stage is a `targets[].pipeline` upstream transform built with `enablePipelining`, not a parallel `targets[]` entry. Verify both the pm2 (stdout-skipped) and direct-stdout paths.
- **R5 layer position (Phase 1)**: push `createSignatureReplayScrubber` between `thinkingCleaner` and `signatureSurrogateGuard`; the layer-membership-and-ordering test IS the durability mechanism.
- **R0 before R1 + R4 (Phase 1)**: shared prefix vocabulary is the prerequisite.
- **R9 must keep `pi-executor.test.ts:4892`/`:4966` green (Phase 3)**: carve out only URL/short-code-bearing pre-tool text; do not re-introduce framing-prose noise.
- **R6 `DiscoveryStateFileSchema` drops `authorizationServerMetadata` on disk (Phase 4)**: widen schema or thread in-memory cache (plan-phase decision).
- **R7 never weaken `safe-path.ts` (Phase 5)**: write the still-blocked negative controls before any relaxation.
- **Confirm-before-build flags**: `core/security/secrets-audit.ts` already exists (R4 audit-doctor ≈ wiring); `env-substitution.ts` already covers env refs (R8 adds only `file`/`exec`); verify `perf-budget.test.ts` baseline before the R4 delivery scan.

## Last Completed Milestone

**v1.1 — MCP Hardening** (shipped 2026-05-26)

- 5/5 phases verified · 18 plans · 35 tasks. SEC keystone, zero-config secrets store, MCP credential firewall, transport resilience, sub-agent tool governance.
- Archive: `.planning/milestones/v1.1-ROADMAP.md` · `v1.1-REQUIREMENTS.md` · `v1.1-MILESTONE-AUDIT.md` · `v1.1-phases/`

## Session Continuity

Last session: 2026-05-27T17:35:24.797Z
Stopped at: v1.2 roadmap created
Resume file: None

## Operator Next Steps

- Plan Phase 1 (REGR) with `/gsd-plan-phase 1`
