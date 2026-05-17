# DaemonApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:461–466`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 2 (2 required + 0 optional + 0 stale-fallback)
**Co-location:** packaged with @comis/daemon. The `files: ["dist", "bundled-skills"]` declaration in `packages/daemon/package.json` excludes this audit doc from the npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| logLevelManager | required | — | packages/daemon/src/api/types.ts:464 |
| logger | required | — | packages/daemon/src/api/types.ts:466 |

## Removed Fields (stale-fallback — deleted)

**None.** DaemonApiDeps is the smallest slice (2 required fields). Both are wired unconditionally by `buildRpcDispatchDeps` (`daemon.ts:1863`) — `logLevelManager` is constructed in `setup-foundation.ts` and `logger` is the daemon-wide pino instance threaded through every cluster slice for multi-extends parity.

## Summary

- **Pre-audit count:** 2
- **Final count:** 2 (2 required + 0 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `DaemonApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
