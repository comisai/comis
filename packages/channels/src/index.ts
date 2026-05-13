// SPDX-License-Identifier: Apache-2.0
// @comis/channels - Channel adapters and messaging infrastructure

// Telegram adapter
export { createTelegramAdapter } from "./telegram/telegram-adapter.js";
export type { TelegramAdapterDeps, TelegramAdapterHandle } from "./telegram/telegram-adapter.js";

// Telegram utilities
export { mapGrammyToNormalized } from "./telegram/message-mapper.js";
export { buildAttachments } from "./telegram/media-handler.js";
export { validateBotToken, validateWebhookSecret } from "./telegram/credential-validator.js";
export type { BotInfo } from "./telegram/credential-validator.js";
export { createTelegramResolver } from "./telegram/telegram-resolver.js";
export type { TelegramResolverDeps } from "./telegram/telegram-resolver.js";

// Discord adapter
export { createDiscordAdapter } from "./discord/discord-adapter.js";
export type { DiscordAdapterDeps } from "./discord/discord-adapter.js";

// Discord utilities
export { mapDiscordToNormalized } from "./discord/message-mapper.js";
export { buildDiscordAttachments } from "./discord/media-handler.js";
export { validateDiscordToken } from "./discord/credential-validator.js";
export type { DiscordBotInfo } from "./discord/credential-validator.js";
export { chunkDiscordText } from "./discord/format-discord.js";
export type { ChunkDiscordTextOpts } from "./discord/format-discord.js";
// Discord resolver -- intentional API surface: provides platform-specific
// pre-download size checks for direct use outside CompositeResolver.
export { createDiscordResolver } from "./discord/discord-resolver.js";
export type { DiscordResolverDeps } from "./discord/discord-resolver.js";

// Slack adapter
export { createSlackAdapter } from "./slack/slack-adapter.js";
export type { SlackAdapterDeps } from "./slack/slack-adapter.js";

// Slack utilities
export { mapSlackToNormalized } from "./slack/message-mapper.js";
export type { SlackMessageEvent, SlackFile } from "./slack/message-mapper.js";
export {
  buildSlackAttachments,
  fetchWithSlackAuth,
  isSlackHostname,
} from "./slack/media-handler.js";
export { validateSlackCredentials } from "./slack/credential-validator.js";
export type { SlackBotInfo } from "./slack/credential-validator.js";
export { escapeSlackMrkdwn } from "./slack/format-slack.js";
export { createSlackResolver } from "./slack/slack-resolver.js";
export type { SlackResolverDeps } from "./slack/slack-resolver.js";

// WhatsApp adapter
export { createWhatsAppAdapter } from "./whatsapp/whatsapp-adapter.js";
export type { WhatsAppAdapterDeps, WhatsAppAdapterHandle } from "./whatsapp/whatsapp-adapter.js";

// WhatsApp utilities
export { mapBaileysToNormalized } from "./whatsapp/message-mapper.js";
export type { BaileysMessage } from "./whatsapp/message-mapper.js";
export { buildWhatsAppAttachments } from "./whatsapp/media-handler.js";
export { validateWhatsAppAuth } from "./whatsapp/credential-validator.js";
export {
  normalizeWhatsAppJid,
  isWhatsAppGroupJid,
  isWhatsAppUserJid,
  extractJidPhone,
} from "./whatsapp/jid-utils.js";
export { createWhatsAppResolver } from "./whatsapp/whatsapp-resolver.js";
export type { WhatsAppResolverDeps } from "./whatsapp/whatsapp-resolver.js";

// Signal adapter
export { createSignalAdapter } from "./signal/signal-adapter.js";
export type { SignalAdapterDeps } from "./signal/signal-adapter.js";

// Signal utilities
export { mapSignalToNormalized } from "./signal/message-mapper.js";
export { buildSignalAttachments } from "./signal/media-handler.js";
export { validateSignalConnection } from "./signal/credential-validator.js";
export type { SignalBotInfo } from "./signal/credential-validator.js";
export { convertIrToSignalTextStyles } from "./signal/signal-format.js";
export type { SignalTextStyle } from "./signal/signal-format.js";
// Signal resolver -- intentional API surface: provides platform-specific
// pre-download size checks for direct use outside CompositeResolver.
export { createSignalResolver } from "./signal/signal-resolver.js";
export type { SignalResolverDeps } from "./signal/signal-resolver.js";

