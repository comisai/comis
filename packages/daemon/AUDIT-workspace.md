# WorkspaceApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:253–307`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 19 (13 required + 6 optional + 0 stale-fallback)
**Packaging:** Co-located with the `@comis/daemon` package; `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes this audit doc from the npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| getAgentBrowserService | required | — | packages/daemon/src/api/types.ts:257 |
| approvalGate | optional | approval.list / approval.respond / approval.requestApproval RPCs fail with "approval gate unavailable"; agent runs that need approval block indefinitely | packages/daemon/src/api/types.ts:259 |
| mcpClientManager | required | — | packages/daemon/src/api/types.ts:263 |
| skillRegistries | optional | skill.list returns an empty array for the affected agent(s); user-invocable skill commands fall through to the agent as plain text | packages/daemon/src/api/types.ts:265 |
| notificationService | optional | notification.send and proactive-notification triggers are not delivered; notify-related RPCs return "notification service disabled" | packages/daemon/src/api/types.ts:267 |
| execGit | required | — | packages/daemon/src/api/types.ts:269 |
| agents | required | — | packages/daemon/src/api/types.ts:271 |
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:273 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:275 |
| workspaceDirs | required | — | packages/daemon/src/api/types.ts:277 |
| logger | required | — | packages/daemon/src/api/types.ts:279 |
| tenantId | required | — | packages/daemon/src/api/types.ts:283 |
| memoryApi | required | — | packages/daemon/src/api/types.ts:286 |
| memoryAdapter | required | — | packages/daemon/src/api/types.ts:289 |
| container | required | — | packages/daemon/src/api/types.ts:291 |
| eventBus | optional | skill lifecycle events (`skill:enabled`, `skill:disabled`, etc.) are not emitted; observers and audit consumers do not learn of skill state changes | packages/daemon/src/api/types.ts:293 |
| secretManager | optional | mcp-handlers' env-ref validation is skipped (`mcp-handlers` reads `deps.secretManager?.has`); MCP server configs with missing env refs fail later at connect time | packages/daemon/src/api/types.ts:295 |
| secretStore | required | — | packages/daemon/src/api/types.ts:304 |
| persistDeps | optional | mcp-handlers' YAML writes via `persistMcpServers` become best-effort no-ops; MCP server registrations succeed at runtime but do not persist to `config.yaml`, so subsequent daemon restarts forget them | packages/daemon/src/api/types.ts:293 |
| createTokenStore | optional | mcp-handlers' token-aware short-circuit for `auth:"oauth"` connects is skipped; `manager.connect` runs blind even when no token exists, the SDK's DCR fails with `invalid_redirect_uri` (Comis only carries a real redirect URI during `mcp.oauth_login`), and the user gets the raw error instead of the `needs_oauth_login` hint. Test harnesses omit this field and rely on the post-failure persist path | packages/daemon/src/api/types.ts:319 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate documented above. `approvalGate`, `skillRegistries`, `notificationService` are configurable subsystems with explicit fallback behavior; `eventBus` and `secretManager` are observability / validation hooks that the handlers query defensively with `?.` so absence is non-fatal. `secretStore` is required — always wired with a file/encrypted/env adapter so mcp-handlers always have a backend for static-secret header extraction.

## Summary

- **Pre-audit count:** 18
- **Final count:** 19 (13 required + 6 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `WorkspaceApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
