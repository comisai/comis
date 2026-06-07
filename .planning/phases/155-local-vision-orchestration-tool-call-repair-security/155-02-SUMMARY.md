---
phase: 155
plan: 02
subsystem: agent-executor
tags: [tool-call-repair, security, stream-wrapper, tdd, L3, S3]
dependency_graph:
  requires:
    - 155-01  # ModelProfile threading into executor-stream-setup.ts (FAIL_CLOSED_PROFILE fallback)
  provides:
    - repairToolCallJSON  # pure shape-only JSON normalizer
    - createToolCallRepairWrapper  # stream wrapper wired before validationErrorFormatter
  affects:
    - executor-stream-setup.ts  # wrapper chain order updated
    - pi-executor.test.ts  # wrapper count assertions updated
tech_stack:
  added: []
  patterns:
    - "Result<T,E> (ok/err from @comis/shared) for shape repair outcome"
    - "Stream wrapper pattern (StreamFnWrapper) matching validation-error-formatter.ts analog"
    - "PARAMETER_VALIDATION_TAGS carve-out: 'Validation failed' prefix prevents breaker trip"
key_files:
  created:
    - packages/agent/src/executor/tool-call-repair.ts
    - packages/agent/src/executor/tool-call-repair.test.ts
    - packages/agent/src/executor/stream-wrappers/tool-call-repair-wrapper.ts
    - packages/agent/src/executor/stream-wrappers/tool-call-repair-wrapper.test.ts
  modified:
    - packages/agent/src/executor/executor-stream-setup.ts
    - packages/agent/src/executor/pi-executor/pi-executor.test.ts
decisions:
  - "Repair wrapper intercepts AssistantMessage items (role: 'assistant') and inspects ToolCall content blocks where arguments arrive as raw JSON strings. Since ToolCall.arguments is typed Record<string,any> in pi-ai, the wrapper is a safe no-op when args are already parsed objects — only activates when a runtime string is detected."
  - "Date.now() forbidden: synthetic ToolResultMessage timestamp uses assistantMsg.timestamp ?? 0 to maintain causal ordering without requiring a clock port injection."
  - "FAIL_CLOSED_PROFILE used as fallback for callers that do not thread modelProfile into setupStreamWrappers (matches the ?? pattern established in 155-01)."
  - "wrapperCount updated in pi-executor.test.ts: 7->8 (no-trace) and 8->9 (with-trace) to account for toolCallRepairWrapper insertion."
  - "tool-call-repair-wrapper.test.ts neighbor created to satisfy coverage-gate file-neighbor invariant."
metrics:
  duration: 25min
  completed_date: "2026-06-08"
  tasks: 1
  files: 6
---

# Phase 155 Plan 02: L3/S3 Tool-Call-Repair + Security Wiring Summary

Shape-only value-preserving JSON normalizer (`repairToolCallJSON`) + stream wrapper (`createToolCallRepairWrapper`) wired before `validationErrorFormatter` — irreparable args produce `validation_failed`-tagged errors that bypass the breaker carve-out.

## What Was Built

### `tool-call-repair.ts` (pure function)
- `repairToolCallJSON(rawJson, profile): Result<Record<string, unknown>, string>`
- Attempt 1: strict `JSON.parse` (pass-through if valid)
- Attempt 2: `supportsStructuredOutput` stub branch (all Ollama=false; constrained-decode deferred)
- Attempt 3: `attemptLenientRepair` — removes trailing commas before `}` or `]`; no value changes
- Returns `err("irreparable")` if structural normalization fails
- NEVER calls `validateExecCommand` — exec security gates run downstream

### `stream-wrappers/tool-call-repair-wrapper.ts` (stream wrapper)
- `createToolCallRepairWrapper(modelProfile, logger): StreamFnWrapper`
- Named inner function `toolCallRepairWrapper` (captured by `compose.ts` for chain logging)
- Intercepts `AssistantMessage` items and inspects each `ToolCall` block
- If `arguments` is already a parsed object → pass through unchanged (no-op for normal case)
- If `arguments` is a raw JSON string → attempt repair via `repairToolCallJSON`
  - Success: replace string with parsed object (value-preserving)
  - Failure: inject synthetic `ToolResultMessage` with `"Validation failed: ..."` prefix
    → `extractErrorTag` → `"validation_failed"` → `PARAMETER_VALIDATION_TAGS` carve-out → no breaker trip

### `executor-stream-setup.ts` (wiring)
- Import: `createToolCallRepairWrapper` from `./stream-wrappers/tool-call-repair-wrapper.js`
- Import: `FAIL_CLOSED_PROFILE` from `./model-profile.js` (fallback)
- Wrapper order comment updated: `ttlGuard -> [L3] toolCallRepairWrapper -> validationErrorFormatter -> ...`
- Insertion: `createToolCallRepairWrapper(modelProfile ?? FAIL_CLOSED_PROFILE, deps.logger)` at position 2 (after ttlGuard, before validationErrorFormatter)

