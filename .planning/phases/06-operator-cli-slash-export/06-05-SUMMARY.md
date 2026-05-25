---
phase: 06-operator-cli-slash-export
plan: "05"
subsystem: orchestrator
tags: [orchestrator, slash-command, owner-gate, dm-routing, tdd, export-trajectory, EXPORT-01]
dependency_graph:
  requires:
    - packages/core/src/api-contracts/observability.ts (ObsTraceExportContract — 06-02)
    - packages/daemon/src/api/obs-handlers/obs-trace.ts (bindObsTraceHandlers — 06-03)
  provides:
    - packages/orchestrator/src/commands/export-trajectory.ts (handleExportTrajectory)
    - packages/orchestrator/src/commands/command-parser.ts (export-trajectory in KNOWN_COMMANDS)
    - packages/orchestrator/src/inbound/inbound-gate.ts (special-case dispatch at line ~297)
    - packages/orchestrator/src/inbound/inbound-pipeline.ts (exportSessionBundle DI seam)
  affects:
    - Daemon wiring (packages/daemon/src/wiring/) — must populate exportSessionBundle dep
tech_stack:
  added: []
  patterns:
    - "Special-case dispatch BEFORE generic handleSlashCommand — needed because CommandResult is sync-shaped, cannot carry async DM side-effect"
    - "Owner gate: msg.senderId !== sessionKey.userId (established pattern from inbound-gate.ts:189)"
    - "DM target: msg.senderId as Telegram user ID == DM chat ID (research §6 / pitfall 7)"
    - "Group-first ack: group inline reply fires BEFORE export await — prompt UX even under slow export"
    - "DeliveryAdapter type alias for adapter parameter — ChannelPort is structurally compatible"
key_files:
  created:
    - packages/orchestrator/src/commands/export-trajectory.ts
    - packages/orchestrator/src/commands/export-trajectory.test.ts
  modified:
    - packages/orchestrator/src/commands/command-parser.ts
    - packages/orchestrator/src/commands/types.ts
    - packages/orchestrator/src/commands/index.ts
    - packages/orchestrator/src/inbound/inbound-gate.ts
    - packages/orchestrator/src/inbound/inbound-pipeline.ts
key_decisions:
  - "Approach 1 (plan-specified): special-case in inbound-gate BEFORE generic dispatch, not via CommandHandler.handle"
  - "Parser regex changed from /^\\/(\\w+)/ to /^\\/([\w-]+)/ to match hyphenated command names"
  - "SessionId derived via formatSessionKey(sessionKey) — matches Plan 06-03 obs-trace handler convention"
  - "DeliveryAdapter used as adapter type in handler interface — ChannelPort is structurally compatible"
  - "exportSessionBundle DI seam is optional in GateDeps and InboundPipelineDeps — backward-compatible with all existing tests"
metrics:
  duration: "~12min"
  completed: "2026-05-25"
  tasks_completed: 2
  files_created: 2
  files_modified: 5
---

# Phase 06 Plan 05: /export-trajectory Slash Command (EXPORT-01) Summary

**Owner-gated bundle export slash command: group chat sends inline ack + owner DM with path; DM sends bundle path inline; non-owner gets Access denied; bundle path never inline in group (asserted by negative Test 3).**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-25T02:49:35Z
- **Completed:** 2026-05-25T03:01:05Z
- **Tasks:** 2 (RED + GREEN)
- **Files created:** 2
- **Files modified:** 5

## Accomplishments

- `"export-trajectory"` added to `KNOWN_COMMANDS` — `parseSlashCommand("/export-trajectory")` returns `{ found: true, command: "export-trajectory" }`, so the text never reaches the LLM (STRIDE T-06-05-04)
- `CommandType` union extended with `"export-trajectory"` (type-safe `commandName as CommandType` cast)
- `handleExportTrajectory(deps)` in `packages/orchestrator/src/commands/export-trajectory.ts`:
  - Owner gate at entry: `msg.senderId !== sessionKey.userId` → sends "Access denied: /export-trajectory is owner-only." and returns `{ action: "handled" }` (STRIDE T-06-05-01)
  - Group path: fires inline ack "Bundle sent to owner DM." FIRST, then awaits export, then calls `adapter.sendMessage(msg.senderId, ...)` to DM the owner — bundle path NEVER goes to `deliverToChannel` in group context (STRIDE T-06-05-02)
  - DM path: awaits export, calls `deliverToChannel` with path + privacy reminder inline
  - Failure path: catches exception, sends "Bundle export failed: \<reason\>" inline, returns `{ action: "handled" }`; no exception bubbles up
