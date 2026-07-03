# ConfigApiDeps Audit

**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts`
**Construction site:** `packages/daemon/src/daemon.ts` (`buildRpcDispatchDeps`)
**Field count:** 12 (8 required + 4 optional + 0 stale-fallback)
**Co-location:** This audit doc lives alongside @comis/daemon package source. The `files: ["dist", "bundled-skills"]` entry in `packages/daemon/package.json` excludes it from the npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| container | required | — | packages/daemon/src/api/types.ts:303 |
| configPaths | required | — | packages/daemon/src/api/types.ts:304 |
| defaultConfigPaths | required | — | packages/daemon/src/api/types.ts:305 |
| daemonVersion | required | — | packages/daemon/src/api/types.ts:456 |
| configGitManager | optional | config.patch / config.reload skip the git auto-commit / hash-snapshot flow; changes still take effect but are not versioned in the config-history repo | packages/daemon/src/api/types.ts:306 |
| configWebhook | optional | config.patch / config.reload do not POST a change notification to an external webhook; downstream subscribers must poll | packages/daemon/src/api/types.ts:307 |
| envFilePath | required | — | packages/daemon/src/api/types.ts:309 |
| logger | required | — | packages/daemon/src/api/types.ts:312 |
| oauthCredentialStore | optional | config.patch skips the agent-`oauthProfiles[provider]`-existence credential guard; OAuth profile typos are not caught at patch time and surface later at agent runtime | packages/daemon/src/api/types.ts:317 |
| secretStore | required | — | packages/daemon/src/api/types.ts:380 |
| mutableSecretManager | required | — | packages/daemon/src/api/types.ts:384 |
| auditEnabled | optional | config.patch RPC handler treats undefined as default-true (`!== false` semantics); the config-audit JSONL append at config-write.ts:124+395 runs. Only an explicit `false` skips both halves of the two-phase audit hook. Wired from `container.config.diagnostics?.configAudit?.enabled !== false` at rpc-dispatch.ts:109+ | packages/daemon/src/api/types.ts:388 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate documented above. `configGitManager` and `configWebhook` are operator-configured audit/notification subsystems; `oauthCredentialStore` is a credential-validation hook that mirrors the same field on AgentsApiDeps + AuthApiDeps (multi-extends parity); `auditEnabled` honors `diagnostics.configAudit.enabled` and gates the config.patch JSONL append. `secretStore` is required — the adapter is always wired (file/encrypted/env) so env.set always has a backend.

## Summary

- **Pre-audit count:** 10
- **Final count:** 12 (8 required + 4 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `ConfigApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
