---
phase: 01-handoff-mcp-oauth-handoff
plan: 03
subsystem: mcp
tags: [mcp, oauth, agent-tool, platform-tools, pkce, trust-guard]

requires:
  - phase: 01-01
    provides: mcp_manage auth:oauth field and schema foundation for OAuth flow initiation

provides:
  - mcp_login agent tool (plain AgentTool + createTrustGuard admin) wrapping mcp.oauth_login RPC
  - authUrl surfaced as content[0].text (first block, no prose) for recoverEmptyFinalResponse capture
  - Status fallback text when authUrl absent
  - Registry and index.ts export wiring (tool visible to daemon's setup-tools)

affects:
  - 01-04 (tool-guide steers agents through mcp_manage(auth:oauth) then mcp_login)
  - any agent assembling platform tools (mcp_login now in the registry)

tech-stack:
  added: []
  patterns:
    - "plain AgentTool<T> + createTrustGuard for single-action admin tools (vs createAdminManageTool for multi-action)"
    - "content[0].text = raw URL (no prose) for recoverEmptyFinalResponse / activity renderer capture"
    - "vi.mock(@comis/core, importOriginal) + runWithContext(admin) pattern for trust-gated tool tests"

key-files:
  created:
    - packages/skills/src/platform-tools/tools/mcp-login-tool.ts
    - packages/skills/src/platform-tools/tools/mcp-login-tool.test.ts
  modified:
    - packages/skills/src/platform-tools/index.ts
    - packages/skills/src/platform-tools/registry.ts
    - packages/daemon/src/wiring/setup-tools.test.ts

key-decisions:
  - "Plain AgentTool<T> chosen over createAdminManageTool — single-action tool does not need action enum overhead (PATTERNS.md Pattern Pitfall 2)"
  - "authUrl must be content[0].text with NO prose wrapping — recoverEmptyFinalResponse picks up first text block"
  - "Status fallback string used when authUrl absent: 'OAuth login status: <status>' — avoids silent empty content"
  - "mcp.core build required before test execution — dist/exports/activity.js missing from stale dist (activity module added in HEAD commit e52ae3d)"

requirements-completed: [R11-02]

duration: 15min
completed: 2026-05-28
---

# Phase 01 Plan 03: mcp_login Agent Tool Summary

**New `mcp_login` admin-trust-gated agent tool wrapping `mcp.oauth_login` RPC, returning authUrl as `content[0].text` for executor-response-filter capture**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-28T13:17:00Z
- **Completed:** 2026-05-28T13:27:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 5

## Accomplishments

- Created `mcp-login-tool.ts` — plain `AgentTool<T>` factory with `createTrustGuard("mcp_login")` (admin level), TypeBox schema `{ server_name: string }`, `registerActivityLabelSpec`, and execute body surfacing `authUrl` as `content[0].text`
- RED test committed first: dynamic import of not-yet-existing tool file asserts import throws
- GREEN: 5 passing tests via `runWithContext(admin)` — authUrl in content[0], status fallback, trust guard blocking guest callers, rpcCall dispatch with correct method/params
- Registered `mcp_login` in `registry.ts` (mcp category, after `mcp_manage`) and exported from `index.ts`
- Added `mcp_login` mock to `setup-tools.test.ts` registry — 49 tests passing

## Task Commits

1. **RED: mcp_login tool missing** - `0d8a984` (test)
2. **GREEN: add mcp_login agent tool wrapping mcp.oauth_login** - `a38905c` (feat)

## Files Created/Modified

- `packages/skills/src/platform-tools/tools/mcp-login-tool.ts` — New tool factory (authUrl as content[0].text, trust guard, status fallback)
- `packages/skills/src/platform-tools/tools/mcp-login-tool.test.ts` — RED + GREEN tests (skipped RED gate, 5 GREEN assertions)
- `packages/skills/src/platform-tools/index.ts` — Added `export { createMcpLoginTool }` after `createMcpManageTool`
- `packages/skills/src/platform-tools/registry.ts` — Added import + `{ name: "mcp_login", category: "mcp", build: ... }` entry after mcp_manage
- `packages/daemon/src/wiring/setup-tools.test.ts` — Added `mockCreateMcpLoginTool` hoisted mock + descriptor in registry mock

## Decisions Made

- Plain `AgentTool<T>` chosen (not `createAdminManageTool`) — single-action tools don't need the action enum overhead. PATTERNS.md Pitfall 2 confirmed this is correct for a tool with one operation.
- `authUrl` surfaces as `content[0].text` with no prose prefix — required for `recoverEmptyFinalResponse` to capture it in the synthesis branch, and for the activity renderer.
- Status fallback `"OAuth login status: <status>"` when authUrl absent — avoids silent empty content block for error states.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Built @comis/core to compile missing activity module**
- **Found during:** GREEN phase test execution
- **Issue:** `dist/exports/activity.js` missing from `@comis/core/dist` — `registerActivityLabelSpec` (added in HEAD commit e52ae3d) not yet compiled. All platform-tool tests importing it from `@comis/core` were failing with "registerActivityLabelSpec is not a function".
- **Fix:** Ran `pnpm --filter @comis/core build` to compile the activity module into dist.
- **Files modified:** `packages/core/dist/` (generated, not committed — dist is gitignored)
- **Verification:** `dist/exports/activity.js` exists post-build; GREEN tests pass.
- **Impact:** Pre-existing issue from HEAD; does not affect committed files.

**2. [Rule 3 - Blocking] Created node_modules symlink in worktree for test execution**
- **Found during:** GREEN phase test execution
- **Issue:** Worktree at `.claude/worktrees/agent-a529e2d2736b4188d/` has no `node_modules`. Running vitest from worktree package root couldn't resolve `typebox`, `@comis/core`, etc.
- **Fix:** Symlinked `packages/skills/node_modules` from main repo into worktree's `packages/skills/node_modules`. Symlink is gitignored (`node_modules/` in `.gitignore`).
- **Files modified:** None committed. Runtime symlink only.
- **Verification:** Tests pass with the symlink present.

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking test execution)
**Impact on plan:** Both fixes necessary for test execution in worktree context. No scope creep. No committed code changes outside plan scope.

