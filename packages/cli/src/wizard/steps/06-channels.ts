// SPDX-License-Identifier: Apache-2.0
/**
 * Channel setup step -- step 06 of the init wizard.
 *
 * Presents a multiselect of all 7 supported channels with credential hints,
 * collects per-channel credentials inline with format pre-checks and live
 * API validation, shows deferred guidance for WhatsApp/Signal, silently
 * adds IRC, and stores ChannelConfig[] on wizard state.
 *
 * Live validation uses native fetch (Node 22+) with AbortController
 * timeouts, matching the pattern from 04-credentials.ts.
 *
 * @module
 */

import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  ChannelConfig,
} from "../index.js";
import {
  updateState,
  sectionSeparator,
  info,
  SUPPORTED_CHANNELS,
  validateChannelCredential,
} from "../index.js";

// ---------- Live Validation Functions ----------

/**
 * Validate a Telegram bot token via the getMe API.
 *
 * GET https://api.telegram.org/bot{token}/getMe
 */
async function validateTelegramLive(
  token: string,
): Promise<{ valid: boolean; username?: string; id?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { method: "GET", signal: controller.signal },
    );

    if (response.ok) {
      const data = (await response.json()) as {
        result: { username: string; id: number };
      };
      return { valid: true, username: data.result.username, id: data.result.id };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid bot token" };
    }

    return { valid: false, error: `Telegram API returned ${response.status}` };
  } catch {
    return { valid: false, error: "Could not reach Telegram API" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a Discord bot token via /users/@me.
 *
 * GET https://discord.com/api/v10/users/@me with Authorization: Bot {token}
 */
async function validateDiscordLive(
  token: string,
): Promise<{ valid: boolean; username?: string; discriminator?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      "https://discord.com/api/v10/users/@me",
      {
        method: "GET",
        headers: { Authorization: `Bot ${token}` },
        signal: controller.signal,
      },
    );

    if (response.ok) {
      const data = (await response.json()) as {
        username: string;
        discriminator: string;
      };
      return { valid: true, username: data.username, discriminator: data.discriminator };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid bot token" };
    }

    return { valid: false, error: `Discord API returned ${response.status}` };
  } catch {
    return { valid: false, error: "Could not reach Discord API" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a Slack bot token via auth.test.
 *
 * POST https://slack.com/api/auth.test with Authorization: Bearer {botToken}
 */
async function validateSlackLive(
  botToken: string,
): Promise<{ valid: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: controller.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        return { valid: true };
      }
      return { valid: false, error: data.error ?? "Auth test failed" };
    }

    return { valid: false, error: `Slack API returned ${response.status}` };
  } catch {
    return { valid: false, error: "Could not reach Slack API" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a LINE channel access token via getBotInfo.
 *
 * GET https://api.line.me/v2/bot/info with Authorization: Bearer {channelToken}
 */
async function validateLineLive(
  channelToken: string,
): Promise<{ valid: boolean; displayName?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://api.line.me/v2/bot/info", {
      method: "GET",
      headers: { Authorization: `Bearer ${channelToken}` },
      signal: controller.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as { displayName: string };
      return { valid: true, displayName: data.displayName };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid channel token" };
    }

    return { valid: false, error: `LINE API returned ${response.status}` };
  } catch {
    return { valid: false, error: "Could not reach LINE API" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the most recent sender's user ID from the bot's getUpdates endpoint.
 *
 * Calls getUpdates with a short timeout. Returns the first message sender's
 * user ID and name, or null if no messages are available.
 */
async function fetchTelegramSenderId(
  token: string,
): Promise<{ userId: number; firstName: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?limit=5&allowed_updates=["message"]`,
      { method: "GET", signal: controller.signal },
    );

    if (!response.ok) return null;

    const data = (await response.json()) as {
      ok: boolean;
      result: Array<{
        message?: { from?: { id: number; first_name: string } };
      }>;
    };

    if (!data.ok || !data.result.length) return null;

    for (const update of data.result.reverse()) {
      const from = update.message?.from;
      if (from) {
        return { userId: from.id, firstName: from.first_name };
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- Per-Channel Handlers ----------

/**
 * Collect Discord bot token and optional guild IDs with live validation.
 */
async function handleDiscord(
  prompter: WizardPrompter,
): Promise<ChannelConfig | null> {
  prompter.note(sectionSeparator("Discord Setup"));
  prompter.note(info("Create at: https://discord.com/developers/applications"));

  const maxRetries = 3;
  let validatedToken: string | null = null;
  let validated = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const token = await prompter.password({
      message: "Discord bot token",
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateChannelCredential("discord", "botToken", v);
        return result?.message;
      },
    });

    const spin = prompter.spinner();
    spin.start("Validating token...");
    const result = await validateDiscordLive(token);

    if (result.valid) {
      const display =
        result.discriminator && result.discriminator !== "0"
          ? `${result.username}#${result.discriminator}`
          : result.username;
      spin.stop(`Bot: ${display}`);
      validatedToken = token;
      validated = true;
      break;
    }

    spin.stop("Validation failed");
    prompter.log.warn(result.error ?? "Unknown validation error");

    const isLastAttempt = attempt === maxRetries;
    const recoveryOptions = isLastAttempt
      ? [
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip Discord" },
        ]
      : [
          { value: "retry" as const, label: "Try again" },
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip Discord" },
        ];

    const choice = await prompter.select<"retry" | "continue" | "skip">({
      message: "What would you like to do?",
      options: recoveryOptions,
    });

    if (choice === "continue") {
      validatedToken = token;
      validated = false;
      break;
    }
    if (choice === "skip") {
      return null;
    }
    // retry -- continue loop
  }

  if (validatedToken === null) {
    return null;
  }

  // Prompt for guild IDs
  const guildInput = await prompter.text({
    message: "Discord guild IDs (comma-separated, or blank for all)",
    defaultValue: "",
  });

  const guildIds = guildInput
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { type: "discord", botToken: validatedToken, guildIds, validated };
}

/**
 * Collect Slack bot token and app token with live validation.
 */
async function handleSlack(
  prompter: WizardPrompter,
): Promise<ChannelConfig | null> {
  prompter.note(sectionSeparator("Slack Setup"));

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const botToken = await prompter.password({
      message: "Slack bot token (xoxb-...)",
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateChannelCredential("slack", "botToken", v);
        return result?.message;
      },
    });

    const appToken = await prompter.password({
      message: "Slack app token (xapp-...)",
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateChannelCredential("slack", "appToken", v);
        return result?.message;
      },
    });

    const spin = prompter.spinner();
    spin.start("Validating tokens...");
    const result = await validateSlackLive(botToken);

    if (result.valid) {
      spin.stop("Workspace verified");
      return { type: "slack", botToken, appToken, validated: true };
    }

    spin.stop("Validation failed");
    prompter.log.warn(result.error ?? "Unknown validation error");

    const isLastAttempt = attempt === maxRetries;
    const recoveryOptions = isLastAttempt
      ? [
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip Slack" },
        ]
      : [
          { value: "retry" as const, label: "Try again" },
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip Slack" },
        ];

    const choice = await prompter.select<"retry" | "continue" | "skip">({
      message: "What would you like to do?",
      options: recoveryOptions,
    });

    if (choice === "continue") {
      return { type: "slack", botToken, appToken, validated: false };
    }
    if (choice === "skip") {
      return null;
    }
    // retry -- continue loop
  }

  return null;
}

