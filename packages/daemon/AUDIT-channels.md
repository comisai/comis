# ChannelsApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:139–170`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 15 (9 required + 6 optional + 0 stale-fallback)
**Location:** co-located with the `@comis/daemon` package; `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| adaptersByType | required | — | packages/daemon/src/api/types.ts:147 |
| inboundMessageIdResolver | optional | message.delete / message.edit / message.react fall back to using the daemon NormalizedMessage.id directly; platform-native id mapping is skipped (compat path for daemon configs with all channel adapters disabled) | packages/daemon/src/api/types.ts:151 |
| channelConfig | required | — | packages/daemon/src/api/types.ts:152 |
| wsConnections | optional | gateway broadcasts (channel.list updates, message.new events) are suppressed; clients must re-poll RPC for state | packages/daemon/src/api/types.ts:154 |
| mediaDir | optional | message-handlers cannot resolve attachment URLs into local file paths; outbound media is delivered by URL reference only | packages/daemon/src/api/types.ts:155 |
| onGatewayAttachment | optional | no gateway-attachment lifecycle callback fires; deliveryQueue does not learn of the WebSocket gateway and waits indefinitely | packages/daemon/src/api/types.ts:156 |
| deliveryQueue | optional | message.send / message.reply bypass the persistent delivery queue and call adapter.sendMessage directly; ack tracking is disabled | packages/daemon/src/api/types.ts:158 |
| deliveryService | required | — | packages/daemon/src/api/types.ts:163 |
| healthMonitor | optional | channel.list does not include health-status fields; channel.start does not register a health probe | packages/daemon/src/api/types.ts:165 |
| channelPlugins | required | — | packages/daemon/src/api/types.ts:163 |
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:170 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:171 |
| workspaceDirs | required | — | packages/daemon/src/api/types.ts:172 |
| logger | required | — | packages/daemon/src/api/types.ts:173 |
| persistDeps | optional | channel.start / channel.stop runtime state changes are NOT persisted to config.yaml; reverts on next daemon restart (in-memory only) | packages/daemon/src/api/types.ts:174 |
| boundedAutonomy | optional | the bounded-autonomy outward quota is inert — message.send/reply/react/attach are NOT gated on origin/grant/per-hour/volume (the cap gate + authorizeChannelAccess still apply); wired only when an autonomy-bearing agent is configured | packages/daemon/src/api/types.ts:287 |
| resolveRootRunId | optional | message.send/reply/react cannot derive the outward-ledger root identity from the caller session, so retained-operation duplicate suppression is a pass-through (same resolver as SessionsApiDeps.resolveRootRunId; already spread into the flat dispatch deps) | packages/daemon/src/api/types.ts:288 |
| outwardLedger | optional | the closed five-state outward uncertainty ledger is absent, so message.send/reply/react run without retained-operation protection — deliverToChannel remains a pass-through (a non-autonomy daemon); the quota gate is unaffected | packages/daemon/src/api/types.ts:290 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a feature-gate documented above. `inboundMessageIdResolver` is a compat path for tests; `wsConnections` is set after gateway init via a mutable ref so it is optional during early dispatcher construction; `deliveryQueue` / `healthMonitor` are configurable subsystems whose absence triggers explicit fallback paths. `channelPlugins` was promoted from optional to required — setup-channels-adapters.ts always wires ≥9 plugin entries before `buildRpcDispatchDeps`.

## Summary

- **Pre-audit count:** 15
- **Final count:** 15 (9 required + 6 optional, after promoting `channelPlugins` to required)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `ChannelsApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
