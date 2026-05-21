# ChannelManagerDeps Audit

**Generated:** 2026-05-11
**Interface source:** `packages/orchestrator/src/channel-manager.ts:83–229` (51-field interface)
**Construction site:** `packages/daemon/src/wiring/setup-channels.ts:739` (single site — `createChannelManager({`)
**Field count:** 51 (7 required + 44 optional + 0 stale-fallback)

This file is co-located with the orchestrator package. `files: ["dist"]` in `packages/orchestrator/package.json` excludes it from the npm tarball.

## Audit Result

Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path that fires in that omission. None of the 14 fields that the daemon never wires are dead code; each has at least one `if (deps.X)` or `deps.X?.method()` site in the orchestrator production source whose absent branch IS the production behavior.

The architecture-test invariants enforced by `packages/orchestrator/src/__tests__/architecture.test.ts` hold: bidirectional set equality between this table and `ChannelManagerDeps`; every classification is `required` or `optional`; classification matches the interface's `?` marker; every row has a non-empty evidence-link cell.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| eventBus | required | — | packages/orchestrator/src/channel-manager.ts:84 |
| messageRouter | required | — | packages/orchestrator/src/channel-manager.ts:85 |
| sessionManager | required | — | packages/orchestrator/src/channel-manager.ts:86 |
| createExecutor | required | — | packages/orchestrator/src/channel-manager.ts:87 |
| adapters | optional | channelRegistry plugins are the sole adapter source (production path when adapters is empty) | packages/orchestrator/src/channel-manager.ts:89 |
| logger | required | — | packages/orchestrator/src/channel-manager.ts:90 |
| preprocessMessage | optional | inbound messages pass through unprocessed (no voice transcription / image analysis pre-agent) | packages/orchestrator/src/channel-manager.ts:92 |
| channelRegistry | optional | hardcoded channel-capability maps used as fallback | packages/orchestrator/src/channel-manager.ts:94 |
| commandQueue | optional | direct execution without per-session serialization | packages/orchestrator/src/channel-manager.ts:96 |
| streamingConfig | optional | block streaming uses hardcoded defaults (enabled) | packages/orchestrator/src/channel-manager.ts:98 |
| autoReplyEngineConfig | optional | all messages activate the agent | packages/orchestrator/src/channel-manager.ts:100 |
| sendPolicyConfig | optional | all sends are allowed | packages/orchestrator/src/channel-manager.ts:102 |
| getResetTriggers | optional | no trigger-phrase detection | packages/orchestrator/src/channel-manager.ts:104 |
| identityResolver | optional | senderId used directly | packages/orchestrator/src/channel-manager.ts:106 |
| getDmScopeConfig | optional | defaults to per-channel-peer (current behavior) | packages/orchestrator/src/channel-manager.ts:108 |
| retryEngine | optional | sends use adapter.sendMessage directly | packages/orchestrator/src/channel-manager.ts:110 |
| deliveryQueue | optional | agent responses skip queue | packages/orchestrator/src/channel-manager.ts:112 |
| deliveryService | required | — | packages/orchestrator/src/channel-manager.ts:116 |
| debounceBuffer | optional | messages go directly to CommandQueue | packages/orchestrator/src/channel-manager.ts:118 |
| groupHistoryBuffer | optional | group history injection is disabled | packages/orchestrator/src/channel-manager.ts:120 |
| followupTrigger | optional | no follow-up runs are triggered | packages/orchestrator/src/channel-manager.ts:122 |
| followupConfig | optional | defaults used from FollowupTrigger | packages/orchestrator/src/channel-manager.ts:124 |
| queueConfig | optional | default queue behavior used | packages/orchestrator/src/channel-manager.ts:126 |
| getElevatedReplyConfig | optional | no elevated routing | packages/orchestrator/src/channel-manager.ts:130 |
| sessionLabelStore | optional | labels not included in group history output | packages/orchestrator/src/channel-manager.ts:132 |
| ackReactionConfig | optional | no ack reactions are sent | packages/orchestrator/src/channel-manager.ts:134 |
| loadPromptSkill | optional | skill commands pass through as plain text | packages/orchestrator/src/channel-manager.ts:136 |
| getUserInvocableSkillNames | optional | no skill-command matching | packages/orchestrator/src/channel-manager.ts:138 |
| assembleToolsForAgent | optional | executor receives no tools (undefined) | packages/orchestrator/src/channel-manager.ts:145 |
| greetingGenerator | optional | static "Session reset." is sent | packages/orchestrator/src/channel-manager.ts:147 |
| audioPreflight | optional | voice messages are forwarded to the agent as-is (no pre-mention transcription) | packages/orchestrator/src/channel-manager.ts:149 |
| voiceResponsePipeline | optional | voice response is disabled | packages/orchestrator/src/channel-manager.ts:151 |
| parseOutboundMedia | optional | MEDIA: directives are not parsed | packages/orchestrator/src/channel-manager.ts:153 |
| outboundMediaFetch | optional | outbound media delivery is disabled | packages/orchestrator/src/channel-manager.ts:155 |
| activeRunRegistry | optional | all messages route through CommandQueue | packages/orchestrator/src/channel-manager.ts:157 |
| sessionResolver | optional | activeRunRegistry.has/.get used for production lookups | packages/orchestrator/src/channel-manager.ts:163 |
| handleConfigCommand | optional | /config commands pass through as plain text to the agent | packages/orchestrator/src/channel-manager.ts:165 |
| onTaskExtraction | optional | no post-execution task extraction is triggered | packages/orchestrator/src/channel-manager.ts:167 |
| onMessageReceived | optional | no pre-dispatch hook fires (continuation tracker is not notified) | packages/orchestrator/src/channel-manager.ts:175 |
| onMessageProcessed | optional | no post-processing hook fires (notification session activity is not recorded) | packages/orchestrator/src/channel-manager.ts:177 |
| lifecycleReactionsEnabled | optional | inbound pipeline emits ack reaction (no lifecycle-reactor handoff) | packages/orchestrator/src/channel-manager.ts:179 |
| onGraphReportRequest | optional | graph:report callbacks fall through to the agent | packages/orchestrator/src/channel-manager.ts:181 |
| responsePrefixConfig | optional | no prefix/suffix applied to agent responses | packages/orchestrator/src/channel-manager.ts:183 |
| buildTemplateContext | optional | response-prefix template variables are not substituted (skipped silently if responsePrefixConfig is also absent) | packages/orchestrator/src/channel-manager.ts:185 |
| approvalGate | optional | approval commands pass through as plain text | packages/orchestrator/src/channel-manager.ts:187 |
| handleSlashCommand | optional | unknown slash commands pass through as plain text to the agent | packages/orchestrator/src/channel-manager.ts:193 |
| getEnforceFinalTag | optional | enforceFinalTag executor option is undefined (executor default applies) | packages/orchestrator/src/channel-manager.ts:207 |
| processInboundMessage | required | — | packages/orchestrator/src/channel-manager.ts:216 |
| inFlightSends | optional | factory creates its own per-instance Set (production path) | packages/orchestrator/src/channel-manager.ts:226 |
| getAllowFrom | optional | no allowFrom sender filter (all senders allowed) | packages/orchestrator/src/channel-manager.ts:228 |

