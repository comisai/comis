# ChannelManagerDeps Audit

**Generated:** 2026-05-11
**Interface source:** `packages/orchestrator/src/channel-manager.ts:78–218` (48-field interface)
**Construction site:** `packages/daemon/src/wiring/setup-channels.ts:739` (single site — `createChannelManager({`)
**Field count:** 48 (7 required + 41 optional + 0 stale-fallback)

This file is co-located with the orchestrator package. `files: ["dist"]` in `packages/orchestrator/package.json` excludes it from the npm tarball.

## Audit Result

Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path that fires in that omission. None of the 13 fields that the daemon never wires are dead code; each has at least one `if (deps.X)` or `deps.X?.method()` site in the orchestrator production source whose absent branch IS the production behavior.

The architecture-test invariants enforced by `packages/orchestrator/src/__tests__/architecture.test.ts` hold: bidirectional set equality between this table and `ChannelManagerDeps`; every classification is `required` or `optional`; classification matches the interface's `?` marker; every row has a non-empty evidence-link cell.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| eventBus | required | — | packages/orchestrator/src/channel-manager.ts:79 |
| messageRouter | required | — | packages/orchestrator/src/channel-manager.ts:80 |
| sessionManager | required | — | packages/orchestrator/src/channel-manager.ts:81 |
| createExecutor | required | — | packages/orchestrator/src/channel-manager.ts:82 |
| adapters | optional | channelRegistry plugins are the sole adapter source (production path when adapters is empty) | packages/orchestrator/src/channel-manager.ts:84 |
| logger | required | — | packages/orchestrator/src/channel-manager.ts:85 |
| preprocessMessage | optional | inbound messages pass through unprocessed (no voice transcription / image analysis pre-agent) | packages/orchestrator/src/channel-manager.ts:87 |
| channelRegistry | optional | echo + any plugin without `replyToMetaKey` declared in CAPABILITIES loses reply threading (production wires registry from channelPlugins, so the absent path only fires in unit-test deps fixtures) | packages/orchestrator/src/channel-manager.ts:89 |
| commandQueue | optional | direct execution without per-session serialization | packages/orchestrator/src/channel-manager.ts:91 |
| streamingConfig | optional | block streaming uses hardcoded defaults (enabled) | packages/orchestrator/src/channel-manager.ts:93 |
| autoReplyEngineConfig | optional | all messages activate the agent | packages/orchestrator/src/channel-manager.ts:95 |
| sendPolicyConfig | optional | all sends are allowed | packages/orchestrator/src/channel-manager.ts:97 |
| getResetTriggers | optional | no trigger-phrase detection | packages/orchestrator/src/channel-manager.ts:99 |
| identityResolver | optional | senderId used directly | packages/orchestrator/src/channel-manager.ts:101 |
| getDmScopeConfig | optional | defaults to per-channel-peer (current behavior) | packages/orchestrator/src/channel-manager.ts:103 |
| retryEngine | optional | sends use adapter.sendMessage directly | packages/orchestrator/src/channel-manager.ts:105 |
| deliveryQueue | optional | agent responses skip queue | packages/orchestrator/src/channel-manager.ts:107 |
| deliveryService | required | — | packages/orchestrator/src/channel-manager.ts:111 |
| debounceBuffer | optional | messages go directly to CommandQueue | packages/orchestrator/src/channel-manager.ts:113 |
| groupHistoryBuffer | optional | group history injection is disabled | packages/orchestrator/src/channel-manager.ts:115 |
| followupTrigger | optional | no follow-up runs are triggered | packages/orchestrator/src/channel-manager.ts:117 |
| followupConfig | optional | defaults used from FollowupTrigger | packages/orchestrator/src/channel-manager.ts:119 |
| queueConfig | optional | default queue behavior used | packages/orchestrator/src/channel-manager.ts:121 |
| getElevatedReplyConfig | optional | no elevated routing | packages/orchestrator/src/channel-manager.ts:123 |
| sessionLabelStore | optional | labels not included in group history output | packages/orchestrator/src/channel-manager.ts:125 |
| ackReactionConfig | optional | no ack reactions are sent | packages/orchestrator/src/channel-manager.ts:127 |
| loadPromptSkill | optional | skill commands pass through as plain text | packages/orchestrator/src/channel-manager.ts:129 |
| getUserInvocableSkillNames | optional | no skill-command matching | packages/orchestrator/src/channel-manager.ts:131 |
| assembleToolsForAgent | optional | executor receives no tools (undefined) | packages/orchestrator/src/channel-manager.ts:138 |
| greetingGenerator | optional | static "Session reset." is sent | packages/orchestrator/src/channel-manager.ts:140 |
| audioPreflight | optional | voice messages are forwarded to the agent as-is (no pre-mention transcription) | packages/orchestrator/src/channel-manager.ts:142 |
| voiceResponsePipeline | optional | voice response is disabled | packages/orchestrator/src/channel-manager.ts:144 |
| parseOutboundMedia | optional | MEDIA: directives are not parsed | packages/orchestrator/src/channel-manager.ts:146 |
| outboundMediaFetch | optional | outbound media delivery is disabled | packages/orchestrator/src/channel-manager.ts:148 |
| activeRunRegistry | optional | all messages route through CommandQueue | packages/orchestrator/src/channel-manager.ts:150 |
| sessionResolver | optional | activeRunRegistry.has/.get used for production lookups | packages/orchestrator/src/channel-manager.ts:156 |
| handleConfigCommand | optional | /config commands pass through as plain text to the agent | packages/orchestrator/src/channel-manager.ts:158 |
| onMessageReceived | optional | no pre-dispatch hook fires (continuation tracker is not notified) | packages/orchestrator/src/channel-manager.ts:166 |
| onMessageProcessed | optional | no post-processing hook fires (notification session activity is not recorded) | packages/orchestrator/src/channel-manager.ts:168 |
| lifecycleReactionsEnabled | optional | inbound pipeline emits ack reaction (no lifecycle-reactor handoff) | packages/orchestrator/src/channel-manager.ts:170 |
| onGraphReportRequest | optional | graph:report callbacks fall through to the agent | packages/orchestrator/src/channel-manager.ts:172 |
| responsePrefixConfig | optional | no prefix/suffix applied to agent responses | packages/orchestrator/src/channel-manager.ts:174 |
| buildTemplateContext | optional | response-prefix template variables are not substituted (skipped silently if responsePrefixConfig is also absent) | packages/orchestrator/src/channel-manager.ts:176 |
| approvalGate | optional | approval commands pass through as plain text | packages/orchestrator/src/channel-manager.ts:178 |
| handleSlashCommand | optional | unknown slash commands pass through as plain text to the agent | packages/orchestrator/src/channel-manager.ts:184 |
| getEnforceFinalTag | optional | enforceFinalTag executor option is undefined (executor default applies) | packages/orchestrator/src/channel-manager.ts:198 |
| processInboundMessage | required | — | packages/orchestrator/src/channel-manager.ts:205 |
| getAllowFrom | optional | no allowFrom sender filter (all senders allowed) | packages/orchestrator/src/channel-manager.ts:217 |

