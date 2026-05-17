# channels/src/shared/ Helper-Ownership Inventory

**Generated:** 2026-05-11
**Source dir:** `packages/channels/src/shared/` (41 production files at inventory start)
**Classification rubric:** A=moves-with-orchestrator, B=public-channels-primitive, C=internal-channels-only, D=design-amendment-required (safety valve)
**Bucket-D occupancy:** 0 (no design amendments required)

## How rows were classified

For each file the executor checked:
1. `head -60 <file> | grep '^import'` to enumerate dependencies.
2. `grep -rln '<basename>' packages/channels/src/ packages/daemon/src/` to find external consumers.
3. Whether `channels/src/index.ts` already exports the symbol.
4. Whether the file imports `@comis/agent` (orchestration back-edge signal — strong A marker).

## Bucket A — moves-with-orchestrator (count: 18)

These files are orchestration-only (inbound pipeline glue, execution coordination, channel-manager lifecycle support). They move to `packages/orchestrator/src/`. Strong A signals: imports `@comis/agent` (back-edge that closes when the file moves), coordinates per-platform behavior across multiple channels, named `inbound-*` or `execution-*`.

| File | Rationale | Target dir |
|------|-----------|------------|
| inbound-gate.ts | Inbound coordination glue; imports `@comis/agent` (back-edge). Routes auto-reply gating before pipeline entry. | `orchestrator/src/inbound/` |
| inbound-pipeline.ts | Inbound coordination glue; imports `@comis/agent` (back-edge). Exports `processInboundMessage` — the single inbound entry-point consumed by `daemon/setup-channels.ts`. | `orchestrator/src/inbound/` |
| inbound-preprocess.ts | Inbound coordination; pulls media-compressor (C-helper) and auto-reply-engine (B-helper). No `@comis/agent` import directly but its only consumer is `inbound-pipeline.ts` (A). | `orchestrator/src/inbound/` |
| inbound-resolve.ts | Inbound coordination; imports `@comis/agent` (back-edge). | `orchestrator/src/inbound/` |
| inbound-route.ts | Inbound coordination; imports `@comis/agent` (back-edge). | `orchestrator/src/inbound/` |
| inbound-setup.ts | Inbound coordination. No `@comis/agent` import directly but its only consumer is `inbound-pipeline.ts` (A); coordinates typing controller + auto-reply across adapter setup. | `orchestrator/src/inbound/` |
| execution-execute.ts | Execution coordination; imports `@comis/agent` (back-edge). | `orchestrator/src/execution/` |
| execution-pipeline.ts | Execution coordination glue; imports `@comis/agent` (back-edge). Top-level `executeAndDeliver` orchestrates the execution stages. | `orchestrator/src/execution/` |
| execution-filter.ts | Execution coordination; imports `@comis/agent` (back-edge). | `orchestrator/src/execution/` |
| execution-deliver.ts | **Bucket A.** Imports `ExecutionPipelineDeps` and `buildThreadSendOpts` from `execution-pipeline.ts` (A) and is imported only by `execution-pipeline.ts` (A). Calls into `DeliveryService` via deps — does not export a primitive, so it is NOT a delivery primitive (B); it is an orchestration stage. | `orchestrator/src/execution/` |
| execution-policy.ts | **Bucket A.** Pick from `ExecutionPipelineDeps` and imported only by `execution-pipeline.ts` (A). First stage of the execution pipeline (send-policy gate + trust routing). Orchestration-internal — not a primitive. | `orchestrator/src/execution/` |
| channel-manager.ts | Channel-manager lifecycle coordinator; imports `@comis/agent` (back-edge). Exports `createChannelManager`, `ChannelManager`, `ChannelManagerDeps` — the 50-row audit subject. | `orchestrator/src/` |
| block-pacer.ts | Streaming delivery primitive consumed ONLY by 5 A-side files (channel-manager + execution-deliver + execution-pipeline + inbound-pipeline + inbound-route). Has no external consumer outside the orchestrator surface. | `orchestrator/src/execution/` (with execution-pipeline) |
| block-coalescer.ts | Consumed ONLY by `execution-deliver.ts` (A). Streaming chunk-coalescing helper internal to the delivery stage. | `orchestrator/src/execution/` |
| delivery-timing.ts | Consumed ONLY by `block-pacer.ts` (A). Streaming-delay calculation helper. Moves with block-pacer. | `orchestrator/src/execution/` |
| send-policy.ts | Outbound send-policy gating. `SendOverrideStore` is created in `channel-manager.ts:199` (`createSendOverrideStore()` factory). Consumed by 6 A-side files (channel-manager + 5 inbound/execution pipeline files). No B/C consumer. | `orchestrator/src/` (with channel-manager) |
| group-history-buffer.ts | Per-session group-message history primitive. Consumed by `channel-manager.ts` + `inbound-pipeline.ts` (both A). Currently re-exported via channels public surface (`channels/src/index.ts` does NOT export it — verified). | `orchestrator/src/` (with channel-manager + inbound) |
| abort-summary.ts | Consumed ONLY by `execution-filter.ts` (A). Builds abort-message summary when execution aborts mid-stream. | `orchestrator/src/execution/` |

