---
phase: 02-egress-secret-egress-firewall-secure-credential-home
plan: "05"
subsystem: mcp-auth-circuit-breaker
tags:
  - r8
  - mcp-oauth
  - circuit-breaker
  - needs_reauth
  - secure-handoff
  - credential-egress
  - tdd

dependency_graph:
  requires:
    - 02-01
    - 02-02
    - 02-03
    - 02-04
  provides:
    - needs_reauth structured result on MCP 401 (mcp-client-call.ts)
    - circuit breaker auth-trip (reason="auth", bypass threshold)
    - open-state needs_reauth when auth-tripped
    - secure handoff advisory appended when relay scrub finds credential
  affects:
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-call.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts
    - packages/agent/src/spawn/result-condenser.ts

tech-stack:
  added:
    - UnauthorizedError import from @modelcontextprotocol/sdk/client/auth.js
    - NEEDS_REAUTH exported constant (mirrors NEEDS_OAUTH_LOGIN pattern)
  patterns:
    - 401 -> structured ok result with isError:true (same shape as server_unavailable)
    - CircuitState open variant extended with reason?: "auth" discriminator
    - R8 Fix-b: generic advisory appended to relayed result on token redaction

key-files:
  created:
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-call.test.ts
  modified:
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-call.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts
    - packages/agent/src/spawn/result-condenser.ts
    - packages/agent/src/spawn/result-condenser.test.ts

key-decisions:
  - "needs_reauth uses ok({isError:true}) shape (not err()) — mirrors server_unavailable; agent sees a normal tool result with actionable hint, not an exception"
  - "Circuit breaker tripped IMMEDIATELY on 401 (bypass threshold) — auth failure is categorically different from transient errors; waiting for threshold allows retry loops"
  - "reason='auth' field added to CircuitState open variant — allows open-state to return needs_reauth instead of server_unavailable when breaker was tripped by auth"
  - "Fix-b: generic advisory only in result-condenser secure handoff — threading serverName into CondenseParams requires invasive cross-package API change; deferred per R8-handoff rationale; token absence + advisory phrase is sufficient to stop agent retry"
  - "errorKind='auth' on the 401 log (not 'dependency') — auth failure is a security event, not a generic external dependency error"

patterns-established:
  - "R8 auth-stop pattern: 401 -> immediate breaker trip (reason=auth) -> needs_reauth ok result -> agent stops retrying"
  - "Secure relay pattern: scrubSecretsFromText + advisory append on redactions > 0 -> parent agent cannot re-use raw token"

requirements-completed:
  - R8

duration: 5min
completed: 2026-05-27
---

# Phase 02 Plan 05: R8 needs_reauth + Circuit Breaker Auth Trip + Secure Handoff Summary

**MCP 401 now returns a structured `[needs_reauth]` stop signal with immediate circuit-breaker trip (reason="auth"), and the sub-agent relay redacts raw tokens and appends a secure-store advisory — closing the Higgsfield incident's agent-retry-improvise-OAuth behavioral root**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-27T17:55:04Z
- **Completed:** 2026-05-27T18:00:59Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 5

## Accomplishments

- MCP tool-call 401 returns `ok({ content: [{ type:"text", text:"[needs_reauth]..." }], isError: true })` — not an exception, not a generic error — so the LLM sees an actionable stop signal
- Circuit breaker trips IMMEDIATELY on first 401 (bypasses the failure threshold), with `reason="auth"` stored on the open state; subsequent calls return `[needs_reauth]` not `[server_unavailable]`
- `result-condenser.ts` appends a generic secure-store advisory to the relayed result when `scrubSecretsFromText` detects and redacts a credential (Fix-b: server name not in scope at `condenseInternal`, documented-deferred per R8-handoff rationale)
- Full Phase 2 gate: `pnpm validate` (build + 1357 test files / 25105 tests + lint:security + cycles) exits 0

## Task Commits

1. **Task 1 RED: Failing tests for needs_reauth on 401, circuit breaker auth trip, secure handoff** - `4923457` (test)
2. **Task 2 GREEN: Implementation** - `650e51f` (feat)

