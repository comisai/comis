---
phase: 06-operator-cli-slash-export
plan: "04"
subsystem: cli
tags: [cli, commander, observability, typed-rpc, tdd, cli-01, cli-02, cli-03, cli-04, cli-05, cli-07]
dependency_graph:
  requires:
    - packages/core/src/api-contracts/observability.ts (ObsTrace* contracts — 06-02)
    - packages/daemon/src/api/obs-handlers/obs-trace.ts (handlers — 06-03)
  provides:
    - packages/cli/src/commands/trace.ts (registerTraceCommand)
  affects:
    - packages/cli/src/cli.ts (22 total registered commands, was 21)
    - test/support/public-api-policy.ts (3 planned-orphan entries removed)
tech_stack:
  added: []
  patterns:
    - "Commander.js subcommand + options combined on root command for multi-mode (not sub-sub-commands)"
    - "AbortController + process.once(SIGINT) for clean polling loop exit"
    - "callTyped(client, Contract, params) via withClient — typed RPC discipline"
    - "--json boolean flag: json() vs renderTable() routing per CLI-07"
key_files:
  created:
    - packages/cli/src/commands/trace.ts
    - packages/cli/src/commands/trace.test.ts
  modified:
    - packages/cli/src/cli.ts
    - packages/cli/src/cli.test.ts
    - test/support/public-api-policy.ts
key_decisions:
  - "--json boolean flag (not --format value) per CONTEXT.md decision 7 + init.ts/secrets.ts precedent"
  - "All 4 search modes (--message-id, --trace-id, --chat, --since/--where) handled by single trace root command options rather than separate sub-sub-commands"
  - "Polling interval 1 second; AbortController abort on SIGINT via process.once; loop exits after current poll + sleep completes"
  - "Planned-orphan entries for ObsTraceExportContract, ObsTraceSearchContract, ObsTraceTailContract removed from public-api-policy.ts now that CLI consumer exists"
requirements_completed: [CLI-01, CLI-02, CLI-03, CLI-04, CLI-05, CLI-07]
metrics:
  duration_minutes: 23
  completed_date: "2026-05-25"
  tasks_completed: 2
  files_created: 2
  files_modified: 3
---

# Phase 06 Plan 04: CLI `comis trace` Subcommands (CLI-01..05, CLI-07) Summary

**New `packages/cli/src/commands/trace.ts` with 5 subcommands (`--message-id`, `--trace-id`, `--chat --tail`, `--since/--where`, `export`) all calling daemon RPC contracts via `callTyped`; --json flag on every mode; arch test green.**

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | RED — trace.test.ts behavior tests | a42b053 | packages/cli/src/commands/trace.test.ts (NEW) |
| 2 | GREEN — trace.ts + cli.ts + fixes | 17c9cca | trace.ts (NEW), cli.ts, cli.test.ts, public-api-policy.ts |

## 5 Subcommand Shapes

| CLI-ID | Command | Contract | Key Params |
|--------|---------|----------|------------|
| CLI-01 | `comis trace --message-id <uuid>` | `ObsTraceSearchContract` | `{ messageId }` |
| CLI-02 | `comis trace --trace-id <uuid>` | `ObsTraceSearchContract` | `{ traceId }` |
| CLI-03 | `comis trace --chat <chatId> --tail` | `ObsTraceTailContract` | `{ chatId, sinceMs, limit: 100 }` |
| CLI-04 | `comis trace --since <dur> --where <filter>` | `ObsTraceSearchContract` | `{ since, where }` |
| CLI-05 | `comis trace export <sessionId>` | `ObsTraceExportContract` | `{ sessionId }` |

All subcommands accept `--json` (boolean, not `--format`). Without `--json`: columnar output via `renderTable()`. With `--json`: `json(result)` outputs formatted JSON.

## `--tail` Polling Details

- **Contract:** `ObsTraceTailContract` (`obs.trace.tail`)
- **Poll interval:** 1 second (via `setTimeout(resolve, 1000)`)
- **Cursor:** `nextSinceMs` from each response is passed as `sinceMs` on the next call
- **Exit pattern:** `AbortController` + `process.once("SIGINT", () => abort.abort())`. The loop checks `abort.signal.aborted` at the top of each iteration; the 1s sleep also listens for `abort` via `AbortSignal.addEventListener("abort", ...)` with `{ once: true }` so it resolves immediately on SIGINT.
- **Limit:** 100 events per poll (constrained by `ObsTraceTailContract` schema max=100)

## `cli-uses-typed-rpc.test.ts` Arch Test

```
$ pnpm vitest run test/architecture/cli-uses-typed-rpc.test.ts
Tests  2 passed (2)
```

`trace.ts` contains ZERO occurrences of `client.call(`. All three RPC call sites use `callTyped(client, Contract, params)` within `withClient(async (client) => ...)`.

```bash
grep -c "client\.call(" packages/cli/src/commands/trace.ts
# => 0
grep -c "callTyped" packages/cli/src/commands/trace.ts
# => 5
```

## Requirements Closed