- Special-case dispatch in `inbound-gate.ts` at line ~297, inserted BEFORE the generic `handleSlashCommand` block (plan-specified architecture per research §6 Approach 1)
- `InboundPipelineDeps` and `GateDeps` extended with optional `exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>` — backward-compatible with all existing tests
- 8/8 unit tests GREEN (2 parser + 6 handler)
- 91/91 existing inbound-gate tests GREEN (no regression)
- 175/175 existing command tests GREEN
- `pnpm validate` clean: build passes, lint:security 0 errors, 0 circular deps

## Dispatch Site (for reference)

**File:** `packages/orchestrator/src/inbound/inbound-gate.ts`

The special-case block is inserted at approximately line 297, immediately before the `// GENERAL SLASH COMMAND INTERCEPTION` block:

```typescript
if (
  msg.text &&
  msg.text.trim().startsWith("/export-trajectory") &&
  deps.exportSessionBundle
) {
  return await handleExportTrajectory({ ... });
}
```

## Owner-gate Pattern

`msg.senderId !== sessionKey.userId` — the same check used at `inbound-gate.ts:189` for send-policy gating (research §6 confirmed). The `senderId` is the authenticated Telegram user ID provided by the channel adapter.

## DM Target Convention

`msg.senderId` is used as the DM target chat ID. For Telegram, a user's numeric ID equals their DM chat ID (research §6 / pitfall 7). The channel adapter's `sendMessage(chatId, text)` API accepts this directly.

## exportSessionBundle DI Seam — Action Required

**The daemon wiring layer (`packages/daemon/src/wiring/`) must populate `exportSessionBundle`** before this slash command is live in production. Until that wiring is added, the special-case block in inbound-gate.ts will not fire (the `deps.exportSessionBundle` guard prevents it), and `/export-trajectory` will fall through to the generic `handleSlashCommand` block.

Two equivalent implementation options for the daemon wiring:

1. **Simpler (recommended):** Call `exportTrajectoryBundle` from Phase 4 directly:
   ```typescript
   exportSessionBundle: async (sessionId) => {
     const result = await exportTrajectoryBundle({ sessionFile: safePath(sessionsDir, sessionId + ".jsonl"), workspaceDir });
     if (!result.ok) throw new Error(result.error.message);
     return { bundlePath: result.value.bundleDir };
   }
   ```

2. **Via RPC (alternative):** Call the `ObsTraceExportContract` via a local in-process RPC client (same path as `comis trace export` from Plan 06-04). Both reach the same Phase 4 pipeline.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | RED — export-trajectory.test.ts | 6fefb54 | export-trajectory.test.ts (NEW) |
| 2 | GREEN — parser, handler, inbound-gate wiring | e07459c | export-trajectory.ts (NEW), command-parser.ts, types.ts, index.ts, inbound-gate.ts, inbound-pipeline.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Parser regex `\w+` does not match hyphenated command names**
- **Found during:** Task 2 (GREEN phase) — build verification; `/export-trajectory` would have returned `found: false` due to hyphen
- **Issue:** The regex `/^\/(\\w+)(?:\\s+(.*))?$/s` matches only word characters (letters, digits, `_`). Hyphens are not matched, so `/export-trajectory` would split at the hyphen and only capture `export` as the command name — failing the KNOWN_COMMANDS lookup and passing text to the LLM
- **Fix:** Changed regex to `/^\\/([\w-]+)(?:\\s+(.*))?$/s` — `[\w-]+` matches hyphens in command names
- **Files modified:** `packages/orchestrator/src/commands/command-parser.ts`
- **Commit:** e07459c

**2. [Rule 1 - Bug] `SessionKey` does not have a `channelType` field**
- **Found during:** Task 2 (GREEN phase) — TypeScript build error TS2339
- **Issue:** Plan's `formatSessionKeyForId` helper used `key.channelType` which does not exist on `SessionKey` (its fields are `tenantId`, `userId`, `channelId`, `peerId`, `guildId`, `agentId`, `threadId`)
- **Fix:** Replaced the inline helper with `formatSessionKey(sessionKey)` from `@comis/core` (returns `tenantId:userId:channelId[:peer:peerId]...`), which is the same convention used by Plan 06-03's obs-trace handler
- **Files modified:** `packages/orchestrator/src/commands/export-trajectory.ts`
- **Commit:** e07459c