// LINE adapter
export { createLineAdapter } from "./line/line-adapter.js";
export type { LineAdapterDeps, LineAdapterHandle } from "./line/line-adapter.js";

// LINE utilities
export { mapLineToNormalized } from "./line/message-mapper.js";
export { buildLineAttachments } from "./line/media-handler.js";
export { validateLineCredentials } from "./line/credential-validator.js";
export type { LineBotInfo } from "./line/credential-validator.js";
export { buildFlexMessage, buildFlexCarousel } from "./line/flex-builder.js";
export type { FlexTemplate, FlexAction } from "./line/flex-builder.js";
export { createRichMenuManager } from "./line/rich-menu-manager.js";
export type { RichMenuManager, RichMenuInput } from "./line/rich-menu-manager.js";
export { createLineResolver } from "./line/line-resolver.js";
export type { LineResolverDeps } from "./line/line-resolver.js";

// iMessage adapter
export { createIMessageAdapter } from "./imessage/imessage-adapter.js";
export type { IMessageAdapterDeps } from "./imessage/imessage-adapter.js";

// iMessage utilities
export { mapImsgToNormalized } from "./imessage/message-mapper.js";
export { buildImsgAttachments } from "./imessage/media-handler.js";
export { validateIMessageConnection } from "./imessage/credential-validator.js";
export type { ImsgBotInfo } from "./imessage/credential-validator.js";
export { createIMessageResolver } from "./imessage/imessage-resolver.js";
export type { IMessageResolverDeps } from "./imessage/imessage-resolver.js";

// IRC adapter
export { createIrcAdapter } from "./irc/irc-adapter.js";
export type { IrcAdapterDeps } from "./irc/irc-adapter.js";

// IRC utilities
export { mapIrcToNormalized } from "./irc/message-mapper.js";
export { validateIrcConnection } from "./irc/credential-validator.js";
export type { IrcBotInfo } from "./irc/credential-validator.js";

// Email adapter
export { createEmailAdapter } from "./email/email-adapter.js";
export type { EmailAdapterDeps } from "./email/email-adapter.js";
export { createEmailPlugin } from "./email/email-plugin.js";
export { validateEmailCredentials } from "./email/credential-validator.js";
export type { EmailCredentialOpts, EmailCredentialInfo } from "./email/credential-validator.js";
export { isAllowedSender, isAutomatedSender } from "./email/sender-filter.js";
export { mapEmailToNormalized } from "./email/message-mapper.js";
export { createImapLifecycle } from "./email/imap-lifecycle.js";
export type { ImapLifecycleOpts, ImapLifecycleHandle } from "./email/imap-lifecycle.js";
export { buildThreadingHeaders, extractThreadId } from "./email/threading.js";

// Echo adapter (testing)
export { EchoChannelAdapter } from "./echo/echo-adapter.js";
export type { EchoAdapterOptions } from "./echo/echo-adapter.js";

// Channel plugin factories
export { createTelegramPlugin } from "./telegram/telegram-plugin.js";
export type { TelegramPluginHandle } from "./telegram/telegram-plugin.js";
export { createDiscordPlugin } from "./discord/discord-plugin.js";
export { createSlackPlugin } from "./slack/slack-plugin.js";
export { createWhatsAppPlugin } from "./whatsapp/whatsapp-plugin.js";
export { createEchoPlugin } from "./echo/echo-plugin.js";
export { createSignalPlugin } from "./signal/signal-plugin.js";
export { createLinePlugin } from "./line/line-plugin.js";
export type { LinePluginHandle } from "./line/line-plugin.js";
export { createIMessagePlugin } from "./imessage/imessage-plugin.js";
export { createIrcPlugin } from "./irc/irc-plugin.js";

// Channel registry
export { createChannelRegistry } from "./shared/channel-registry.js";
export type { ChannelRegistry, ChannelRegistryOptions } from "./shared/channel-registry.js";

