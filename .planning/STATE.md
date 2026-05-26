---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: MCP Hardening
status: verifying
stopped_at: Phase 01 Plan 02 complete — legacy detectors deleted, all call sites repointed, pnpm validate green.
last_updated: "2026-05-26T19:41:06.397Z"
last_activity: 2026-05-26
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 15
  completed_plans: 15
  percent: 100
---

# Project State: Comis

**Last Updated:** 2026-05-26
**Reference:** `.planning/PROJECT.md`

## Project Reference

**Project:** Comis — security-first AI agent platform connecting agents to 9 chat channels. TypeScript monorepo, 15 packages, hexagonal architecture, Node.js ≥ 22, Linux-only.

**Core value:** A fleet-wide bug must be diagnosable from one structured artifact with one command in under five minutes.
**Current focus:** Phase 04 — mcpx-mcp-transport-resilience

## Current Position

Phase: 04 (mcpx-mcp-transport-resilience) — EXECUTING
Plan: 4 of 4
Status: Phase complete — ready for verification
Last activity: 2026-05-26

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 13
- Average duration: ~11 min/plan
- Total execution time: ~22 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-sec-secret-detection-keystone | 2 | ~22 min | ~11 min |
| 01 | 2 | - | - |
| 02 | 5 | - | - |
| 03 | 4 | - | - |

*Updated after each plan completion*
| Phase 02-store-zero-config-secrets-store P02 | 8 | 2 tasks | 2 files |
| Phase 02 P04 | 3m | 2 tasks | 2 files |
| Phase 02-store-zero-config-secrets-store P03 | 6 | 2 tasks | 2 files |
| Phase 02-store-zero-config-secrets-store P05 | 8 | - tasks | - files |
| Phase 03-cred-mcp-credential-firewall-lifecycle P01 | 9 | 2 tasks | 5 files |
| Phase 03-cred-mcp-credential-firewall-lifecycle P02 | 18m | 2 tasks | 2 files |
| Phase 03-cred-mcp-credential-firewall-lifecycle P03 | 4 | 2 tasks | 4 files |
| Phase 04-mcpx P01 | 6m | 2 tasks | 3 files |
| Phase 04-mcpx-mcp-transport-resilience P02 | 12m | 2 tasks | 3 files |
| Phase 04 P04 | 25 | 1 tasks | 4 files |

## Accumulated Context

### Decisions

From PROJECT.md Key Decisions + v1.1 design:

- **Phase 1 is the keystone prerequisite**: `core/security/secret-detection.ts` must ship before any of CRED (Phase 3); both legacy files deleted in the same diff with no aliases.
- **Phase 2 (STORE) before Phase 3 (CRED)**: `MasterKeyWriteResult.keyHex` type gap confirmed — extraction writes to `secretStore` which is `undefined` until 3B auto-init lands.
- **Phases 4 (MCPX) and 5 (SUBA) are independent**: declared `Depends on: —`; can be planned/executed in parallel with Phases 2-3.
- **Parallel operational workstream**: git-history token scrub + revocation (design §12) runs alongside Phase 3; tracked separately, not a code requirement.
- **No new dependencies**: all API shapes verified against installed `@modelcontextprotocol/sdk@1.29.0` source; no new packages.
- [Phase ?]: Added seedKeyHex fallback to setupSecrets for zero-config first-boot encrypted store initialization
- [Phase ?]: All 5 docs updated: encrypted store is default (auto-generated), opt-out via COMIS_DISABLE_ENCRYPTED_SECRETS=1, backup obligation documented
- [Phase ?]: scanForSecrets gate before atomic write
- [Phase ?]: Cycle-breaking extraction

### Pending Todos

None yet.

### Blockers/Concerns

- **`MasterKeyWriteResult.keyHex` is a confirmed type gap** — RED test must prove pre-patch `writeMasterKeyIfAbsent` does not return `keyHex`. Anchor for Phase 2.
- **Two-source keepalive default** — both `schema-integrations.ts:208` AND `index.ts:170` must be removed in Phase 4; leaving either violates §2.4. RED test flips the schema assertion.
- **`pnpm cycles` is a hard gate** for Phase 5 (`SUB_AGENT_TOOL_DENYLIST`→core move). Run after every new cross-package import.

## Last Completed Milestone

**v1.0 — Comis Observability & Troubleshooting** (2026-05-24 → 2026-05-25)

- 8/8 phases verified · 35 plans · 140 commits · 172 files · +24,423/-907 LOC · 54/54 requirements met
- Archive: `.planning/milestones/v1.0-ROADMAP.md`

## Session Continuity

Last session: 2026-05-26T19:41:06.392Z
Stopped at: Phase 01 Plan 02 complete — legacy detectors deleted, all call sites repointed, pnpm validate green.
Resume file: None
