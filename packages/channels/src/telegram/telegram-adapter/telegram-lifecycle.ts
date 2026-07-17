// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram lifecycle helpers.
 *
 * State-first wrappers around the createTelegramAdapter lifecycle methods:
 *   - startLifecycle  -> token validation, webhook-secret validation,
 *                        setMyCommands, inbound-handler wiring, sequential
 *                        polling boot.
 *   - stopLifecycle   -> drain inbound work, stop polling, clear connected flag.
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
import { ok, err, withTimeout } from "@comis/shared";
import { systemNowMs, systemScheduleTimeout, toSafeErrorLogString } from "@comis/core";
import { validateBotToken, validateWebhookSecret } from "../credential-validator.js";
import {
  TELEGRAM_BOT_COMMANDS,
  type TelegramAdapterDeps,
  type TelegramAdapterState,
} from "./telegram-adapter-types.js";
import { bindInboundHandlers, TelegramAdapterStoppingError } from "./telegram-inbound.js";

const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "poll",
  "message_reaction",
] as const;

const TELEGRAM_INBOUND_DRAIN_TIMEOUT_MS = 4_000;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(toSafeErrorLogString(error));
}

function serializeLifecycle(
  state: TelegramAdapterState,
  operation: () => Promise<Result<void, Error>>,
): Promise<Result<void, Error>> {
  const result = state.lifecycleTail.then(operation, operation);
  state.lifecycleTail = result.then(() => undefined, () => undefined);
  return result;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Token-validate, set commands, wire inbound handlers, and boot the
 * one-update-at-a-time polling. Webhook configuration is rejected until a
 * receiver is wired into the composition root.
 *
 * Mutates: state.channelId, state.botIdentity, state.pollingTask,
 * state.connected, state.startedAt.
 */
export function startLifecycle(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
): Promise<Result<void, Error>> {
  return serializeLifecycle(state, () => startLifecycleExclusive(state, deps));
}

async function startLifecycleExclusive(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
): Promise<Result<void, Error>> {
  if (state.connected && state.pollingTask) return ok(undefined);

  if (deps.webhookUrl) {
    const unsupported = new Error(
      "Telegram webhook ingestion is not available; remove channels.telegram.webhookUrl to use polling",
    );
    deps.logger.error(
      {
        channelType: "telegram",
        hint: "Remove channels.telegram.webhookUrl until a Telegram webhook receiver is configured",
        errorKind: "config" as const,
      },
      "Adapter start failed",
    );
    return err(unsupported);
  }

  // Fail fast on invalid token. Pass apiRoot if set so the in-adapter
  // validation also targets the redirection mock; otherwise the validator
  // hits api.telegram.org and 401s in E2E tests.
  const botToken = deps.getBotToken();
  const tokenResult = await validateBotToken(botToken, deps.apiRoot);
  if (!tokenResult.ok) {
    deps.logger.error(
      {
        channelType: "telegram",
        err: toSafeErrorLogString(tokenResult.error),
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
  const botIdentity = { id: botInfo.id, username: botInfo.username };
  state.botIdentity = botIdentity;

  // Validate webhook secret if provided
  if (deps.webhookSecret) {
    const secretResult = validateWebhookSecret(deps.webhookSecret);
    if (!secretResult.ok) {
      deps.logger.error(
        {
          channelType: "telegram",
          err: toSafeErrorLogString(secretResult.error),
          hint: "Verify TELEGRAM_BOT_TOKEN is a valid bot token from @BotFather",
          errorKind: "auth" as const,
        },
        "Adapter start failed",
      );
      return err(secretResult.error);
    }
  }

  if (state.bot.isRunning()) {
    const stillRunning = new Error("Cannot restart Telegram while the previous polling generation is running");
    deps.logger.error(
      {
        channelType: "telegram",
        hint: "Stop the current Telegram polling generation before restarting it",
        errorKind: "precondition" as const,
      },
      "Adapter start failed",
    );
    return err(stillRunning);
  }
  state.bot = state.createBot(botToken);
  state.inboundHandlersBound = false;

  const generation = state.pollingGeneration + 1;
  state.pollingGeneration = generation;

  // Register slash commands with Telegram for autocomplete menu
  state.bot.api.setMyCommands(TELEGRAM_BOT_COMMANDS).catch((cmdErr) => {
    deps.logger.warn(
      {
        channelType: "telegram",
        err: toSafeErrorLogString(cmdErr),
        hint: "Bot commands menu will not be available; check bot token permissions",
        errorKind: "platform" as const,
      },
      "Failed to register bot commands",
    );
  });

  if (!state.inboundHandlersBound) {
    bindInboundHandlers(state, deps, botIdentity);
    state.bot.catch((botError) => {
      if (botError.error instanceof TelegramAdapterStoppingError) {
        deps.logger.debug(
          { channelType: "telegram", step: "telegram-stop-gate" },
          "Telegram update left unconfirmed during shutdown",
        );
        return Promise.reject(botError.error);
      }
      deps.logger.error(
        {
          channelType: "telegram",
          err: toSafeErrorLogString(botError.error),
          hint: "Restart Telegram polling after resolving the inbound handler failure",
          errorKind: "internal" as const,
        },
        "Telegram inbound update failed",
      );
      return Promise.reject(botError.error);
    });
    state.inboundHandlersBound = true;
  }

  state.acceptingUpdates = true;
  state.stopGateTriggered = false;
  const ready = createDeferred();
  let pollingTask: Promise<void>;
  try {
    // Limit every getUpdates request to one update. Telegram confirms the
    // previous offset on the next request. A new Bot is used for every retry
    // generation so a failed update is requested from its original offset.
    pollingTask = state.bot.start({
      limit: 1,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      onStart: () => { ready.resolve(); },
    });
  } catch (startError) {
    state.acceptingUpdates = false;
    state.lastError = "Telegram polling failed before startup";
    return err(asError(startError));
  }
  state.pollingTask = pollingTask;

  void pollingTask.then(
    () => {
      if (state.pollingGeneration !== generation || state.pollingTask !== pollingTask) return;
      state.pollingTask = null;
      state.connected = false;
      if (!state.acceptingUpdates) return;
      state.acceptingUpdates = false;
      state.connected = false;
      state.lastError = "Telegram polling stopped unexpectedly";
      deps.logger.warn(
        {
          channelType: "telegram",
          hint: "Restart the Telegram adapter and inspect the preceding polling failure",
          errorKind: "platform" as const,
        },
        "Telegram polling stopped unexpectedly",
      );
    },
    (pollingError) => {
      if (state.pollingGeneration !== generation || state.pollingTask !== pollingTask) return;
      state.pollingTask = null;
      state.connected = false;
      const expectedStop = !state.acceptingUpdates;
      state.acceptingUpdates = false;
      if (expectedStop && pollingError instanceof TelegramAdapterStoppingError) return;
      state.lastError = "Telegram polling stopped after an inbound failure";
      deps.logger.error(
        {
          channelType: "telegram",
          err: toSafeErrorLogString(pollingError),
          hint: "Resolve the inbound failure and restart the Telegram adapter",
          errorKind: "platform" as const,
        },
        "Telegram polling failed",
      );
    },
  );

  const startup = await Promise.race([
    ready.promise.then(() => ({ kind: "ready" as const })),
    pollingTask.then(
      () => ({ kind: "stopped" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    ),
  ]);

  if (startup.kind !== "ready") {
    state.connected = false;
    state.acceptingUpdates = false;
    state.lastError = startup.kind === "failed"
      ? "Telegram polling failed before startup"
      : "Telegram polling stopped before startup";
    return err(startup.kind === "failed"
      ? asError(startup.error)
      : new Error("Telegram polling stopped before startup completed"));
  }

  if (state.pollingGeneration !== generation || state.pollingTask !== pollingTask) {
    state.connected = false;
    state.acceptingUpdates = false;
    return err(new Error("Telegram polling generation changed during startup"));
  }

  state.connected = true;
  state.startedAt = systemNowMs();
  state.lastError = undefined;

  deps.logger.info(
    { channelType: "telegram", botId: botInfo.id, username: botInfo.username, mode: "polling" },
    "Adapter started",
  );

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/** Drain accepted work, then stop polling so offset confirmation is safe. */
export function stopLifecycle(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
): Promise<Result<void, Error>> {
  state.acceptingUpdates = false;
  state.connected = false;
  return serializeLifecycle(state, () => stopLifecycleExclusive(state, deps));
}

async function stopLifecycleExclusive(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
): Promise<Result<void, Error>> {
  state.acceptingUpdates = false;
  try {
    const drain = async (): Promise<void> => {
      while (state.inFlightUpdates.size > 0) {
        await Promise.allSettled([...state.inFlightUpdates]);
      }
    };
    try {
      await withTimeout(
        drain(),
        TELEGRAM_INBOUND_DRAIN_TIMEOUT_MS,
        systemScheduleTimeout,
        "Telegram inbound drain",
      );
    } catch (drainError) {
      state.connected = false;
      state.lastError = "Telegram inbound drain timed out during shutdown";
      deps.logger.error(
        {
          channelType: "telegram",
          err: toSafeErrorLogString(drainError),
          hint: "Cancel or complete the active Telegram handler before stopping the daemon",
          errorKind: "timeout" as const,
        },
        "Telegram inbound drain timed out",
      );
      return err(asError(drainError));
    }

    state.connected = false;
    if (!state.stopGateTriggered && state.bot.isRunning()) {
      await state.bot.stop();
    }
    const pollingTask = state.pollingTask;
    if (pollingTask) {
      await pollingTask.catch(() => undefined);
    }
    if (state.pollingTask === pollingTask) state.pollingTask = null;
    deps.logger.info({ channelType: "telegram" }, "Adapter stopped");
    return ok(undefined);
  } catch (error) {
    const message = toSafeErrorLogString(error);
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