**Plan metadata:** (docs commit follows)

_TDD: RED committed first (4923457), then GREEN (650e51f)_

## TDD Gate Compliance

- RED gate: `test(02-05)` commit `4923457` — 4 new tests failing on pre-patch code
- GREEN gate: `feat(02-05)` commit `650e51f` — all 4 tests passing, all 25105 tests passing

## Files Created/Modified

- `packages/skills/src/skills/integrations/mcp-client/mcp-client-call.test.ts` — Created: 3 R8 tests for needs_reauth (RED)
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts` — Added `reason?: "auth"` to `CircuitState` open variant
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-call.ts` — Added `UnauthorizedError` import, `NEEDS_REAUTH` constant, 401 intercept in catch, auth-reason open-state handler
- `packages/agent/src/spawn/result-condenser.ts` — Extended R4 scrub block with R8 secure handoff advisory append
- `packages/agent/src/spawn/result-condenser.test.ts` — Added 2 R8 secure handoff advisory tests

## Decisions Made

- **needs_reauth shape**: `ok({ isError:true })` not `err()` — mirrors the existing `[server_unavailable]` breaker result so the agent sees a normal tool result with a readable hint. An `err()` would surface as an exception to the tool-call wrapper, not as an actionable agent message.
- **Immediate breaker trip on 401**: Auth failure is categorically different from transient errors (network blip, timeout). Waiting for `circuitBreakerThreshold` failures before tripping allows N-1 unnecessary retry attempts. On a 401, the first failure is definitive.
- **reason="auth" on CircuitState open variant**: Allows the open-state early-return to distinguish auth-tripped from error-tripped breakers and return the correct signal (`needs_reauth` vs `server_unavailable`). Only adds one optional field to one variant.
- **Fix-b generic advisory**: `condenseInternal` receives `{ runId, sessionKey, agentId }` but not `serverName`. Threading it requires adding `serverName?: string` to `CondenseParams` (cross-package API change) and all call sites. Per R8-handoff rationale: the advisory phrase "stored in the secure credential store" + "do NOT re-use raw token" is sufficient to stop the parent agent from extracting the token — the actionable `mcp-oauth:<server>` ref is a UX improvement, not a correctness requirement.

## Deviations from Plan

None — plan executed exactly as written. The only implementation decision was confirming `errorKind: "auth"` (not `"dependency"`) for the 401 log entry, which matches the `LogFields.ErrorKind` closed union from AGENTS.md.

## Issues Encountered

None.

## Known Stubs

None — all behavioral changes are fully wired. The Fix-b advisory is intentionally generic (server name not threaded) per the documented R8-handoff rationale; this is not a stub but a scoped design decision.

## Threat Flags

No new security-relevant surface introduced beyond what the plan's threat model covers. The changes close T-02-21 through T-02-24.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Phase 2 is complete. All 6 ROADMAP Phase 2 success criteria are satisfied:
- SC1: write/edit guard (02-02)
- SC2: delivery scan + OutputGuard redact (02-01 + 02-03)
- SC3: validateMemoryWrite + memory-store-tool retirement (02-01 + 02-02)
- SC4: cross-origin redirect headers + stdio env + secrets-audit doctor (02-03)
- SC5: hand-rolled write blocked + MCP token → OAuthCredentialStorePort (02-02 + 02-04)
- SC6: needs_reauth + circuit breaker + secure handoff (02-05) — satisfied now

`pnpm validate` exits 0 as the final Phase 2 gate.

## Self-Check: PASSED

- `packages/skills/src/skills/integrations/mcp-client/mcp-client-call.test.ts` — FOUND
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-call.ts` — FOUND (modified)
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts` — FOUND (modified)
- `packages/agent/src/spawn/result-condenser.ts` — FOUND (modified)
- `packages/agent/src/spawn/result-condenser.test.ts` — FOUND (modified)
- Commit `4923457` — FOUND
- Commit `650e51f` — FOUND

---
*Phase: 02-egress-secret-egress-firewall-secure-credential-home*
*Completed: 2026-05-27*