## Known Stubs

None — `mcp_login` tool is fully implemented. The `authUrl` value comes from the daemon's `mcp.oauth_login` RPC response; no hardcoded values.

## Threat Flags

No new threat surface. The tool wraps an existing RPC (`mcp.oauth_login`) that already has daemon-side guards (`findServerEntry` validation, `auth:"oauth"` requirement). Trust gate (`createTrustGuard("mcp_login")`) is the tool-layer mitigation as specified in the threat model (T-01-03-01). No new network endpoints introduced.

## Self-Check

- [x] `packages/skills/src/platform-tools/tools/mcp-login-tool.ts` exists
- [x] `packages/skills/src/platform-tools/index.ts` exports `createMcpLoginTool`
- [x] `packages/skills/src/platform-tools/registry.ts` has 2+ references to `createMcpLoginTool`
- [x] `packages/skills/src/platform-tools/registry.ts` has `"mcp_login"` entry
- [x] `mcp-login-tool.ts` contains `mcp.oauth_login` call
- [x] `mcp-login-tool.ts` contains `content[0]` pattern
- [x] `mcp-login-tool.ts` contains `createTrustGuard`
- [x] `mcp-login-tool.test.ts` tests pass (5 passed, 1 skipped)
- [x] `setup-tools.test.ts` passes (49 tests)
- [x] Git log: `test(01-R11.2):` (RED, 0d8a984) then `feat(01-R11.2):` (GREEN, a38905c)

## Self-Check: PASSED

## Next Phase Readiness

Plan 03 satisfies R11-02 (mcp_login tool). The agent now has a structured path to start the PKCE OAuth flow via `mcp_login({ server_name })`. The tool is in the daemon's tool registry and will be surfaced to agents on the next assembly.

Plans 01-01 (mcp_manage auth:oauth schema) and 01-02 (transport-401 detection) are prerequisite context for end-to-end OAuth flow. Plan 01-04 (tool-guide steering text) will steer agents to the `mcp_login` tool path.

---
*Phase: 01-handoff-mcp-oauth-handoff*
*Completed: 2026-05-28*
