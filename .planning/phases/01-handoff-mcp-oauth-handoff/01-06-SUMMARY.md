---
phase: 01-handoff-mcp-oauth-handoff
plan: "06"
subsystem: mcp-oauth
tags:
  - mcp
  - oauth
  - needs_oauth_login
  - structured-error
  - mcp_manage
  - actionable-hint
dependency_graph:
  requires:
    - 01-01  # coerceAuth + auth field in schema/contract
    - 01-05  # mcp.connect throws structured Error with .data.needs_oauth_login
  provides:
    - mcp_manage connect actionOverride catches .data.needs_oauth_login and returns actionable mcp_login hint (R8.4'-01 consumer)
    - auth already forwarded via coerceAuth from Plan 01 (R11-01 execute-side wiring confirmed)
  affects:
    - packages/skills/src/platform-tools/tools/mcp-manage-tool.ts
    - packages/skills/src/platform-tools/tools/mcp-manage-tool.test.ts
tech_stack:
  added: []
  patterns:
    - "try/catch around rpcCall in actionOverride: only swallows .data.needs_oauth_login === true errors"
    - "Structured error consumer: cast err to {data?: unknown} to read .data without TS index error"
    - "isAgentToolResult passthrough: {content: [{type:'text', text}], details} satisfies the factory guard"
key_files:
  created: []
  modified:
    - packages/skills/src/platform-tools/tools/mcp-manage-tool.ts
    - packages/skills/src/platform-tools/tools/mcp-manage-tool.test.ts
decisions:
  - try/catch wraps only the rpcCall in the connect override (not the whole override body) to preserve early validation throws
  - Non-oauth errors are unconditionally re-thrown (T-01-06-02 non-swallow invariant)
  - content[0].text names server_name from .data (agent already knows it; no information disclosure)
  - auth forwarding via coerceAuth was already wired in Plan 01 — this plan confirms it and adds the catch consumer
metrics:
  duration: 8m
  completed: "2026-05-28"
  tasks_completed: 2
  files_changed: 2
---

# Phase 01 Plan 06: mcp_manage connect — forward auth + catch needs_oauth_login

**One-liner:** Adds try/catch to the `mcp_manage` connect actionOverride that converts the Plan 05 structured `needs_oauth_login` error into an actionable `content[0].text` hint (`Run \`mcp_login({server_name: "..."})...`) instead of re-throwing a generic error the agent cannot act on.

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| RED | mcp_manage surfaces generic error instead of actionable hint | df250b0 | mcp-manage-tool.test.ts |
| GREEN | mcp_manage connect forwards auth + surfaces needs_oauth_login hint | e1f81d2 | mcp-manage-tool.ts |

## What Was Built

### State Before

The `mcp_manage` connect actionOverride had:
- `coerceAuth(p)` called and `auth` spread into `rpcCall("mcp.connect", ...)` (already wired in Plan 01)
- No try/catch — the `rpcCall` return was a bare `return rpcCall(...)` call
- If Plan 05's `mcp-handlers.ts` threw a structured Error with `.data.needs_oauth_login = true`, it propagated up as an unhandled exception

### Changes Made

`mcp-manage-tool.ts` connect actionOverride:

```typescript
// Before:
return rpcCall("mcp.connect", { ... });

// After:
try {
  return await rpcCall("mcp.connect", { ... });
} catch (err: unknown) {
  if (
    err instanceof Error &&
    (err as { data?: { needs_oauth_login?: boolean } }).data?.needs_oauth_login === true
  ) {
    const d = (err as { data: { server_name: string; action: string } }).data;
    return {
      content: [{ type: "text" as const, text: `Run \`mcp_login({server_name: "${d.server_name}"})\` to start the OAuth flow, then retry mcp_manage(action:"connect", auth:"oauth", url:..., transport:"http").` }],
      details: d,
    };
  }
  throw err;
}
```

The `{ content: [...], details }` shape passes `isAgentToolResult` in `admin-manage-factory.ts` — no factory change needed.

### Full OAuth Handoff Chain (Verification)

After this plan, the complete chain works end-to-end:

1. Agent calls `mcp_manage(action:"connect", auth:"oauth", url:..., transport:"http")`
2. `coerceAuth` validates → `auth: "oauth"` forwarded via conditional spread to `rpcCall("mcp.connect", { auth: "oauth", ... })`
3. `mcp-handlers.ts` passes `params.auth:"oauth"` to `buildPersistedMcpEntry` (Plan 02)
4. `manager.connect(config)` returns `err(tagNeedsOAuthLogin(...))` (Plan 04)
5. `mcp-handlers.ts` throws structured error with `.data.needs_oauth_login = true` (Plan 05)
6. Plan 06 catch block returns `content[0].text = "Run \`mcp_login({server_name: 'x'})\`..."`
7. Agent sees the actionable hint and calls `mcp_login({ server_name: "x" })` (Plan 03)

## Test Results

```
Test Files  1 passed (1)
     Tests  38 passed (38)
