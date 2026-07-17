// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram-adapter shared types.
 *
 * Type-only file: holds the three TelegramAdapter contract types
 * (deps, handle) and the closure-captured state interface, plus the
 * bot-command list constant consumed only by the lifecycle leaf.
 *
 * Per AGENTS.md no-cycles invariant: this file imports types only and
 * is the lowest-layer leaf in the telegram-adapter/ subdirectory; the
 * other four leaves (lifecycle, inbound, outbound, webhook) all import
 * from here. The barrel (index.ts) re-exports the public-API names.
 *
 * @module
 */

import type { ChannelPort, ComisLogger, MessageHandler, ReactionHandler } from "@comis/core";
import type { Bot } from "grammy";
import type { TelegramBotIdentity } from "../message-mapper.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TelegramAdapterDeps {
  /** Resolve the current credential for validation and each Bot generation. */
  getBotToken(): string;
  webhookSecret?: string;
  webhookUrl?: string;
  logger: ComisLogger;
  /** Optional callback for emitting poll result events */
  onPollResult?: (result: import("@comis/core").NormalizedPollResult) => void;
  /**
   * Optional Telegram Bot API root URL override. When set, the grammy `Bot`
   * is constructed with this URL as the API root instead of the default
   * `https://api.telegram.org`. Used by E2E tests that point the adapter at
   * a 127.0.0.1 mock server (see `test/e2e/mocks/telegram/`). Production
   * deployments leave this unset and rely on grammy's default. Must be a
   * fully-qualified URL (e.g. `http://127.0.0.1:54321`); no trailing slash.
   *
   * Production seam for the wire-level E2E mock chat-platform fixture.
   */
  apiRoot?: string;
}

export interface TelegramAdapterHandle extends ChannelPort {
  /** Grammy Bot instance for media resolver creation. */
  readonly bot: Bot;
}

// ---------------------------------------------------------------------------
// Closure-extracted state
// ---------------------------------------------------------------------------

/**
 * Mutable state shared across the state-first helpers extracted from the
 * createTelegramAdapter factory body. This interface enumerates the lifecycle
 * and handler state explicitly so each leaf can read/write it via a single
 * `state` parameter instead of relying on lexical capture.
 *
 * Convention: every state-first helper takes `state: TelegramAdapterState`
 * as its FIRST positional parameter, followed by `deps` and any per-call
 * arguments. `deps` is frozen at construction and is NOT part of state.
 *
 * Field naming: the getStatus()-readable fields drop the underscore prefix
 * that distinguished the local from the public getter — the local-vs-getter
 * naming collision no longer exists once the locals live on `state`.
 */
export interface TelegramAdapterState {
  /** Grammy bot instance owned by the current polling generation. */
  bot: Bot;
  /** Construct a fully configured Bot with no inherited polling offset. */
  createBot: (botToken: string) => Bot;
  /** Message handlers registered via handle.onMessage(). */
  handlers: MessageHandler[];
  /** Reaction handlers registered via handle.onReaction(). */
  reactionHandlers: ReactionHandler[];
  /** "telegram-pending" before start(); "telegram-{botId}" after start() succeeds. */
  channelId: string;
  /** Built-in sequential polling task; null before start and after shutdown. */
  pollingTask: Promise<void> | null;
  /** Monotonic owner token for polling completion callbacks. */
  pollingGeneration: number;
  /** Serializes start/stop transitions without a second lifecycle primitive. */
  lifecycleTail: Promise<void>;
  /** Inbound middleware promises that must settle before polling offset confirmation. */
  inFlightUpdates: Set<Promise<void>>;
  /** False before startup and immediately when shutdown is requested. */
  acceptingUpdates: boolean;
  /** Set when grammY presents an update after the shutdown gate closes. */
  stopGateTriggered: boolean;
  /** Prevent duplicate middleware registration across lifecycle restarts. */
  inboundHandlersBound: boolean;
  /** Populated by start() after getMe() succeeds; scopes inbound ids and addressing to this account. */
  botIdentity: TelegramBotIdentity | undefined;
  /** true after start() succeeds; false before start() and after stop(). */
  connected: boolean;
  /** systemNowMs() captured at successful start; undefined before. */
  startedAt: number | undefined;
  /** systemNowMs() captured on each inbound/outbound message; undefined initially. */
  lastMessageAt: number | undefined;
  /** Last outbound error message; undefined when no error has been observed. */
  lastError: string | undefined;
}

// ---------------------------------------------------------------------------
// Bot commands for Telegram autocomplete menu (consumed by lifecycle.start)
//
// Excludes: /config (admin-only), /reasoning (alias for /think)
// ---------------------------------------------------------------------------

export const TELEGRAM_BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "new", description: "Start a new conversation" },
  { command: "reset", description: "Reset the current session" },
  { command: "status", description: "Show session status and stats" },
  { command: "usage", description: "Show token usage breakdown" },
  { command: "context", description: "Show context window info" },
  { command: "model", description: "Show or switch the current model" },
  { command: "think", description: "Set thinking level (off/low/medium/high)" },
  { command: "verbose", description: "Toggle verbose mode" },
  { command: "compact", description: "Compact the conversation history" },
  { command: "export", description: "Export session to HTML" },
  { command: "stop", description: "Stop the current execution" },
  { command: "fork", description: "Fork the conversation" },
  { command: "branch", description: "Navigate conversation branches" },
];