## TDD Discipline

| Gate | Commit | Status |
|------|--------|--------|
| RED  | `d5e6e37b` | 6 test cases written; module missing → all fail |
| GREEN | `bfc853f3` | All 6 pass; build clean; all 30264 tests pass |

## Test Coverage

**`tool-call-repair.test.ts`** (6 cases):
1. Valid JSON passes through unchanged
2. Trailing-comma repaired to `ok`
3. Irreparable non-JSON → `err("irreparable")`
4. S3 adversarial: malicious command + trailing comma → shape repaired, `"rm -rf /"` value UNCHANGED
5. S3 adversarial: sensitive path + trailing comma → shape repaired, `"/etc/passwd"` UNCHANGED
6. Breaker carve-out: `"Validation failed"` prefix → `"validation_failed"` tag → in `PARAMETER_VALIDATION_TAGS`

**`tool-call-repair-wrapper.test.ts`** (6 cases):
1. Non-assistant messages pass through unchanged
2. Already-parsed object args pass through unchanged (no-op case)
3. String args with trailing comma repaired (near-miss JSON)
4. S3 adversarial: malicious command string repaired, dangerous value preserved
5. Irreparable string → synthetic `ToolResultMessage` with `"Validation failed:"` prefix
6. Function name is `toolCallRepairWrapper` (compose.ts logging verified)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `Date.now()` forbidden by globals.test.ts**
- **Found during:** GREEN phase, full test run
- **Issue:** `tool-call-repair-wrapper.ts` used `Date.now()` for synthetic ToolResultMessage timestamp
- **Fix:** Changed to `assistantMsg.timestamp ?? 0` — preserves causal ordering without clock port
- **Files modified:** `packages/agent/src/executor/stream-wrappers/tool-call-repair-wrapper.ts`
- **Commit:** `bfc853f3`

**2. [Rule 2 - Missing Tests] Coverage gate requires test neighbor for tool-call-repair-wrapper.ts**
- **Found during:** GREEN phase, full test run
- **Issue:** Coverage gate detected `tool-call-repair-wrapper.ts` without a test neighbor
- **Fix:** Created `tool-call-repair-wrapper.test.ts` with 6 behavioral tests
- **Files modified:** `packages/agent/src/executor/stream-wrappers/tool-call-repair-wrapper.test.ts` (new)
- **Commit:** `bfc853f3`

**3. [Rule 1 - Bug] pi-executor.test.ts wrapper count assertions stale after adding new wrapper**
- **Found during:** GREEN phase, full test run
- **Issue:** `wrapperCount` expected 7/8; toolCallRepairWrapper addition makes them 8/9
- **Fix:** Updated 3 assertions and the `wrapperNames` list in pi-executor.test.ts
- **Files modified:** `packages/agent/src/executor/pi-executor/pi-executor.test.ts`
- **Commit:** `bfc853f3`

**4. [Rule 4 Avoided] pi-ai SDK Message type has no `toolUse` role**
- **Context:** Plan described intercepting `toolUse` role messages; pi-ai SDK uses `AssistantMessage.content[]` with `ToolCall` type blocks instead
- **Resolution:** Adapted wrapper to intercept `AssistantMessage` items and inspect `ToolCall` content blocks. The functional behavior (shape repair before exec gates) is preserved. This is a valid deviation within the plan's refactor guidance: "Verify the Message type union in pi-ai includes a toolUse role. If not, use the correct role name from the SDK types."
- **Impact:** None — S3 invariant holds; wrapper is safe no-op when args already parsed

## Security Invariants Verified

| Invariant | Evidence |
|-----------|----------|
| T-155-S3-01: No scope widening | Case 4+5 (tool-call-repair.test.ts): malicious values pass through unmodified |
| T-155-S3-02: Exec gate authority | `validateExecCommand` NOT called in repair; grep confirmed 0 occurrences |
| T-155-S3-03: PARAMETER_VALIDATION_TAGS carve-out | Case 6 (tool-call-repair.test.ts): `extractErrorTag("Validation failed: ...")` = `"validation_failed"` ∈ `PARAMETER_VALIDATION_TAGS` |
| T-155-S3-04: Wrapper doesn't bypass exec gates | Wrapper only fixes shape; message continues through normal tool execution path |

## Known Stubs

**`supportsStructuredOutput` branch (line 52-58 of tool-call-repair.ts):** Named stub with comment — constrained-decode path deferred to a future phase. All Ollama models have `supportsStructuredOutput=false` in Phase 155, so the lenient repair path covers all Phase 155 cases. The stub is present for traceability.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes. The repair wrapper is an in-process pure function with no external I/O.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `tool-call-repair.ts` exists | FOUND |
| `tool-call-repair.test.ts` exists | FOUND |
| `tool-call-repair-wrapper.ts` exists | FOUND |
| `tool-call-repair-wrapper.test.ts` exists | FOUND |
| RED commit `d5e6e37b` exists | FOUND |
| GREEN commit `bfc853f3` exists | FOUND |
