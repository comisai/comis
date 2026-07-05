// SPDX-License-Identifier: Apache-2.0
// @comis/channels - Channel adapters and messaging infrastructure

// Telegram adapter
export { createTelegramAdapter } from "./telegram/telegram-adapter/index.js";
export type { TelegramAdapterDeps, TelegramAdapterHandle } from "./telegram/telegram-adapter/index.js";

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

// Discord channel narrowing types + helpers. Structural subset of
// discord.js runtime shape; no module augmentation. Narrowing helpers
// return null (not a Result) because narrowing is a typed-cast, not
// fallible computation.
//   * asTextLike + DiscordTextLikeChannel — text-like channels (pin/send/
//     edit/delete/setTopic/setRateLimitPerUser/sendTyping/threads).
//   * asThreadInfo + DiscordThreadInfo — per-thread iteration objects
//     emitted by the threadList action (id/name/archived/memberCount/
//     messageCount).
export { asTextLike, asThreadInfo } from "./discord/discord-adapter-types.js";
export type {
  DiscordTextLikeChannel,
  DiscordThreadInfo,
} from "./discord/discord-adapter-types.js";

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
// Signal wire types — the adapter's OWN signal-cli envelope/attachment interface
// (defined in ./signal/signal-client.ts). Surfaced on the public barrel TYPE-ONLY
// for the live channel-emulation harness: the Signal emulator's payload builders
// (test/live/emulators/signal/signal-payloads.ts) must
// import the adapter's OWN wire interface so an envelope shape drift is a COMPILE
// error — and the test/live vitest alias maps `@comis/channels` to dist/index.js
// (the barrel only), so the type is unreachable without this re-export. `export
// type` is ERASED at build (it adds NO runtime export → the no-`@comis/*`-
// runtime-edge rule holds; the harness imports it type-only). The only consumers are
// test/live/** + the channels index.test.ts barrel check — both excluded by the
// public-export-consumers AST walker (it scans packages/*/src/** and skips
// *.test.ts), so the matching PUBLIC_API_POLICY entry tracks them as documented
// baseline orphans. Mirrors the TELEGRAM thread-context / classifyTelegramError
// precedents. Shrink if a cross-package production consumer lands.
export type { SignalEnvelope, SignalAttachment } from "./signal/signal-client.js";

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

// Microsoft Teams adapter (route-driven, text round-trip)
export { createMsTeamsAdapter } from "./msteams/msteams-adapter.js";
export type { MsTeamsAdapterDeps, MsTeamsAdapterHandle } from "./msteams/msteams-adapter.js";
export { createMsTeamsPlugin } from "./msteams/msteams-plugin.js";
export type { MsTeamsPluginHandle } from "./msteams/msteams-plugin.js";

// Microsoft Teams utilities
export { mapMsTeamsActivityToNormalized } from "./msteams/message-mapper.js";
export type { TeamsActivity } from "./msteams/message-mapper.js";
export {
  validateActivityJwt,
  createActivityJwtValidator,
  createLocalActivityJwtValidator,
  createConnectorTokenProvider,
  createConnectorTokenProviderFor,
} from "./msteams/msteams-auth.js";
export type {
  ConnectorAuthMode,
  ConnectorTokenDeps,
  ConnectorTokenProvider,
} from "./msteams/msteams-auth.js";
export { validateMsTeamsCredentials } from "./msteams/credential-validator.js";
export { classifyMsTeamsError } from "./msteams/errors.js";

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

// Shared infrastructure
export { createTypingController } from "./shared/typing-controller.js";
export type {
  TypingController,
  TypingControllerConfig,
  TypingMode,
} from "./shared/typing-controller.js";
export { createTypingLifecycleController } from "./shared/typing-lifecycle-controller.js";
export type { TypingLifecycleController, TypingLifecycleOptions } from "./shared/typing-lifecycle-controller.js";

// The channel-platform-agnostic delivery helpers (formatForChannel,
// chunkForDelivery, createRetryEngine, isPermanentError, and the
// Markdown IR pipeline) live in `@comis/core` (export point:
// core/src/exports/delivery.ts). The standalone `deliverToChannel`
// function + `DeliverToChannelDeps` interface + queue-backoff helpers
// and delivery-type re-exports also live in `@comis/core` (which owns
// the types and the `createDeliveryService(deps)` factory).

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

// Telegram file-ref guard lives in `@comis/core` alongside ir-renderer
// (which depends on it). Imports must retarget to `@comis/core`.

// Channel health monitor
export { createChannelHealthMonitor } from "./shared/channel-health-monitor.js";
export type {
  ChannelHealthMonitor,
  ChannelHealthMonitorConfig,
  ChannelHealthState,
  ChannelHealthEntry,
} from "./shared/channel-health-monitor.js";