// Auto-reply engine
export { evaluateAutoReply, isGroupMessage, isBotMentioned } from "./shared/auto-reply-engine.js";
export type { AutoReplyDecision } from "./shared/auto-reply-engine.js";

// Audio preflight
export { audioPreflight } from "./shared/audio-preflight.js";
export type { PreflightResult, PreflightDeps } from "./shared/audio-preflight.js";

// Response filter (NO_REPLY + HEARTBEAT_OK token suppression)
export { filterResponse, NO_REPLY_TOKEN, HEARTBEAT_OK_TOKEN } from "./shared/response-filter.js";
export type { FilterResult } from "./shared/response-filter.js";

// Media utilities (shared attachment type resolution)
export { mimeToAttachmentType } from "./shared/media-utils.js";

// Poll result normalizers (cross-platform)
export {
  normalizeTelegramPollResult,
  normalizeDiscordPollResult,
  normalizeWhatsAppPollResult,
} from "./shared/poll-normalizer.js";
export type {
  TelegramPollData,
  DiscordPollData,
  WhatsAppPollData,
} from "./shared/poll-normalizer.js";

// Approval notifier
export { createApprovalNotifier } from "./shared/approval-notifier.js";
export type { ApprovalNotifier, ApprovalNotifierDeps } from "./shared/approval-notifier.js";

// Shared infrastructure
// Phase 32 commit 4: channel-manager.ts (factory + types) moved to
// @comis/orchestrator. Daemon composition root (setup-channels.ts) imports
// them from @comis/orchestrator now. Removed from channels public surface.
export { createTypingController } from "./shared/typing-controller.js";
export type {
  TypingController,
  TypingControllerConfig,
  TypingMode,
} from "./shared/typing-controller.js";
export { createTypingLifecycleController } from "./shared/typing-lifecycle-controller.js";
export type { TypingLifecycleController, TypingLifecycleOptions } from "./shared/typing-lifecycle-controller.js";

// Phase 30 plan 02 (CONFIG-DELIV-04, -05): the channel-platform-agnostic
// delivery helpers — formatForChannel, chunkForDelivery (+ ChunkForDeliveryOptions),
// createRetryEngine (+ RetryEngine), isPermanentError (+ PERMANENT_ERROR_PATTERNS),
// and the underlying Markdown IR pipeline (markdown-ir, ir-renderer, ir-chunker,
// markdown-tables, sanitize-for-plain-text, table-converter, telegram-file-ref-guard)
// moved to `@comis/core` (export point: core/src/exports/delivery.ts). Imports
// must retarget; per AGENTS.md §2.3 (KISS/YAGNI + no back-compat shims), no
// re-exports stay here.
//
// Phase 30 plan 06: the standalone `deliverToChannel` function +
// `DeliverToChannelDeps` interface + queue-backoff helpers
// (QUEUE_BACKOFF_SCHEDULE_MS, computeQueueBackoff, resolveChunkLimit) +
// delivery-type re-exports (DeliverToChannelOptions, DeliveryResult,
// ChunkDeliveryResult, DeliveryAdapter) were deleted from `@comis/channels`.
// Consumers retarget to `@comis/core` (which now owns the types and the
// `createDeliveryService(deps)` factory replacing the standalone function).

// Voice response pipeline
export { executeVoiceResponse } from "./shared/voice-response-pipeline.js";
export type { VoiceResponsePipelineDeps, VoiceResponseContext, VoiceResponseResult } from "./shared/voice-response-pipeline.js";

// Outbound media handler
export { deliverOutboundMedia } from "./shared/outbound-media-handler.js";
export type { OutboundMediaDeps, OutboundMediaResult } from "./shared/outbound-media-handler.js";

// Lifecycle reactions
export { createLifecycleReactor } from "./shared/lifecycle-reactor.js";
export type { LifecycleReactor, LifecycleReactorDeps } from "./shared/lifecycle-reactor.js";
export {
  type LifecyclePhase,
  type PhaseCategory,
  isValidTransition,
  isTerminal,
  getPhaseCategory,
  ALL_PHASES,
} from "./shared/lifecycle-state-machine.js";
export {
  type EmojiTier,
  type EmojiSet,
  EMOJI_SETS,
  classifyToolPhase,
  getEmojiForPhase,
} from "./shared/emoji-tier-map.js";
export { toSlackShortname, UNICODE_TO_SLACK } from "./shared/slack-emoji-map.js";
export {
  PHASE_MULTIPLIERS,
  computeStallThresholds,
  getPhaseMultiplier,
  type StallThresholds,
} from "./shared/stall-detector.js";
export { reactWithFallback, TELEGRAM_SAFE_EMOJI } from "./telegram/emoji-fallback.js";

