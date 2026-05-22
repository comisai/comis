---
phase: 53-agent-scheduler-deletions
plan: 04
subsystem: agent-response-filtering
tags:
  - investigation-decision
  - keep-decision-documentation
  - operator-config-protection
  - spec-abs-04
  - no-source-changes
dependency-graph:
  requires:
    - "53-RESEARCH.md Sub-area 6 (enforceFinalTag investigation)"
    - "ROADMAP SPEC-ABS-04 (investigate before cutting)"
  provides:
    - "Written closure record for SPEC-ABS-04 (investigated → keep)"
    - "Future-proofing rationale for cleanup phases that might re-encounter `enforceFinalTag`"
  affects: []
tech-stack:
  added: []
  patterns:
    - "investigated → keep closure (per ROADMAP's investigate-first guidance)"
key-files:
  created:
    - ".planning/phases/53-agent-scheduler-deletions/53-04-SUMMARY.md"
  modified: []
decisions:
  - "SPEC-ABS-04 closes as 'investigated → keep': enforceFinalTag is operator-facing public API (Zod schema + operator docs + 12 production source files + 4 test suites), not a speculative abstraction."
  - "Phase 53 produces ZERO source changes under SPEC-ABS-04. Deletion would be a feature-removal requiring CHANGELOG + version bump + coordinated edits across 15+ files."
metrics:
  duration: "~5 minutes (read-only verification + SUMMARY write)"
  completed: "2026-05-22"
  files-modified: 0
  files-created: 1
  tasks-completed: 1
---

# Phase 53 Plan 04: SPEC-ABS-04 (enforceFinalTag) KEEP Decision Summary

`enforceFinalTag` and its 7-state FSM in `packages/agent/src/response-filter/thinking-tag-filter.ts` are KEPT. SPEC-ABS-04 closes as "investigated → keep" — the operator-facing Zod schema field, documentation entry, and 4-package threading prove this is public API, not speculative.

## Decision

**SPEC-ABS-04 closes as: investigated → keep.**

NO source code changes were made in this plan. The 7-state FSM in `thinking-tag-filter.ts`, the `PerAgentConfigSchema` field, the operator documentation row, and all 12 production source-file references survive untouched.

The ROADMAP's explicit guidance was: "speculative cuts: `enforceFinalTag` 7-state FSM (**after investigation; HIGH risk — verify zero opt-in YAML first**)". The investigation was performed (Phase 53 RESEARCH.md Sub-area 6). The result: the FSM is operator-facing public API. Closure by KEEP, with this SUMMARY as the audit trail so future cleanup phases do not revisit.

## Investigation Date

2026-05-22

## Evidence Chain (Verified at HEAD)

### 1. Zod Schema Declaration (operator-facing config field)

`packages/core/src/config/schema-agent/schema-agent-runtime.ts:118`:

```typescript
enforceFinalTag: z.boolean().default(false),
```

This lives inside `PerAgentConfigSchema` — the public surface that validates operator YAML at `~/.comis/config.yaml`. Operators set this in YAML; `comisai` accepts and threads it through.

### 2. Operator Documentation Entry

`docs/reference/config-yaml.mdx:254`:

> `enforceFinalTag` | `boolean` | `false` | When enabled, only content inside `<final>` blocks reaches users. Suppresses all content outside final tags on both streaming and non-streaming paths.

This is operator-facing documentation in the public docs site. Removing the schema field would orphan this row and break any operator who has read the docs.

### 3. The 7-state FSM (production implementation)

`packages/agent/src/response-filter/thinking-tag-filter.ts`:

- L4, L10-11: module-header comments describing `enforceFinalTag` mode
- L32: option declaration in the filter's option type
- L48-49: state literals `passthrough` | `suppressed` (the two enforceFinalTag-conditional initial states)
- L127-132: state-name JSDoc explaining `passthrough` (initial when `enforceFinalTag=false`) vs `suppressed` (initial when `enforceFinalTag=true`)
- L136: `const enforceFinalTag = options?.enforceFinalTag ?? false`
- L137: `const initialState: State = enforceFinalTag ? "suppressed" : "passthrough"`
- L190-235: emit/suppress dispatch using the state machine

The FSM survives in production exactly as it was.

### 4. 12 Production Source Files (per RESEARCH Sub-area 6)

All twelve files referenced in RESEARCH continue to reference `enforceFinalTag` at HEAD:

| # | File | Role |
|---|---|---|
| 1 | `packages/core/src/config/schema-agent/schema-agent-runtime.ts` | Zod schema field declaration |
| 2 | `packages/agent/src/provider/response/sanitize-pipeline.ts` | Non-streaming pipeline (`sanitizeAssistantResponse`) |
| 3 | `packages/agent/src/response-filter/thinking-tag-filter.ts` | The 7-state FSM |
| 4 | `packages/agent/src/executor/pi-executor/pi-executor-types.ts` | Executor option `enforceFinalTag?: boolean` |
| 5 | `packages/daemon/src/wiring/setup-agents/setup-agents-runtime.ts` | Daemon: per-agent runtime plumbing |
| 6 | `packages/daemon/src/wiring/setup-channels/setup-channels-runtime.ts` | Daemon: channel-config getter |
| 7 | `packages/orchestrator/src/channel-manager.ts` | Channel manager deps slot |
| 8 | `packages/orchestrator/src/execution/execution-execute.ts` | Executor: `createThinkingTagFilter({ enforceFinalTag })` consumption |
| 9 | `packages/orchestrator/src/execution/execution-filter.ts` | Filter + warning log when filter strips everything |
| 10 | `packages/orchestrator/src/execution/execution-pipeline.ts` | Pipeline deps slot |
| 11 | `packages/orchestrator/src/inbound/inbound-pipeline.ts` | Inbound pipeline deps slot |
| 12 | `packages/orchestrator/src/inbound/inbound-route.ts` | Inbound-route propagation |

