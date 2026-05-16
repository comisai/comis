// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram-adapter shared types (Phase 43 split per FILE-SPLIT-12).
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

import type { ChannelPort, ComisLogger, MessageHandler } from "@comis/core";
import type { run } from "@grammyjs/runner";
import type { Bot } from "grammy";
import type { TelegramBotIdentity } from "../message-mapper.js";

// ---------------------------------------------------------------------------
// Public types (unchanged from the pre-split telegram-adapter.ts)
// ---------------------------------------------------------------------------

export interface TelegramAdapterDeps {
  botToken: string;
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
   * Phase 40 / Plan 40-09 / COV-15: production seam for the wire-level E2E
   * mock chat-platform fixture.
   */
  apiRoot?: string;
}

export interface TelegramAdapterHandle extends ChannelPort {
  /** Grammy Bot instance for media resolver creation. */
  readonly bot: Bot;
}

// ---------------------------------------------------------------------------
// Closure-extracted state (NEW; Phase 43 FILE-SPLIT-12)
// ---------------------------------------------------------------------------

/**
 * Mutable state shared across the state-first helpers extracted from the
 * pre-split createTelegramAdapter factory body. The pre-split factory
 * closure captured exactly these 9 variables; this interface enumerates
 * them explicitly so each leaf can read/write them via a single `state`
 * parameter instead of relying on lexical capture.
 *
 * Convention (matches Phase 42 pi-executor and the Phase 43 mcp-client
 * split): every state-first helper takes `state: TelegramAdapterState`
 * as its FIRST positional parameter, followed by `deps` and any per-call
 * arguments. `deps` is frozen at construction and is NOT part of state.
 *
 * Field naming: pre-split source used underscore-prefixed locals
 * (_channelId, _connected, _startedAt, _lastMessageAt, _lastError) for
 * the getStatus()-readable fields. The underscores carried no semantic
 * meaning (they distinguished the local from the public getter); the
 * post-split state interface drops them because the local-vs-getter
 * naming collision no longer exists once the locals live on `state`.
 */
export interface TelegramAdapterState {
  /** Grammy bot instance constructed in createTelegramAdapter and reused. */
  bot: Bot;
  /** Message handlers registered via handle.onMessage(). */
  handlers: MessageHandler[];
  /** "telegram-pending" before start(); "telegram-{botId}" after start() succeeds. */
  channelId: string;
  /** grammy/runner handle returned by run(bot); null in webhook mode and before start(). */
  runnerHandle: ReturnType<typeof run> | null;
  /** Populated by start() after getMe() succeeds; used by mapGrammyToNormalized to detect mentions. */
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