// Response prefix template engine
export { tokenizeTemplate, resolveTokens, applyPrefix, FORMATTERS } from "./shared/prefix-template.js";
export type { TemplateToken } from "./shared/prefix-template.js";

// Telegram file-ref guard — moved to `@comis/core` (Phase 30 plan 02
// scope expansion: ir-renderer.ts depends on the guard, and ir-renderer
// moved to core alongside the format/chunk helpers; the guard followed).
// Imports must retarget to `@comis/core`; no re-export here per
// AGENTS.md §2.3 (no back-compat shims).

// Channel health monitor
export { createChannelHealthMonitor } from "./shared/channel-health-monitor.js";
export type {
  ChannelHealthMonitor,
  ChannelHealthMonitorConfig,
  ChannelHealthState,
  ChannelHealthEntry,
} from "./shared/channel-health-monitor.js";

// ---------------------------------------------------------------------------
// Phase 32 commit 3 — channels-side surface required by moved A-files
//
// These symbols stay in channels/src/shared/ at commit 3 because either:
//   (a) they are commit-4 movers (block-pacer, block-coalescer, abort-summary,
//       send-policy, group-history-buffer — bucket-A internals consumed by
//       channel-manager.ts which moves at commit 4), or
//   (b) they are channels-internal helpers (regex-guard, media-compressor —
//       bucket-B/C per Wave 2 inventory) consumed by orchestrator-side
//       moved A-files via @comis/channels public surface.
//
// Once channel-manager.ts moves to orchestrator (commit 4), the bucket-A
// internals in group (a) also move and these re-exports are removed.
// See packages/orchestrator/HELPER-OWNERSHIP-INVENTORY.md.
//
// SCOPE GUARD: only the symbols actually consumed by the moved orchestrator
// A-files (inbound-* + execution-*) are exported here. Speculative full-
// surface re-exports are rejected by test/architecture/public-export-
// consumers.test.ts (L9/L10/L11 — dead exports forbidden).
// ---------------------------------------------------------------------------

// Regex safety guard (consumed by orchestrator inbound-pipeline.ts)
export { isRegexSafe } from "./shared/regex-guard.js";

// Media attachment compressor (consumed by orchestrator inbound-preprocess.ts)
export { compressAttachments } from "./shared/media-compressor.js";

// Block streaming primitives (consumed by orchestrator execution-deliver/
// execution-pipeline / inbound-pipeline / inbound-route / execution-pipeline.test)
export { createBlockPacer } from "./shared/block-pacer.js";
export type { BlockPacer, PacerConfig } from "./shared/block-pacer.js";
export { coalesceBlocks } from "./shared/block-coalescer.js";

// Abort summary builder (consumed by orchestrator execution-filter.ts)
export { buildAbortSummary } from "./shared/abort-summary.js";

// Send policy primitives (consumed by orchestrator execution-policy.ts +
// type-only by execution-pipeline / inbound-pipeline / inbound-gate / inbound-route +
// commit 4: createSendOverrideStore needed by orchestrator channel-manager.ts)
export {
  evaluateSendPolicy,
  applySessionOverride,
  createSendOverrideStore,
} from "./shared/send-policy.js";
export type {
  SendOverrideStore,
  SendPolicyContext,
} from "./shared/send-policy.js";

// Group history buffer (consumed type-only by orchestrator inbound-pipeline.ts)
export type { GroupHistoryBuffer } from "./shared/group-history-buffer.js";

// Telegram thread propagation metadata keys (consumed by orchestrator
// execution-pipeline.test.ts for cross-set equivalence assertion)
export { TELEGRAM_THREAD_META_KEYS } from "./telegram/thread-context.js";
