# AgentsApiDeps Audit (Phase 34)

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:179–209`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 11 (4 required + 7 optional + 0 stale-fallback)
**OQ-1 resolution:** Option B (co-located with @comis/daemon package). `feedback_no_planning_commits` policy + `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| suspendedAgents | required | — | packages/daemon/src/api/types.ts:183 |
| hotAdd | optional | agents.create RPC fails with an explicit "hot-add not supported" error; new agents require a daemon restart to take effect | packages/daemon/src/api/types.ts:185 |
| hotRemove | optional | agents.delete RPC fails with an explicit "hot-remove not supported" error; deleted agents linger in memory until daemon restart | packages/daemon/src/api/types.ts:187 |
| modelCatalog | required | — | packages/daemon/src/api/types.ts:189 |
| oauthCredentialStore | optional | agents.update skips the `oauthProfiles[provider]` existence validation block (no-op); the update proceeds and any mismatch surfaces at agent runtime | packages/daemon/src/api/types.ts:194 |
| agents | required | — | packages/daemon/src/api/types.ts:199 |
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:201 |
| persistDeps | optional | agents.update / providers.update runtime config changes are NOT persisted to config.yaml; reverts on next daemon restart (in-memory only) | packages/daemon/src/api/types.ts:203 |
| secretManager | optional | agent / provider handlers skip the secret-existence checks for `apiKey` env-refs; misconfigured refs are tolerated at update time and surface later as runtime errors | packages/daemon/src/api/types.ts:205 |
| providerEntries | optional | providers.list returns an empty array; model.list cannot enumerate per-provider models; defaults flow through PerAgentConfig only | packages/daemon/src/api/types.ts:207 |
| modelsConfig | optional | agent-handlers' credential resolver cannot fall back to the global `defaultProvider`; agents without an explicit provider override fail credential resolution | packages/daemon/src/api/types.ts:209 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate documented above. `hotAdd` / `hotRemove` are runtime-mutation callbacks the daemon supplies after agent-runtime init; `persistDeps` is the YAML-write surface (omitted in tests so file I/O is bypassed); `secretManager` / `providerEntries` / `modelsConfig` are configuration sources whose absence triggers a documented degraded path.

## Summary

- **Pre-audit count:** 11
- **Final count:** 11 (4 required + 7 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `AgentsApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
