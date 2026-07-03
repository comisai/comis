# AuthApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts`
**Construction site:** `packages/daemon/src/daemon.ts` (`buildRpcDispatchDeps`)
**Field count:** 9 (7 required + 2 optional + 0 stale-fallback)
**Storage:** co-located with `@comis/daemon` package. `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from the npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| secretStore | required | — | packages/daemon/src/api/types.ts:402 |
| mutableSecretManager | required | — | packages/daemon/src/api/types.ts:405 |
| tokenRegistry | required | — | packages/daemon/src/api/types.ts:411 |
| addToTokenStore | required | — | packages/daemon/src/api/types.ts:416 |
| removeFromTokenStore | required | — | packages/daemon/src/api/types.ts:417 |
| oauthCredentialStore | optional | auth.oauth.list returns an empty profile list; auth.oauth.delete fails with "credential store unavailable" — OAuth profile management is disabled | packages/daemon/src/api/types.ts:421 |
| container | required | — | packages/daemon/src/api/types.ts:426 |
| logger | required | — | packages/daemon/src/api/types.ts:429 |
| persistDeps | optional | tokens.create / tokens.revoke runtime token mutations are NOT persisted to config.yaml; tokens revert on next daemon restart (in-memory only) | packages/daemon/src/api/types.ts:434 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate documented above. `oauthCredentialStore` is the OAuth-profile management surface (mirrored to AgentsApiDeps + ConfigApiDeps for multi-extends parity); `persistDeps` is the YAML-write surface (omitted in tests so file I/O is bypassed). `secretStore` is required — always wired with a file/encrypted/env adapter; secrets.set/delete/list/get always have a backend.

## Summary

- **Pre-audit count:** 8
- **Final count:** 9 (7 required + 2 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `AuthApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
