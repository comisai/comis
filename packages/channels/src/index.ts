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
export { filterResponse, NO_REPLY_TOKEN } from "./shared/response-filter.js";
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
export { createChannelManager } from "./shared/channel-manager.js";
export type { ChannelManager, ChannelManagerDeps } from "./shared/channel-manager.js";
export { createRetryEngine } from "./shared/retry-engine.js";
export type { RetryEngine } from "./shared/retry-engine.js";
export { createTypingController } from "./shared/typing-controller.js";
export type {
  TypingController,
  TypingControllerConfig,
  TypingMode,
} from "./shared/typing-controller.js";
export { createTypingLifecycleController } from "./shared/typing-lifecycle-controller.js";
export type { TypingLifecycleController, TypingLifecycleOptions } from "./shared/typing-lifecycle-controller.js";
export { formatForChannel } from "./shared/format-for-channel.js";
export { deliverToChannel, resolveChunkLimit, computeQueueBackoff, QUEUE_BACKOFF_SCHEDULE_MS } from "./shared/deliver-to-channel.js";
export type { DeliverToChannelOptions, DeliverToChannelDeps, DeliveryResult, ChunkDeliveryResult, DeliveryAdapter } from "./shared/deliver-to-channel.js";
export { chunkForDelivery } from "./shared/chunk-for-delivery.js";
export type { ChunkForDeliveryOptions } from "./shared/chunk-for-delivery.js";

// Permanent error classification
export { isPermanentError, PERMANENT_ERROR_PATTERNS } from "./shared/permanent-errors.js";

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

// Telegram file-ref guard
export {
  guardTelegramFileRefs,
  initTelegramFileGuardConfig,
  isTelegramFileGuardEnabled,
  ALWAYS_GUARD_EXTENSIONS,
  AMBIGUOUS_EXTENSIONS,
} from "./shared/telegram-file-ref-guard.js";

// Channel health monitor
export { createChannelHealthMonitor } from "./shared/channel-health-monitor.js";
export type {
  ChannelHealthMonitor,
  ChannelHealthMonitorConfig,
  ChannelHealthState,
  ChannelHealthEntry,
} from "./shared/channel-health-monitor.js";