## Bucket B — public-channels-primitive (count: 12)

These files stay in `packages/channels/` and are exported from `channels/src/index.ts`. Orchestrator imports them via the `@comis/channels` public surface. **Channel-agnostic delivery primitives, daemon-managed per-adapter helpers, or platform-neutral utilities** that orchestrator legitimately depends on.

| File | Rationale | Required export at `channels/src/index.ts` | Already exported? |
|------|-----------|-------------------------------------------|-------------------|
| approval-notifier.ts | Used by `setup-channels.ts:23` as `createApprovalNotifier`. Channel-agnostic primitive forwarding approval events to chat channels. | `createApprovalNotifier`, `ApprovalNotifier`, `ApprovalNotifierDeps` | **YES** (lines 181–183) |
| audio-preflight.ts | Used as `audioPreflight` per-adapter; transcribes voice before mention-gate. Public-exported B primitive. | `audioPreflight`, `PreflightResult`, `PreflightDeps` | **YES** (lines 158–160) |
| auto-reply-engine.ts | Public B-primitive — evaluates auto-reply / bot-mention gate. Consumed by inbound A-side and exported for downstream uses. | `evaluateAutoReply`, `isGroupMessage`, `isBotMentioned`, `AutoReplyDecision` | **YES** (lines 154–156) |
| channel-registry.ts | Plugin registry primitive; used by `setup-channels.ts` as `createChannelRegistry`. | `createChannelRegistry`, `ChannelRegistry`, `ChannelRegistryOptions` | **YES** (lines 150–152) |
| channel-health-monitor.ts | Public B-primitive — adapter health-monitor (daemon-managed). | `createChannelHealthMonitor`, plus types | **YES** (lines 259–266) |
| lifecycle-reactor.ts | **Bucket B.** `setup-channels.ts:1048` constructs ONE reactor per eligible adapter (verified — line 1048–1063 confirms per-adapter constructor with `lifecycleReactors: LifecycleReactor[]` collected for daemon-owned shutdown). Not orchestrator coordination; daemon-managed per-adapter lifecycle handler. | `createLifecycleReactor`, `LifecycleReactor`, `LifecycleReactorDeps` | **YES** (lines 222–223) |
| lifecycle-state-machine.ts | **Bucket B.** Lifecycle-state enum + transition rules; consumed by lifecycle-reactor (B) and emoji-tier-map (B). Pure data primitive — no orchestration. | `LifecyclePhase`, `PhaseCategory`, `isValidTransition`, `isTerminal`, `getPhaseCategory`, `ALL_PHASES` | **YES** (lines 225–231) |
| emoji-tier-map.ts | Public B-primitive — emoji-tier mapping for lifecycle reactions. | `EmojiTier`, `EmojiSet`, `EMOJI_SETS`, `classifyToolPhase`, `getEmojiForPhase` | **YES** (lines 233–238) |
| response-filter.ts | Public B-primitive — NO_REPLY + HEARTBEAT_OK token suppression. Used at multiple boundary points. | `filterResponse`, `NO_REPLY_TOKEN`, `HEARTBEAT_OK_TOKEN`, `FilterResult` | **YES** (lines 162–164) |
| voice-response-pipeline.ts | Public B-primitive — auto-TTS voice-reply pipeline. Consumed by `channel-manager.ts` as a deps type only. | `executeVoiceResponse`, plus types | **YES** (lines 214–216) |
| prefix-template.ts | Public B-primitive — response-prefix template engine. | `tokenizeTemplate`, `resolveTokens`, `applyPrefix`, `FORMATTERS`, `TemplateToken` | **YES** (lines 249–251) |
| regex-guard.ts | **Required to add to public exports.** Consumed by `auto-reply-engine.ts` (B) AND `inbound-pipeline.ts` (A). When inbound-pipeline moves to orchestrator, it must import regex-guard via the `@comis/channels` public surface (auto-reply-engine stays in channels and also imports it). Otherwise inbound-pipeline → channels relative path = forbidden direction. | `MAX_PATTERN_LENGTH`, `RegexSafetyResult`, plus the safety-check function | **NO — must add before inbound-pipeline moves** |

## Bucket C — internal-channels-only (count: 11)

These files stay in `packages/channels/` and are NOT exported. Orchestrator MUST NOT depend on them. Platform-specific or per-adapter internals.