**3. [Rule 1 - Bug] `deliverToChannel` type mismatch: `adapter: unknown` vs `adapter: DeliveryAdapter`**
- **Found during:** Task 2 (GREEN phase) — TypeScript build error TS2322
- **Issue:** `HandleExportTrajectoryDeps.deliveryService.deliverToChannel` had `adapter: unknown` while `DeliveryService` (passed from `deps.deliveryService` in inbound-gate.ts) expects `adapter: DeliveryAdapter`
- **Fix:** Changed handler interface to use `adapter: DeliveryAdapter` and `opts?: DeliverToChannelOptions` (both from `@comis/core`). `ChannelPort` is structurally compatible with `DeliveryAdapter` so inbound-gate.ts passes the adapter correctly
- **Files modified:** `packages/orchestrator/src/commands/export-trajectory.ts`
- **Commit:** e07459c

**4. [Rule 1 - Bug] Test 6 `process.cwd()` path resolution fails when run from workspace root**
- **Found during:** Task 2 (GREEN phase) — Test 6 passed from package but needed `import.meta.url`-based resolution for workspace-root `pnpm test`
- **Issue:** Plan template used `path.join(process.cwd(), "src/commands/command-parser.ts")` which resolves to workspace root when tests run via `pnpm test` (not `cd packages/orchestrator && pnpm test`)
- **Fix:** Used `path.dirname(url.fileURLToPath(import.meta.url))` to resolve relative to the test file itself — works from both workspace root and package directory
- **Files modified:** `packages/orchestrator/src/commands/export-trajectory.test.ts`
- **Commit:** e07459c

---

**Total deviations:** 4 auto-fixed (4 × Rule 1 — bugs caught during GREEN phase)
**Impact on plan:** All required for correctness. No scope creep.

## Known Stubs

None. The handler is fully wired. The `exportSessionBundle` DI seam is intentionally left to daemon wiring (documented above) — the handler is complete; only the production injection is deferred. This is not a stub: the slash command will silently no-op in production until daemon wiring provides the dep, which is explicitly documented.

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`. All mitigations implemented:
- T-06-05-01: Owner gate enforced at handler entry (Test 1 + Test 5)
- T-06-05-02: Bundle path never passed to `deliverToChannel` in group context — Test 3 negative assertion: `expect(inlineTexts.some(t => t.includes("/tmp/bundle-xyz"))).toBe(false)`
- T-06-05-04: `"export-trajectory"` in `KNOWN_COMMANDS` → `found: true` → inbound-gate returns `{ action: "handled" }` before executor (Test P1 + P2)

## Self-Check: PASSED

- [x] `packages/orchestrator/src/commands/export-trajectory.ts` exists with `handleExportTrajectory`
- [x] `packages/orchestrator/src/commands/export-trajectory.test.ts` exists with 8 tests
- [x] RED commit 6fefb54 exists (test-only, all tests fail)
- [x] GREEN commit e07459c exists (all 8 tests pass)
- [x] Test commit (6fefb54) is BEFORE production commit (e07459c) in git log
- [x] `grep -c "export-trajectory" command-parser.ts` returns 2 (KNOWN_COMMANDS + regex comment)
- [x] `grep -c "export-trajectory" types.ts` returns 1 (CommandType union)
- [x] `grep -n "handleExportTrajectory" inbound-gate.ts` confirms dispatch at ~line 306
- [x] `grep -n "msg.senderId !== sessionKey.userId" export-trajectory.ts` confirms owner gate at line 69
- [x] `grep -n "Bundle sent to owner DM" export-trajectory.ts` confirms group ack literal
- [x] `grep -n "adapter.sendMessage" export-trajectory.ts` confirms DM delivery
- [x] 8/8 export-trajectory unit tests GREEN
- [x] 91/91 existing inbound-gate tests GREEN
- [x] 175/175 existing command tests GREEN
- [x] `pnpm build` clean (0 TypeScript errors)
- [x] `pnpm lint:security` 0 errors
- [x] `pnpm cycles` no circular dependencies
