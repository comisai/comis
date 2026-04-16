/**
 * Channel credential validators.
 *
 * Per-channel format checks for bot tokens, API keys, and secrets.
 * These are format-only validations (prefix, length, pattern) -- not
 * API connectivity checks. Catching format errors early saves the user
 * from waiting for a network roundtrip to discover a typo.
 *
 * @module
 */

import type { ValidationResult } from "../types.js";

// ---------- Channel Credential Types ----------

/**
 * Credential types required by each channel.
 *
 * Used by wizard steps to know which credentials to prompt for.
 */
const CHANNEL_CREDENTIAL_TYPES: Record<string, readonly string[]> = {
  telegram:  ["botToken"],
  discord:   ["botToken"],
  slack:     ["botToken", "appToken"],
  line:      ["channelToken", "channelSecret"],
  whatsapp:  [],
  signal:    [],
  irc:       [],
};

// ---------- Telegram ----------

/** Telegram bot token: digits:alphanumeric, min 30 chars. */
const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
const TELEGRAM_MIN_LENGTH = 30;

function validateTelegram(
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (credentialType === "botToken") {
    if (value.length < TELEGRAM_MIN_LENGTH || !TELEGRAM_TOKEN_PATTERN.test(value)) {
      return {
        message: "Invalid Telegram bot token.",
        hint: "Format: 123456789:ABCdefGHI...",
        field: "telegramToken",
      };
    }
  }
  return undefined;
}

// ---------- Discord ----------

const DISCORD_MIN_LENGTH = 50;

function validateDiscord(
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (credentialType === "botToken") {
    if (value.length < DISCORD_MIN_LENGTH) {
      return {
        message: "Invalid Discord bot token.",
        hint: "Get one at https://discord.com/developers/applications",
        field: "discordToken",
      };
    }
  }
  return undefined;
}

// ---------- Slack ----------

const SLACK_BOT_PREFIX = "xoxb-";
const SLACK_APP_PREFIX = "xapp-";
const SLACK_MIN_LENGTH = 20;

function validateSlack(
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (credentialType === "botToken") {
    if (!value.startsWith(SLACK_BOT_PREFIX) || value.length < SLACK_MIN_LENGTH) {
      return {
        message: "Invalid Slack bot token.",
        hint: "Slack bot tokens start with 'xoxb-'",
        field: "slackBotToken",
      };
    }
  }

  if (credentialType === "appToken") {
    if (!value.startsWith(SLACK_APP_PREFIX) || value.length < SLACK_MIN_LENGTH) {
      return {
        message: "Invalid Slack app token.",
        hint: "Slack app tokens start with 'xapp-'",
        field: "slackAppToken",
      };
    }
  }

  return undefined;
}

// ---------- LINE ----------

const LINE_TOKEN_MIN_LENGTH = 100;
const LINE_SECRET_PATTERN = /^[0-9a-f]{32}$/i;

function validateLine(
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (credentialType === "channelToken") {
    if (value.length < LINE_TOKEN_MIN_LENGTH) {
      return {
        message: "Invalid LINE channel access token.",
        hint: "Token should be a long string from the LINE Developers Console",
        field: "lineToken",
      };
    }
  }

  if (credentialType === "channelSecret") {
    if (!LINE_SECRET_PATTERN.test(value)) {
      return {
        message: "Invalid LINE channel secret.",
        hint: "Secret should be a 32-character hex string",
        field: "lineSecret",
      };
    }
  }

  return undefined;
}

// ---------- Public API ----------

/**
 * Validate a channel credential value.
 *
 * Routes to channel-specific validation based on channelType.
 * Returns undefined if valid, or a ValidationResult with the format error.
 *
 * Channels without credential requirements (WhatsApp, Signal, IRC)
 * always return undefined (valid).
 *
 * @param channelType - Channel identifier (e.g. "telegram", "discord")
 * @param credentialType - Credential type (e.g. "botToken", "appToken")
 * @param value - The credential value to validate
 */
export function validateChannelCredential(
  channelType: string,
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (!value || value.trim().length === 0) {
    return {
      message: `${capitalize(channelType)} ${formatCredentialType(credentialType)} is required.`,
      field: `${channelType}${capitalize(credentialType)}`,
    };
  }

  const trimmed = value.trim();

  switch (channelType.toLowerCase()) {
    case "telegram":
      return validateTelegram(credentialType, trimmed);
    case "discord":
      return validateDiscord(credentialType, trimmed);
    case "slack":
      return validateSlack(credentialType, trimmed);
    case "line":
      return validateLine(credentialType, trimmed);
    case "whatsapp":
    case "signal":
    case "irc":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Get the credential types required for a channel.
 *
 * Returns an array of credential type identifiers that the wizard
 * should prompt for. Empty array means no credentials needed.
 *
 * @param channelType - Channel identifier (e.g. "telegram", "slack")
 */
export function getChannelCredentialTypes(
  channelType: string,
): string[] {
  const types = CHANNEL_CREDENTIAL_TYPES[channelType.toLowerCase()];
  return types ? [...types] : [];
}

// ---------- Helpers ----------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCredentialType(credType: string): string {
  // Convert camelCase to readable: "botToken" -> "bot token"
  return credType.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}