| ID | Description |
|----|-------------|
| CLI-01 | `comis trace --message-id <uuid>` works |
| CLI-02 | `comis trace --trace-id <uuid>` returns trace rows |
| CLI-03 | `comis trace --chat <chatId> --tail` polls and streams events |
| CLI-04 | `comis trace --since 10m --where error` returns recent failures |
| CLI-05 | `comis trace export <sessionId>` prints bundle path |
| CLI-07 | Every subcommand has `--json` boolean flag; without it, columnar output via renderTable |

Note: CLI-06 (three new RPC contracts) was closed by Plan 06-02 and Plan 06-03.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] cli.test.ts command count stale after adding trace command**
- **Found during:** Task 2 (GREEN phase) — `pnpm validate` ran `cli.test.ts`
- **Issue:** `cli.test.ts` had `expect(program.commands).toHaveLength(21)` and `expectedCommands` array missing `"trace"`. Adding `registerTraceCommand(program)` in cli.ts made the count 22.
- **Fix:** Updated count assertion 21 → 22; added `"trace"` to `expectedCommands` array.
- **Files modified:** `packages/cli/src/cli.test.ts`
- **Commit:** 17c9cca

**2. [Rule 2 - Architecture] planned-orphan entries removable now that CLI consumer exists**
- **Found during:** Task 2 (GREEN phase) — post-commit check of public-api-policy.ts
- **Issue:** Plan 06-02 added 3 planned-orphan policy entries for `ObsTraceExportContract`, `ObsTraceSearchContract`, `ObsTraceTailContract` because the CLI consumer didn't exist yet. The entries include a comment "Remove these three entries once Plan 06-03 lands." Plan 06-03 landed, and now Plan 06-04 adds the CLI consumer.
- **Fix:** Removed the 3 planned-orphan entries from `test/support/public-api-policy.ts`.
- **Files modified:** `test/support/public-api-policy.ts`
- **Commit:** 17c9cca

**3. [Rule 3 - Bug] Tail tests initially used incorrect timer/SIGINT pattern causing infinite loops**
- **Found during:** Task 2 (GREEN phase) — `pnpm vitest run src/commands/trace.test.ts` output showed infinite poll output
- **Issue:** Original tail tests used `vi.runAllTimersAsync()` which re-invoked itself indefinitely since the mock `withClient` resolves synchronously (no real 1s delay). The SIGINT emission via `process.emit("SIGINT")` didn't reach the test's `parseAsync` scope.
- **Fix:** Rewrote both tail tests to: (1) emit SIGINT from inside the `withClient` mock via `setImmediate` after N calls, (2) use `vi.advanceTimersByTimeAsync(1100)` to advance fake timers past the poll interval, (3) changed `resolves.toBeUndefined()` to `resolves.toBeDefined()` since `parseAsync` returns `Promise<Command>`.
- **Files modified:** `packages/cli/src/commands/trace.test.ts`
- **Commit:** 17c9cca (included in updated test file)

## Known Stubs

None. All 5 subcommands are fully wired to real daemon RPC contracts via `callTyped`. The `--tail` loop uses a real `AbortController`. The `export` subcommand returns the real `bundlePath` from the daemon.

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`. The four mitigations from T-06-04-01 through T-06-04-04 are in place:
- T-06-04-01: Daemon-side admin gate (Plan 06-03 Tests 2/7) — CLI layer is untrusted by design
- T-06-04-02: `cli-uses-typed-rpc.test.ts` arch test is GREEN; trace.ts has zero `client.call(` occurrences
- T-06-04-03: Accepted (operator-trusted data; bundle path is already-redacted Phase 5 path)
- T-06-04-04: 1s polling interval; daemon caps at limit=100; SIGINT aborts loop cleanly (Test 8)

## Pre-existing Deferred Issue

`packages/web/src/views/session-list.test.ts` emits an unhandled `TypeError: URL is not a constructor` at line 296 during `pnpm validate`. This causes vitest to report 1308 total files but only 1307 passing. This is pre-existing before Plan 06-04 and is not caused by any change in this plan. Logged as a deferred item.

## Self-Check: PASSED

- [x] `packages/cli/src/commands/trace.ts` exists with `registerTraceCommand`
- [x] RED commit a42b053 exists: `git log --oneline | grep a42b053`
- [x] GREEN commit 17c9cca exists: `git log --oneline | grep 17c9cca`
- [x] Test commit (a42b053) is BEFORE production commit (17c9cca) in git log
- [x] `cli.ts` imports and invokes `registerTraceCommand`
- [x] All 10 unit tests GREEN
- [x] `cli-uses-typed-rpc.test.ts` GREEN (2 tests passed)
- [x] `grep -c "client\.call(" trace.ts` returns 0
- [x] `grep -c "callTyped" trace.ts` returns 5 (≥3 required)
- [x] `grep -c "ObsTrace*Contract" trace.ts` returns 8 (≥3 required)
- [x] `node packages/cli/dist/cli.js trace --help` lists all subcommands
- [x] pnpm build clean (all packages compiled successfully)