/**
 * Collect LINE channel access token and secret with live validation.
 */
async function handleLine(
  prompter: WizardPrompter,
): Promise<ChannelConfig | null> {
  prompter.note(sectionSeparator("LINE Setup"));
  prompter.note(info("Get from LINE Developers Console -> Messaging API"));

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const channelToken = await prompter.password({
      message: "LINE channel access token",
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateChannelCredential("line", "channelToken", v);
        return result?.message;
      },
    });

    const channelSecret = await prompter.password({
      message: "LINE channel secret",
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateChannelCredential("line", "channelSecret", v);
        return result?.message;
      },
    });

    const spin = prompter.spinner();
    spin.start("Validating token...");
    const result = await validateLineLive(channelToken);

    if (result.valid) {
      spin.stop(`Bot: ${result.displayName}`);
      return { type: "line", botToken: channelToken, channelSecret, validated: true };
    }

    spin.stop("Validation failed");
    prompter.log.warn(result.error ?? "Unknown validation error");

    const isLastAttempt = attempt === maxRetries;
    const recoveryOptions = isLastAttempt
      ? [
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip LINE" },
        ]
      : [
          { value: "retry" as const, label: "Try again" },
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip LINE" },
        ];

    const choice = await prompter.select<"retry" | "continue" | "skip">({
      message: "What would you like to do?",
      options: recoveryOptions,
    });

    if (choice === "continue") {
      return { type: "line", botToken: channelToken, channelSecret, validated: false };
    }
    if (choice === "skip") {
      return null;
    }
    // retry -- continue loop
  }

  return null;
}