// ---------------------------------------------------------------------------
// Channels-side surface required by orchestrator A-files
//
// These symbols stay in channels/src/shared/ as either:
//   (a) bucket-A internals (block-pacer, block-coalescer, abort-summary,
//       send-policy, group-history-buffer) consumed by orchestrator-side
//       channel-manager.ts, or
//   (b) channels-internal helpers (regex-guard, media-compressor) consumed
//       by orchestrator-side moved A-files via the @comis/channels public
//       surface.
//
// SCOPE GUARD: only the symbols actually consumed by the orchestrator
// A-files (inbound-* + execution-*) are exported here. Speculative full-
// surface re-exports are rejected by test/architecture/public-export-
// consumers.test.ts (dead exports forbidden).
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
// type-only by execution-pipeline / inbound-pipeline / inbound-gate / inbound-route;
// createSendOverrideStore is needed by orchestrator channel-manager.ts)
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

// Telegram thread-context builders — the General-Topic id=1 asymmetry. SEND
// OMITS message_thread_id when the topic is the General topic (id=1, forum)
// while TYPING INCLUDES it; a non-forum group ignores reply-chain thread ids.
// Surfaced on the public barrel so this info-disclosure-relevant routing (never
// leak the General topic id onto a reply) is assertable from the public API.
export {
  buildSendThreadParams,
  buildTypingThreadParams,
  resolveTelegramThreadContext,
} from "./telegram/thread-context.js";
export type { TelegramThreadScope, TelegramThreadContext } from "./telegram/thread-context.js";

// Activity rendering strategies. The daemon composition root
// (setup-channels-runtime.ts) selects a per-channel ChannelActivityRenderer via
// `selectStrategy(caps, channelType)` from @comis/core, then constructs the
// matching strategy here via buildActivityRenderers. Echo→TestSink is
// the zero-adapter terminus; the four EditPlace channels (Telegram/Discord/
// Slack/WhatsApp) wrap createEditPlaceRenderer over a
// per-channel render-actions adapter + injected TimerPort/ClockPort. The
// DeleteAndRepost (Signal), AppendOnly (iMessage/LINE), LinePerEvent (IRC), and
// DigestOnly (Email) factories wire their per-channel render-actions adapters
// here too; buildActivityRenderers dispatches each from this
// barrel, so every channel type has a matching strategy. Deps differ per
// strategy: DeleteAndRepost takes {timer, clock}, LinePerEvent takes {clock},
// and AppendOnly/DigestOnly take none. The EditPlace + Echo factories + the
// createEditPlaceRenderer machine are re-exported here so the daemon's
// buildActivityRenderers can construct them from the @comis/channels barrel.
export { createTestSink } from "./shared/strategies/test-sink.js";
export { createEditPlaceRenderer } from "./shared/strategies/edit-place.js";
export type { EditPlaceDeps } from "./shared/strategies/edit-place.js";
export { createTelegramActivityRenderer, classifyTelegramError } from "./telegram/telegram-activity.js";
export { createDiscordActivityRenderer } from "./discord/discord-activity.js";
export { createSlackActivityRenderer } from "./slack/slack-activity.js";
export { createMSTeamsActivityRenderer } from "./msteams/msteams-activity.js";
export { createWhatsAppActivityRenderer } from "./whatsapp/whatsapp-activity.js";
export { createEchoActivityRenderer } from "./echo/echo-activity.js";
// Non-EditPlace strategy factories — wired by
// buildActivityRenderers. DeleteAndRepost→Signal, AppendOnly→{iMessage,
// LINE}, LinePerEvent→IRC, DigestOnly→Email.
export { createSignalActivityRenderer } from "./signal/signal-activity.js";
export { createIMessageActivityRenderer } from "./imessage/imessage-activity.js";
export { createLineActivityRenderer } from "./line/line-activity.js";
export { createIrcActivityRenderer } from "./irc/irc-activity.js";
export { createEmailActivityRenderer } from "./email/email-activity.js";
// MintApprovalLink is consumed by the daemon composition root to type the
// single-use email approval-link minter. EmailActivityRendererDeps stays internal
// (the factory's deps param is inferred at the call site).
export type { MintApprovalLink } from "./email/email-activity.js";

// The signing seam: the secret-bound signer the daemon composition root
// binds over `activity.interactiveCallbackSigningSecret` and injects into
// the activity-renderer deps. The renderers reach `@comis/core`'s signCallbackData
// through this closure and never import `@comis/orchestrator` (which would
// create a forbidden channels→orchestrator dependency edge).
export type { SignCallbackData } from "./shared/strategies/approval-render.js";