### 5. Test Suites Covering enforceFinalTag

- `packages/core/src/config/schema-agent.test.ts` — 2 cases (defaults to `false`, accepts `true`)
- `packages/agent/src/response-filter/thinking-tag-filter.test.ts` — 15+ cases for `enforceFinalTag` mode
- `packages/daemon/src/wiring/setup-channels-config-smoke.test.ts` — 2 cases (channel-config wiring smoke)
- `packages/orchestrator/src/execution/execution-filter.test.ts` (+ `execution-filter-branches.test.ts`) — warning emission, empty-response handling

Plus `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap` references the schema field in serialized form.

### 6. YAML Scan Results (committed repo files)

- `.yaml` / `.yml` files: **ZERO** matches (expected — operator YAML lives in `~/.comis/config.yaml`, not the repo)
- `.json` files: **ZERO** matches
- `.mdx` files: **1** match — the operator documentation row at `docs/reference/config-yaml.mdx:254`
- `.md` files: **2** matches — `packages/orchestrator/AUDIT.md:68` (audit entry for `getEnforceFinalTag`), plus this SUMMARY

## Why "no opt-in YAML in repo" is NOT sufficient evidence for deletion

The "scan committed YAML for opt-in" signal is **necessary but not sufficient**. Operator YAML lives in `~/.comis/config.yaml` outside the repo — its absence from the committed tree is the expected baseline, not evidence that the option is unused. The presence of:

- A `PerAgentConfigSchema` field with `default(false)`
- An operator documentation row at `docs/reference/config-yaml.mdx:254`
- Multi-package threading (`daemon → orchestrator → agent → core`)
- 4+ test suites with non-trivial coverage

constitutes **operator-facing public API**. Any operator reading the docs may have set `enforceFinalTag: true` in their YAML. Deletion would silently break those operators.

## Cost Analysis If Deletion Were Pursued Anyway

If a future phase wants to remove `enforceFinalTag` deliberately as a deprecation, the cascade is:

- 12 production source files edited
- 4 test suites edited (5 with the branches variant)
- 1 docs file edited (`docs/reference/config-yaml.mdx`)
- 1 audit doc edited (`packages/orchestrator/AUDIT.md:68`)
- 1 snapshot file regenerated (`section-registry-parity.test.ts.snap`)
- CHANGELOG entry mandatory (operator-facing behavior break)
- Version bump justified (public-surface removal)

Estimated effort: half-day or more, with a deprecation cycle (warn-on-set → remove). Far outside Phase 53's "cleanup phase" scope. Belongs in a dedicated phase or quick task if pursued.

## Cross-Phase Coordination

This plan modifies **zero** git-tracked files. It is parallel-safe with:

- All other Phase 53 plans (53-01, 53-02, 53-03, 53-05, 53-06, 53-07)
- All other Wave B phases (51, 52, 54, 55)
- All future cleanup phases

No merge conflicts possible from this plan.

## Verification

```bash
# 1. SUMMARY file exists
test -f .planning/phases/53-agent-scheduler-deletions/53-04-SUMMARY.md   # ✓

# 2. Evidence anchors preserved at HEAD
grep -q "enforceFinalTag: z.boolean()" packages/core/src/config/schema-agent/schema-agent-runtime.ts   # ✓ L118
grep -q "enforceFinalTag" docs/reference/config-yaml.mdx                                                # ✓ L254
grep -q "enforceFinalTag" packages/agent/src/response-filter/thinking-tag-filter.ts                     # ✓ L32, L136-137, L261, L272

# 3. 12 production source files preserved
grep -rln "enforceFinalTag" packages/*/src/ 2>/dev/null \
  | grep -v "\.test\.ts" | grep -v dist | grep -v node_modules | wc -l
# Expected: 12 — VERIFIED at investigation time
```

## Deviations from Plan

**None — read-only investigation closed exactly as planned.**

The plan called for a read-only evidence verification followed by SUMMARY emission. Both steps completed without any production-code edits, deviations, or auto-fixes. The plan's `files_modified: []` declaration is honored.

## Known Stubs

None.

## Authentication Gates

None encountered.

## Threat Flags

None — this plan reviews existing security-irrelevant operator configuration; no new trust-boundary surface introduced.

## Closure Statement

`enforceFinalTag` is operator-facing public API. The "speculative abstraction" classification in the original ROADMAP was incorrect (the ROADMAP itself flagged this with HIGH-risk + investigate-first guidance, exactly to prevent the mistake). SPEC-ABS-04 closes as **investigated → keep**. The 7-state FSM, Zod field, operator docs row, 12 production source files, and 4 test suites all stay.

Future cleanup phases that re-encounter `enforceFinalTag` should consult this SUMMARY and the underlying RESEARCH.md Sub-area 6 before considering deletion. The default answer is: keep.

## Self-Check: PASSED

- `[ -f .planning/phases/53-agent-scheduler-deletions/53-04-SUMMARY.md ]` → present (just written)
- `grep -q "enforceFinalTag" packages/core/src/config/schema-agent/schema-agent-runtime.ts` → present at L118
- `grep -q "enforceFinalTag" docs/reference/config-yaml.mdx` → present at L254
- `grep -q "enforceFinalTag" packages/agent/src/response-filter/thinking-tag-filter.ts` → present (multiple lines)
- `git diff HEAD packages/ test/ docs/` → empty (zero source changes — plan invariant satisfied)