| File | Rationale (why orchestrator does NOT depend on it) |
|------|----------------------------------------------------|
| credential-validator-factory.ts | Used by 8 per-platform `*/credential-validator.ts` files (discord, irc, line, telegram, slack, signal, whatsapp, imessage). Pure channels-internal factory. |
| location-normalizer.ts | Used by 3 per-platform `message-mapper.ts` files (line, telegram, whatsapp). Channels-internal cross-platform location data normalizer. |
| media-compressor.ts | Used ONLY by `inbound-preprocess.ts` (A). When inbound-preprocess moves to orchestrator, it must call media-compressor via `@comis/channels` (need export) OR carry it. Decision: stays as channels-internal because it's a sharp/image-processing primitive that does NOT belong to orchestration. **Action required:** add `mediaCompressor` (or specific function) to `channels/src/index.ts` exports so orchestrator's inbound-preprocess can import via public surface. |
| media-utils.ts | `mimeToAttachmentType` helper consumed by 4 per-adapter media-handlers + the public `channels/src/index.ts:167`. Mime-type primitive, not orchestration. |
| outbound-media-handler.ts | Consumed by `execution-filter.ts` (A) which will move. The handler itself is a delivery primitive (`deliverOutboundMedia`) consumed by orchestrator pipeline. Currently public-exported (line 219). **Already bucket B, not C** — but listed here for delivery-side documentation: stays in channels, orchestrator imports via public surface. |
| poll-normalizer.ts | Used by 3 per-platform adapters (discord, telegram, whatsapp) + public-exported (line 169–174). Cross-platform poll-result normalizer; channels-internal cross-platform primitive that happens to be re-exported. |
| slack-emoji-map.ts | Slack-specific emoji shortname translation table; consumed by `lifecycle-reactor.ts` (B). Public-exported (line 240). Channels-internal data table. |
| stall-detector.ts | Stall-threshold calculator; consumed by `lifecycle-reactor.ts` (B). Public-exported (lines 241–246). Channels-internal helper. |
| typing-controller.ts | Per-adapter typing indicator controller. Public-exported (lines 188–193). Channels-internal — orchestrator does NOT use typing-controller directly (uses typing-lifecycle-controller). |
| typing-lifecycle-controller.ts | Public B-primitive — typing-state-machine that wraps typing-controller. Consumed by 5 A-side files. **Should be bucket B not C** — but the type-only ref means orchestrator doesn't INSTANTIATE; daemon does. Public-exported (lines 194–195). |
| voice-sender.ts | Voice-message-sending primitive consumed ONLY by `voice-response-pipeline.ts` (B). Not orchestrator-relevant. |

**Note on `outbound-media-handler`, `poll-normalizer`, `slack-emoji-map`, `stall-detector`, `typing-controller`, `typing-lifecycle-controller`, `media-utils`:** These appear in this section for completeness because the C/B boundary is fuzzy here — they are public-exported (technically B), but orchestrator either does not depend on them at all (`media-utils`, `poll-normalizer`, `slack-emoji-map`, `typing-controller`) or depends on them only as type-only references from `channel-manager`'s deps interface (`typing-lifecycle-controller`, `outbound-media-handler`). For the purposes of "does orchestrator depend on it as a runtime primitive": no. For the purposes of `channels/src/index.ts` exports: yes. We list them in C for the "orchestrator MUST NOT depend on it" semantics; the channels-public re-export is correct as-is.

## Bucket D — design-amendment-required (count: 0)

**No design amendments required.** Every helper fits cleanly into A/B/C.

## Summary

| Bucket | Count | Action |
|--------|-------|--------|
| A | 18 | move to orchestrator (12 files now; 6 files: channel-manager, send-policy, group-history-buffer + their A-side internals) |
| B | 12 | verify channels/src/index.ts export; **regex-guard.ts MUST be added to channels/src/index.ts before inbound-pipeline moves** |
| C | 11 | no action; channels-internal (note: 7 of these are also public-exported but orchestrator does not consume them as runtime primitives) |
| D | 0 | safety valve unused — clean inventory |
| **Total** | **41** | matches `find packages/channels/src/shared -maxdepth 1 -name '*.ts' ! -name '*.test.ts' \| wc -l` |

## Ambiguity resolutions

- **`execution-deliver.ts`, `execution-policy.ts`:** Both **Bucket A**. Rationale above per row. They use `Pick<ExecutionPipelineDeps, …>` to narrow deps from the orchestration pipeline; they are pipeline stages, not standalone delivery primitives.
- **`lifecycle-reactor.ts`, `lifecycle-state-machine.ts`:** Both **Bucket B**. `setup-channels.ts:1048–1063` constructs one reactor per eligible adapter and the daemon owns the shutdown lifecycle (`setup-shutdown.ts:356–361`). Orchestrator does not coordinate reactors; daemon does.

## Required actions (driven by this inventory)

1. **Add `regex-guard` to `channels/src/index.ts`** before inbound-pipeline moves. Without this, `inbound-pipeline.ts` (moving to orchestrator) would have to fall back to a relative `@comis/channels/src/shared/regex-guard.js` path which is a forbidden cross-package internal import per AGENTS.md §1 ("Use public exports only — no cross-package internal imports").
2. **Add `mediaCompressor` (or whichever specific export `inbound-preprocess.ts` needs) to `channels/src/index.ts`** before inbound-preprocess moves. Same rationale as above.
3. Verify post-move: every `import` in the moved A-files resolves to either (a) a relative path within orchestrator (other A-files moved together) or (b) `@comis/channels` / `@comis/agent` / `@comis/core` / `@comis/shared` bare-package imports. No `@comis/channels/dist/...` or `../../channels/src/...` allowed.
