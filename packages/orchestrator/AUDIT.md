# ChannelManagerDeps Audit

**Generated:** 2026-05-11
**Interface source:** `packages/orchestrator/src/channel-manager.ts` (48-field interface)
**Construction site:** `packages/daemon/src/wiring/setup-channels/setup-channels-runtime.ts` (single site — `createChannelManager({`)
**Field count:** 48 (12 required + 36 optional + 0 stale-fallback)

This file is co-located with the orchestrator package. `files: ["dist"]` in `packages/orchestrator/package.json` excludes it from the npm tarball.

## Audit Result

Every interface field whose construction-site value is omitted by the daemon has a real production absent-mode code path that fires in that omission. After the recent trims, the previously-14-field unwired set has been narrowed: 12 fields deleted entirely (inFlightSends; ackReactionConfig, debounceBuffer, followupConfig, followupTrigger, getDmScopeConfig, getUserInvocableSkillNames, greetingGenerator, groupHistoryBuffer, identityResolver, loadPromptSkill, sessionLabelStore), and channelRegistry is now wired from the daemon.

The architecture-test invariants enforced by `packages/orchestrator/src/__tests__/architecture.test.ts` hold: bidirectional set equality between this table and `ChannelManagerDeps`; every classification is `required` or `optional`; classification matches the interface's `?` marker; every row has a non-empty evidence-link cell.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| tenantId | required | — | packages/orchestrator/src/channel-manager.ts:154 |
| eventBus | required | — | packages/orchestrator/src/channel-manager.ts:79 |
| messageRouter | required | — | packages/orchestrator/src/channel-manager.ts:80 |
| sessionManager | required | — | packages/orchestrator/src/channel-manager.ts:81 |
| principalResolver | required | — | packages/orchestrator/src/channel-manager.ts:159 |
| localization | required | — | packages/orchestrator/src/channel-manager.ts:160 |
| getDmScope | required | — | packages/orchestrator/src/channel-manager.ts:161 |
| createExecutor | required | — | packages/orchestrator/src/channel-manager.ts:82 |
| persistInboundMessage | required | — | packages/orchestrator/src/channel-manager.ts:161 |
| adapters | optional | channelRegistry plugins are the sole adapter source (production path when adapters is empty) | packages/orchestrator/src/channel-manager.ts:84 |
| logger | required | — | packages/orchestrator/src/channel-manager.ts:85 |
| preprocessMessage | optional | inbound messages pass through unprocessed (no voice transcription / image analysis pre-agent) | packages/orchestrator/src/channel-manager.ts:87 |
| channelRegistry | optional | echo + any plugin without `replyToMetaKey` declared in CAPABILITIES loses reply threading (production wires registry from channelPlugins, so the absent path only fires in unit-test deps fixtures) | packages/orchestrator/src/channel-manager.ts:89 |
| commandQueue | optional | direct execution without per-session serialization | packages/orchestrator/src/channel-manager.ts:91 |
| streamingConfig | optional | block streaming uses hardcoded defaults (enabled) | packages/orchestrator/src/channel-manager.ts:93 |
| autoReplyEngineConfig | optional | all messages activate the agent | packages/orchestrator/src/channel-manager.ts:95 |
| sendPolicyConfig | optional | all sends are allowed | packages/orchestrator/src/channel-manager.ts:97 |
| getResetTriggers | optional | no trigger-phrase detection | packages/orchestrator/src/channel-manager.ts:99 |
| retryEngine | optional | sends use adapter.sendMessage directly | packages/orchestrator/src/channel-manager.ts:105 |
| deliveryQueue | optional | agent responses skip queue | packages/orchestrator/src/channel-manager.ts:107 |
| deliveryService | required | — | packages/orchestrator/src/channel-manager.ts:111 |
| queueConfig | optional | default queue behavior used | packages/orchestrator/src/channel-manager.ts:121 |
| getElevatedReplyConfig | optional | no elevated routing | packages/orchestrator/src/channel-manager.ts:123 |
| assembleToolsForAgent | optional | executor receives no tools (undefined) | packages/orchestrator/src/channel-manager.ts:138 |
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
| interactiveCallbackRouter | optional | button callbacks (metadata.isButtonCallback) fall through to the normal pipeline (no server-side route()/verify) | packages/orchestrator/src/channel-manager.ts:195 |
| handleSlashCommand | optional | unknown slash commands pass through as plain text to the agent | packages/orchestrator/src/channel-manager.ts:201 |
| getEnforceFinalTag | optional | enforceFinalTag executor option is undefined (executor default applies) | packages/orchestrator/src/channel-manager.ts:198 |
| processInboundMessage | required | — | packages/orchestrator/src/channel-manager.ts:205 |
| getAllowFrom | optional | no allowFrom sender filter (all senders allowed) | packages/orchestrator/src/channel-manager.ts:217 |
| exportSessionBundle | optional | /export-trajectory falls through to generic handleSlashCommand (no-op — export-trajectory has no case in command-handler.ts switch, returns handled:false, message with empty text reaches executor) | packages/orchestrator/src/channel-manager.ts:189 |
| activityStreamPort | optional | absent → the inbound pipeline activity gate (execution-pipeline.ts:395) is false; no per-turn coordinator is built and renderer.apply never fires (fail-closed: no activity stream means no per-turn rendering, never a partial one) | packages/orchestrator/src/channel-manager.ts:192 |
| coordinatorFactory | optional | absent → the activity gate stays false (the daemon supplies it only alongside activityStreamPort); the turn runs exactly as before with no activity rendering | packages/orchestrator/src/channel-manager.ts:196 |
| adapterRegistry | optional | injectMessage falls back to the daemon's live boot adapter map for adapters registered after startAll(); absent → only startAll()-registered adapters drive injectMessage (production registers every real adapter at boot) | packages/orchestrator/src/channel-manager.ts:224 |
| channelCredentialMap | optional | absent → no channel reconnect hook on credential rotation (secret:changed events are ignored for adapter restart; production wires from setup-channels with the per-channel credential name map) | packages/orchestrator/src/channel-manager.ts:236 |

## Removed Fields (stale-fallback)

**None.** The audit's narrowing recommendation is complete: 12 of the original 14 daemon-unwired fields were deleted. channelRegistry is now wired. Every remaining field is either required, or optional-with-real-absent-mode where the absent branch is the production code path.

## Summary

- **Total fields:** 48 (12 required + 36 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value)

## Notes

- Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/orchestrator/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `ChannelManagerDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
- The audit-coverage test does not parse the line-number portion of each evidence link, so future incidental shifts (e.g., a comment edit on line 90) do not invalidate the audit until a field is added or removed; the table covers schema, not exact line addresses.