## Removed Fields (stale-fallback)

**None.** Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path. The audit verified this empirically by counting `deps.<field>` references across `packages/orchestrator/src/{channel-manager.ts, inbound/*.ts, execution/*.ts}` for each of the 14 candidate fields that the daemon never wires; every candidate had at least one production reference whose absent-branch IS the production behavior. Examples:

- `debounceBuffer`: 7 production usages; daemon never wires it (`inbound-route.ts:93` `if (!isDebounced && deps.debounceBuffer)` selects the no-debounce path in production).
- `groupHistoryBuffer`: 8 production usages; daemon never wires it (group-history injection is disabled in production).
- `loadPromptSkill` / `getUserInvocableSkillNames`: 2 usages each (`inbound-gate.ts:344` `if (... && deps.loadPromptSkill && deps.getUserInvocableSkillNames)`); daemon never wires either, so skill commands pass through as plain text in production.
- `ackReactionConfig`, `followupConfig`, `followupTrigger`, `getDmScopeConfig`, `greetingGenerator`, `identityResolver`, `sessionLabelStore`: all follow the same pattern — declared optional, daemon does not wire, absent-mode is the production code path. (`inFlightSends` was previously listed here as a 14th test-only injection point; Plan 56-05 moved the Set inside `DeliveryService` and deleted the deps slot, so it no longer appears in `ChannelManagerDeps`. `channelRegistry` was previously in this list; Plan 56-05 wires it from `setup-channels-runtime.ts` against the `channelPlugins` Map so it now flows through production deps and the absent-mode applies only to unit-test fixtures.)

## Summary

- **Total fields:** 48 (7 required + 41 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value)

## Notes

- Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/orchestrator/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `ChannelManagerDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
- The audit-coverage test does not parse the line-number portion of each evidence link, so future incidental shifts (e.g., a comment edit on line 90) do not invalidate the audit until a field is added or removed; the table covers schema, not exact line addresses.
