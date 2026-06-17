// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram lifecycle helpers.
 *
 * State-first wrappers around the createTelegramAdapter lifecycle methods:
 *   - startLifecycle  -> token validation, webhook-secret validation,
 *                        setMyCommands, inbound-handler wiring, runner
 *                        boot (or webhook deferral).
 *   - stopLifecycle   -> stop grammy/runner, clear connected flag.
 *   - getStatusReport -> read connected/channelId/startedAt/lastMessageAt/
 *                        lastError into the ChannelStatus shape.
 *
 * State-first protocol: every helper takes `state: TelegramAdapterState`
 * as its FIRST positional parameter, `deps: TelegramAdapterDeps` as
 * SECOND, then per-call args.
 *
 * @module
 */

import type { ChannelStatus } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { run } from "@grammyjs/runner";
import { systemNowMs } from "@comis/core";
import { validateBotToken, validateWebhookSecret } from "../credential-validator.js";
import {
  TELEGRAM_BOT_COMMANDS,
  type TelegramAdapterDeps,
  type TelegramAdapterState,
} from "./telegram-adapter-types.js";
import { bindInboundHandlers } from "./telegram-inbound.js";
import { shouldUseRunner } from "./telegram-webhook.js";

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Token-validate, set commands, wire inbound handlers, and boot the
 * runner (or defer to webhook mode if deps.webhookUrl is set).
 *
 * Mutates: state.channelId, state.botIdentity, state.runnerHandle,
 * state.connected, state.startedAt.
 */
export async function startLifecycle(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
): Promise<Result<void, Error>> {
  // Fail fast on invalid token. Pass apiRoot if set so the in-adapter
  // validation also targets the redirection mock; otherwise the validator
  // hits api.telegram.org and 401s in E2E tests.
  const tokenResult = await validateBotToken(deps.botToken, deps.apiRoot);
  if (!tokenResult.ok) {
    deps.logger.error(
      {
        channelType: "telegram",
        err: tokenResult.error,
        hint: "Verify TELEGRAM_BOT_TOKEN is a valid bot token from @BotFather",
        errorKind: "auth" as const,
      },
      "Adapter start failed",
    );
    return err(tokenResult.error);
  }

  const botInfo = tokenResult.value;
  state.channelId = `telegram-${botInfo.id}`;
  // Populate identity now that getMe() has succeeded: message mapper
  // uses this to detect mentions/replies/bot_commands aimed at us.
  state.botIdentity = { id: botInfo.id, username: botInfo.username };

  // Validate webhook secret if provided
  if (deps.webhookSecret) {
    const secretResult = validateWebhookSecret(deps.webhookSecret);
    if (!secretResult.ok) {
      deps.logger.error(
        {
          channelType: "telegram",
          err: secretResult.error,
          hint: "Verify TELEGRAM_BOT_TOKEN is a valid bot token from @BotFather",
          errorKind: "auth" as const,
        },
        "Adapter start failed",
      );
      return err(secretResult.error);
    }
  }

  // Register slash commands with Telegram for autocomplete menu
  state.bot.api.setMyCommands(TELEGRAM_BOT_COMMANDS).catch((cmdErr) => {
    deps.logger.warn(
      {
        channelType: "telegram",
        err: cmdErr instanceof Error ? cmdErr : new Error(String(cmdErr)),
        hint: "Bot commands menu will not be available; check bot token permissions",
        errorKind: "platform" as const,
      },
      "Failed to register bot commands",
    );
  });

  // Wire grammy event handlers (message / edited_message / poll / callback_query)
  bindInboundHandlers(state, deps);

  // Start polling (webhook mode deferred).
  // REACT-01 (Pitfall 1): once allowed_updates is set it must enumerate EVERY
  // update bindInboundHandlers consumes (message, edited_message,
  // callback_query, poll) PLUS message_reaction — omitting an existing one
  // silently stops its delivery. Telegram excludes message_reaction from the
  // default update set, so the opt-in is required for inbound reactions.
  if (shouldUseRunner(deps)) {
    state.runnerHandle = run(state.bot, {
      runner: {
        fetch: {
          allowed_updates: ["message", "edited_message", "callback_query", "poll", "message_reaction"],
        },
      },
    });
  }

  state.connected = true;
  state.startedAt = systemNowMs();

  deps.logger.info(
    { channelType: "telegram", botId: botInfo.id, username: botInfo.username, mode: deps.webhookUrl ? "webhook" : "polling" },
    "Adapter started",
  );

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/** Stop the grammy/runner loop (if running) and mark the adapter disconnected. */
export async function stopLifecycle(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
): Promise<Result<void, Error>> {
  try {
    if (state.runnerHandle && state.runnerHandle.isRunning()) {
      state.runnerHandle.stop();
    }
    state.connected = false;
    deps.logger.info({ channelType: "telegram" }, "Adapter stopped");
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Failed to stop Telegram adapter: ${message}`));
  }
}

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

/** Read the connection-status fields off `state` into the ChannelStatus shape. */
export function getStatusReport(state: TelegramAdapterState): ChannelStatus {
  return {
    connected: state.connected,
    channelId: state.channelId,
    channelType: "telegram",
    uptime: state.connected && state.startedAt ? systemNowMs() - state.startedAt : undefined,
    lastMessageAt: state.lastMessageAt,
    error: state.lastError,
    connectionMode: "polling",
  };
}
