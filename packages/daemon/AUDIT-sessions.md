# SessionsApiDeps Audit (Phase 34)

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:63–100`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 14 (11 required + 3 optional + 0 stale-fallback)
**OQ-1 resolution:** Option B (co-located with @comis/daemon package). `feedback_no_planning_commits` policy + `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:66 |
| agents | required | — | packages/daemon/src/api/types.ts:67 |
| costTrackers | required | — | packages/daemon/src/api/types.ts:68 |
| stepCounters | required | — | packages/daemon/src/api/types.ts:69 |
| agentDataDir | optional | session.list skips the JSONL-scan branch (`session-handlers.ts:285` `if (deps.agentDataDir)`); only sessionStore entries are returned | packages/daemon/src/api/types.ts:71 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:73 |
| sessionStore | required | — | packages/daemon/src/api/types.ts:74 |
| crossSessionSender | required | — | packages/daemon/src/api/types.ts:88 |
| subAgentRunner | required | — | packages/daemon/src/api/types.ts:89 |
| securityConfig | required | — | packages/daemon/src/api/types.ts:90 |
| tenantId | required | — | packages/daemon/src/api/types.ts:91 |
| logger | required | — | packages/daemon/src/api/types.ts:95 |
| approvalGate | optional | session.delete / session.reset skip approval-cache clearing (`session-handlers.ts:899` `deps.approvalGate?.clearApprovalCache`); no-op when absent | packages/daemon/src/api/types.ts:98 |
| summarizeSession | optional | session.search returns raw matches without an LLM-summary (`session-handlers.ts:498` gate); only fires when both `shouldSummarize` and the dep are truthy | packages/daemon/src/api/types.ts:100 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field has a verified production absent-mode code path: `agentDataDir` gates the JSONL session scan, `approvalGate` gates approval-cache clearing on session.delete/reset, `summarizeSession` gates the LLM summarization branch of session.search. Daemon wires all three unconditionally in `buildRpcDispatchDeps` when their upstream prerequisites exist; tests omit them to exercise the absent-branch paths.

## Summary

- **Pre-audit count:** 14
- **Final count:** 14 (11 required + 3 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `SessionsApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
