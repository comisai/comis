---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: completed
last_updated: "2026-05-24T17:50:15.247Z"
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 11
  completed_plans: 8
  percent: 73
---

# Project State: Comis Observability Initiative

**Last Updated:** 2026-05-24
**Reference:** `.planning/PROJECT.md`

## Project Reference

**Project:** Comis — security-first AI agent platform connecting agents to 9 chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email). TypeScript monorepo, 15 packages, hexagonal architecture (ports + adapters), Node.js ≥ 22, Linux-only.

**Active scope:** Comis Observability & Troubleshooting initiative (M1 + M2 + M3 per `.planning/design/OBSERVABILITY_DESIGN.md`).

**Core Value:** A fleet-wide bug (today's worked example: the 2026-05-24 duplicate Telegram adapter that double-fired every inbound) must be diagnosable from **one structured artifact with one command in under five minutes** — not 30 minutes of `grep | jq | python` across three log streams.

**Current Focus:** Phase 1 COMPLETE + verified + reviewed. Phase 2 (Bridge Expansion & Payload Bounding) — pending start.

## Current Position

**Phase:** 2 of 8 (M1: Foundations) — pending start
**Last Completed:** Phase 1 — Trace Propagation & Lifecycle Envelopes (2026-05-24)
**Plan:** Not yet planned — resume with `/gsd-autonomous --from 2` (or `/gsd-plan-phase 2`)
**Status:** Phase 1 done; Phase 2 not started
**Progress:** [███████░░░] 73%

**Phase 1 outcome:** 43 commits across core/channels/orchestrator/agent/observability. All 6 requirements (TRACE-01..03, LIFE-01..03) met. Verifier: 5/5 criteria PASSED. Code review: 0 critical / 4 warning / 4 info — none blocking; carry-overs in `phases/01-trace-propagation-lifecycle-envelopes/01-CARRYOVER.md`.

**Phase 2 Goal:** Trajectory bus-bridge maps ~45 events (up from 18) + defense-in-depth payload bounding. Closes G2 + adopts O4.

**Phase 2 Requirements (12):** BRIDGE-01..09, BOUND-01..03

**Phase 2 inherits from Phase 1:** `emitTraceTruncated()` hook ready for BOUND-02; `TrajectoryEventSource`/`sourceSeq`/`parentEntryId` schema in place; lifecycle envelopes need `sessionStateProvider` wiring (deferred Plan 01-05 — see CARRYOVER WR-01).

## Roadmap Snapshot

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 1 | Trace Propagation & Lifecycle Envelopes | Not started | 6 |
| 2 | Bridge Expansion & Payload Bounding | Not started | 12 |
| 3 | Boot Invariants, INFO Promotion & Dedup Detector | Not started | 6 |
| 4 | Session DAG & Bundle Exporter | Not started | 6 |
| 5 | Trajectory Pointer & Platform-Aware Redaction | Not started | 5 |
| 6 | Operator CLI & Slash-Command Export | Not started | 11 |
| 7 | Log Rotation & Alert Budget | Not started | 4 |
| 8 | Pipeline-Tag Discipline & Operator Docs | Not started | 4 |

**Total v1 requirements mapped:** 54 / 54 (100%)

## Performance Metrics

*(Populated by phase completion via `/gsd-complete-phase`.)*

| Phase | Plans | RED Test Commits | GREEN Patch Commits | Coverage Delta | `pnpm validate` Pass | Notes |
|-------|-------|------------------|----------------------|-----------------|----------------------|-------|
| 1 | — | — | — | — | — | — |
| 2 | — | — | — | — | — | — |
| 3 | — | — | — | — | — | — |
| 4 | — | — | — | — | — | — |
| 5 | — | — | — | — | — | — |
| 6 | — | — | — | — | — | — |
| 7 | — | — | — | — | — | — |
| 8 | — | — | — | — | — | — |
| Phase 01-trace-propagation-lifecycle-envelopes P02 | 12 | 3 tasks | 6 files |
| Phase 01-trace-propagation-lifecycle-envelopes P04 | 12m | 3 tasks | 4 files |

## Accumulated Context

### Key Decisions (from PROJECT.md)

- **Scope all three milestones in one initialization** — M1 alone leaves operator-tooling half-built; design doc treats M1+M2+M3 as one coherent arc.
- **Coarse phase granularity** — 8 phases instead of 19 mechanical D-moves; natural delivery boundaries identified per design §7 + user guidance.
- **YOLO mode with all 4 workflow agents** — research / plan_check / verifier / nyquist enabled per `.planning/config.json`.
- **Quality model profile** — Opus for research/roadmap, Sonnet for plan/verify/execute.
- **Parallel execution where dependencies allow** — design §16 maps a 2-stream split for M1.
- **`.planning/` stays gitignored** — existing project policy (commit `2e3630b`); design + code commits carry the audit trail.
- **Adopt OpenClaw bus-bridge expansion, NOT direct-call-site recording** — preserves Comis's architecture-test enforcement.
- **`schemaVersion: 1` stays for all M1/M2 changes** — additive optional fields only; no breaking changes planned.

### TDD-First Reminder

Per AGENTS.md §2.10, every fix and feature in `packages/*/src/**` lands as:

1. **RED test commit** — failing test that demonstrably fails on the pre-patch code (lands first when practical so the RED state is reproducible from that commit alone).
2. **GREEN production patch commit** — flips the test to green.

Exempt: pure docs (Phase 8 DOCS-*), comments, formatting, and build-tooling/CI/config edits.

When in doubt, write the test. "I tested it locally" is not a substitute.

### Coverage Floors

Per CLAUDE.md + AGENTS.md §2.7:

- Lines ≥ 90 / branches ≥ 85 / functions ≥ 90 on `packages/*/src/**/*.ts`
- Per-package: orchestrator 93/81/92
- **observability ≥ 90/85/90 (raised by this work)**

### Architecture Tests (shrink-only)

Per AGENTS.md §2.8. New allowlist entries are forbidden. Existing entries can be removed when the underlying issue is resolved. New architecture tests landing in this scope:

- `test/architecture/trace-propagation.test.ts` (Phase 1, D1)
- `test/architecture/trajectory-bridge-mapping.test.ts` (Phase 2, D6 — grows existing test)
- `test/architecture/startup-invariants.test.ts` (Phase 3, D10)
- `test/architecture/forensic-events-info-level.test.ts` (Phase 3, D11)
- `test/architecture/dedup-detector.test.ts` (Phase 3, D12)
- `test/architecture/bundle-export-shape.test.ts` (Phase 4, D5)
- `test/architecture/pipeline-step-coverage.test.ts` (Phase 8, HYGIENE-01)

### Todos

*(Populated as phases progress.)*

- Nothing yet.

### Blockers

*(Populated as blockers surface.)*

- None.

### Open Questions (from design §15, NOT blocking M1)

1. Per-stream retention policy (`observability.logRotation[stream].{...}`) — spec'd implicitly in Phase 7; explicit per-stream config deferred to v2 (`RETENT-01`).
2. Streaming vs polling for `comis trace --tail` — Phase 6 uses polling; true streaming RPC is v2 (`STREAM-01`).
3. Bundle signing (sigstore / cosign) — deferred to v2 (`SIGN-01`).
4. Remote trajectory storage as a port (S3, GCS) — deferred to v2 (`REMOTE-01`).
5. OpenTelemetry export adapter — deferred to v2 (`OTEL-01`).

## Session Continuity

**Last session worked on:** Project initialization (PROJECT.md + REQUIREMENTS.md + ROADMAP.md + STATE.md).
**Last command run:** `/gsd-new-project` orchestrator → roadmapper subagent.
**Next action:** Run `/gsd-plan-phase 1` to decompose Phase 1 (Trace Propagation & Lifecycle Envelopes) into executable plans.

**Reproducible state:** Files written to `.planning/`:

- `.planning/PROJECT.md` (project context)
- `.planning/REQUIREMENTS.md` (54 v1 requirements + traceability)
- `.planning/design/OBSERVABILITY_DESIGN.md` (authoritative 1018-line spec)
- `.planning/codebase/ARCHITECTURE.md` + `.planning/codebase/STRUCTURE.md` (codebase maps)
- `.planning/config.json` (granularity=coarse, YOLO mode, quality profile, parallelization enabled)
- `.planning/ROADMAP.md` (this scope's phase decomposition)
- `.planning/STATE.md` (this file)

---

*State initialized: 2026-05-24*