```

RED gate (`df250b0`): 1 failing (new needs_oauth_login hint test), 37 passing.
GREEN gate (`e1f81d2`): all 38 passing.

## TDD Gate Compliance

- RED gate: commit `df250b0` — `test(01-R8.4):` prefix. New test `mcp_manage connect returns actionable hint when daemon throws needs_oauth_login structured error` fails with `Error: [needs_oauth_login] MCP server "x" requires OAuth login` (the error is thrown, not caught and converted). Existing 37 tests remain green (including the "re-throws non-oauth errors unchanged" test which passes in RED because the current code already re-throws all errors).
- GREEN gate: commit `e1f81d2` — `feat(01-R8.4):` prefix. All 38 tests pass after adding try/catch block.
- Gate sequence: RED → GREEN (correct order).

## Deviations from Plan

None. The plan was executed exactly as written:
- `auth` forwarding via `coerceAuth` was already in place from Plan 01 (confirmed by test at line 696-699)
- try/catch added exactly as specified in the plan's `<behavior>` section
- content[0].text format matches the plan's specified string exactly

## Known Stubs

None. The `content[0].text` is fully populated with a concrete actionable hint. The `details` field carries `server_name` and `action` from the structured error `.data`.

## Threat Surface Scan

- T-01-06-01 (Information Disclosure): `.data.action` is `"comis mcp login <server_name>"` — a CLI hint. `.data.server_name` is agent-supplied and already known to the agent. No tokens or credentials in content. Accepted as planned.
- T-01-06-02 (Tampering): Catch block only swallows errors where `.data.needs_oauth_login === true`. All other errors re-thrown unchanged — confirmed by the "re-throws non-oauth errors unchanged" test.
- T-01-06-03 (Elevation of Privilege): `auth:"oauth"` forwarded as an enum value validated by `coerceAuth` (Plan 01). RPC contract further validates as `z.enum(["headers","oauth"]).optional()`. No escalation path.
- No new network endpoints, auth paths, file access patterns, or schema changes beyond what the threat model covers.

## Requirements Satisfied

- R8.4'-01: `mcp_manage` catches structured Error with `.data.needs_oauth_login === true` and returns actionable `content[0].text` hint ✓
  - Catch block at lines 329-351 in `mcp-manage-tool.ts`
  - `content[0].text` starts with `Run \`mcp_login(` and names the server
  - Non-oauth errors re-thrown unchanged
- R11-01: `mcp_manage` connect forwards `auth` field to `rpcCall("mcp.connect", ...)` via `coerceAuth` ✓
  - Confirmed by existing test at line 696 (`expect.objectContaining({ auth: "oauth" })`)
  - Wired in Plan 01; this plan verifies and closes the R11-01 execute-side consumer

## Self-Check: PASSED

- `grep -n "coerceAuth" mcp-manage-tool.ts` → 2 matches (line 205 definition + line 314 call) ✓
- `grep -n "needs_oauth_login" mcp-manage-tool.ts` → 3 matches (lines 330, 333, 337) ✓
- `grep -n "mcp_login" mcp-manage-tool.ts` → 3 matches (lines 85, 215, 344) ✓
- `grep -n "mcp_login" mcp-manage-tool.test.ts` → 2 matches (lines 777, 804) ✓
- All 38 tests pass ✓
- Commit `df250b0` exists (RED) ✓
- Commit `e1f81d2` exists (GREEN) ✓
- Gate order: `df250b0` (test) before `e1f81d2` (feat) ✓