/**
 * WhatsApp: deferred configuration guidance.
 */
function handleWhatsApp(prompter: WizardPrompter): ChannelConfig {
  prompter.note(
    info("WhatsApp will be configured after setup.\nRun `comis channel whatsapp-pair` to scan the QR code."),
    "WhatsApp",
  );
  return { type: "whatsapp", validated: false };
}

/**
 * Signal: deferred configuration guidance.
 */
function handleSignal(prompter: WizardPrompter): ChannelConfig {
  prompter.note(
    info("Signal requires signal-cli.\nRun `comis signal-setup` for guided installation."),
    "Signal",
  );
  return { type: "signal", validated: false };
}

/**
 * IRC: auto-configured with defaults, no credentials needed.
 */
function handleIrc(prompter: WizardPrompter): ChannelConfig {
  prompter.log.info("IRC added with default configuration (no credentials needed).");
  return { type: "irc", validated: true };
}

/**
 * Telegram handler that also returns the validated bot ID for use
 * as a placeholder hint in the sender trust prompt.
 */
async function handleTelegramWithId(
  prompter: WizardPrompter,
): Promise<ChannelHandlerResult> {
  prompter.note(sectionSeparator("Telegram Setup"));
  prompter.note(info("Create a bot via @BotFather -> /newbot -> copy the token"));

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const token = await prompter.password({
      message: "Telegram bot token",
      validate: (v: string) => {
        if (typeof v !== "string") return undefined;
        const result = validateChannelCredential("telegram", "botToken", v);
        return result?.message;
      },
    });

    const spin = prompter.spinner();
    spin.start("Validating token...");
    const result = await validateTelegramLive(token);

    if (result.valid) {
      spin.stop(`Bot: @${result.username} (ID: ${result.id})`);
      return {
        config: { type: "telegram", botToken: token, validated: true },
      };
    }

    spin.stop("Validation failed");
    prompter.log.warn(result.error ?? "Unknown validation error");

    const isLastAttempt = attempt === maxRetries;
    const recoveryOptions = isLastAttempt
      ? [
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip Telegram" },
        ]
      : [
          { value: "retry" as const, label: "Try again" },
          { value: "continue" as const, label: "Continue anyway", hint: "Not recommended" },
          { value: "skip" as const, label: "Skip Telegram" },
        ];

    const choice = await prompter.select<"retry" | "continue" | "skip">({
      message: "What would you like to do?",
      options: recoveryOptions,
    });

    if (choice === "continue") {
      return { config: { type: "telegram", botToken: token, validated: false } };
    }
    if (choice === "skip") {
      return { config: null };
    }
    // retry -- continue loop
  }

  return { config: null };
}

// ---------- Channel Handler Router ----------

/** Result from a channel handler. */
type ChannelHandlerResult = {
  config: ChannelConfig | null;
};