## Removed Fields (stale-fallback)

**None.** Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path. The audit verified this empirically by counting `deps.<field>` references across `packages/orchestrator/src/{channel-manager.ts, inbound/*.ts, execution/*.ts}` for each of the 14 candidate fields that the daemon never wires; every candidate had at least one production reference whose absent-branch IS the production behavior. Examples:

- `debounceBuffer`: 7 production usages; daemon never wires it (`inbound-route.ts:130` `if (!isDebounced && deps.debounceBuffer)` selects the no-debounce path in production).
- `groupHistoryBuffer`: 8 production usages; daemon never wires it (group-history injection is disabled in production).
- `loadPromptSkill` / `getUserInvocableSkillNames`: 2 usages each (`inbound-gate.ts:344` `if (... && deps.loadPromptSkill && deps.getUserInvocableSkillNames)`); daemon never wires either, so skill commands pass through as plain text in production.
- `inFlightSends`: 3 usages; the interface JSDoc documents this as a test-only injection point; the factory creates its own per-instance Set when absent (the production path, `channel-manager.ts:273`).
- `ackReactionConfig`, `channelRegistry`, `followupConfig`, `followupTrigger`, `getDmScopeConfig`, `greetingGenerator`, `identityResolver`, `sessionLabelStore`: all follow the same pattern — declared optional, daemon does not wire, absent-mode is the production code path.

## Summary

- **Total fields:** 51 (7 required + 44 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value)

## Notes

- Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/orchestrator/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `ChannelManagerDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
- The audit-coverage test does not parse the line-number portion of each evidence link, so future incidental shifts (e.g., a comment edit on line 90) do not invalidate the audit until a field is added or removed; the table covers schema, not exact line addresses.