async function handleChannel(
  channelType: string,
  prompter: WizardPrompter,
): Promise<ChannelHandlerResult> {
  switch (channelType) {
    case "telegram":
      return handleTelegramWithId(prompter);
    case "discord":
      return { config: await handleDiscord(prompter) };
    case "slack":
      return { config: await handleSlack(prompter) };
    case "line":
      return { config: await handleLine(prompter) };
    case "whatsapp":
      return { config: handleWhatsApp(prompter) };
    case "signal":
      return { config: handleSignal(prompter) };
    case "irc":
      return { config: handleIrc(prompter) };
    default:
      return { config: null };
  }
}

// ---------- Step Implementation ----------

export const channelsStep: WizardStep = {
  id: "channels",
  label: "Channel Setup",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Channel Setup"));

    // 1. Channel multiselect
    const selected = await prompter.multiselect<string>({
      message: "Connect chat channels (select all that apply)",
      options: SUPPORTED_CHANNELS.map((ch) => ({
        value: ch.type,
        label: ch.label,
        hint: ch.credentialHint,
      })),
      required: false,
    });

    if (selected.length === 0) {
      if (state.channels && state.channels.length > 0) {
        prompter.log.info("Keeping existing channel configuration.");
      } else {
        prompter.log.info("No channels selected -- you can add them later.");
      }
      return state;
    }

    // 2. Per-channel credential collection
    const configs: ChannelConfig[] = [];

    for (const channelType of selected) {
      const result = await handleChannel(channelType, prompter);
      if (result.config !== null) {
        configs.push(result.config);
      }
    }

    // 3. Sender trust prompt (only when channels were configured)
    if (configs.length > 0) {
      const wantTrust = await prompter.confirm({
        message: "Grant admin access to specific senders?",
      });

      if (wantTrust) {
        const telegramConfig = configs.find((c) => c.type === "telegram");
        let detectedId: string | null = null;

        if (telegramConfig?.botToken) {
          const wantDetect = await prompter.confirm({
            message: "Auto-detect your Telegram user ID? (send any message to your bot first)",
          });

          if (wantDetect) {
            const spin = prompter.spinner();
            spin.start("Checking for messages...");
            const sender = await fetchTelegramSenderId(telegramConfig.botToken);

            if (sender) {
              spin.stop(`Found: ${sender.firstName} (${sender.userId})`);
              const useIt = await prompter.confirm({
                message: `Use ${sender.userId} as your admin sender ID?`,
              });
              if (useIt) {
                detectedId = String(sender.userId);
              }
            } else {
              spin.stop("No messages found");
              prompter.log.warn("Send a message to your bot in Telegram and try again, or enter your ID manually below.");
            }
          }
        }

        const hasOtherChannels = configs.some((c) => c.type !== "telegram" && c.type !== "whatsapp" && c.type !== "signal" && c.type !== "irc");

        let senderIds: string[];

        if (detectedId && !hasOtherChannels) {
          senderIds = [detectedId];
        } else {
          if (detectedId) {
            prompter.note(info("Add sender IDs for your other channels.\nDiscord: enable Developer Mode → right-click your name → Copy User ID."));
          } else {
            prompter.note(info("Enter YOUR user ID (not the bot ID).\nTelegram: send a message to your bot, then re-run setup to auto-detect — or find it via Telegram API.\nDiscord: enable Developer Mode → right-click your name → Copy User ID."));
          }

          const input = await prompter.text({
            message: "Your sender IDs (comma-separated)",
            placeholder: detectedId ? `e.g. ${detectedId}, <discord-id>` : "e.g. 678314278",
            defaultValue: detectedId ? `${detectedId}, ` : "",
            validate: (v: string) =>
              v.trim().length === 0 ? "At least one sender ID required" : undefined,
          });

          senderIds = input
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }

        const entries = senderIds.map((senderId) => ({ senderId, level: "admin" }));

        if (telegramConfig && senderIds.length > 0) {
          const restrictBot = await prompter.confirm({
            message: "Restrict Telegram bot to only respond to these senders?",
          });
          if (restrictBot) {
            telegramConfig.allowFrom = senderIds;
          }
        }

        return updateState(state, { channels: configs, senderTrustEntries: entries });
      }
    }

    // 4. Return state with collected channel configs
    return updateState(state, { channels: configs });
  },
};
