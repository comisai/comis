// SPDX-License-Identifier: Apache-2.0
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
  msteams:   ["appId", "appPassword", "tenantId"],
  googlechat: ["serviceAccountKey", "subscriptionName"],
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

// ---------- Microsoft Teams ----------

// App (client) IDs and directory (tenant) IDs are GUIDs (8-4-4-4-12 hex).
const MSTEAMS_GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// App password (client secret) values are long -- an Azure-generated bot
// client secret is ~40 chars. Floor at 32 (matching the LINE channel-secret
// length, and in line with the sibling floors: Telegram 30, Discord 50, LINE
// token 100) to catch obviously-truncated pastes at wizard time; 32 stays
// safely below a real secret's length so a valid value is never rejected. This
// is a format-only typo-catcher, not a security control -- the daemon surfaces
// the real auth error at first use.
const MSTEAMS_APP_PASSWORD_MIN_LENGTH = 32;

function validateMsTeams(
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (credentialType === "appId") {
    if (!MSTEAMS_GUID_PATTERN.test(value)) {
      return {
        message: "Invalid Microsoft Teams app ID.",
        hint: "The bot application (client) ID is a GUID (8-4-4-4-12).",
        field: "msteamsAppId",
      };
    }
  }

  if (credentialType === "tenantId") {
    if (!MSTEAMS_GUID_PATTERN.test(value)) {
      return {
        message: "Invalid Microsoft Teams tenant ID.",
        hint: "The directory (tenant) ID is a GUID (8-4-4-4-12).",
        field: "msteamsTenantId",
      };
    }
  }

  if (credentialType === "appPassword") {
    if (value.length < MSTEAMS_APP_PASSWORD_MIN_LENGTH) {
      return {
        message: "Invalid Microsoft Teams app password.",
        hint: "The app password (client secret) from the bot registration.",
        field: "msteamsAppPassword",
      };
    }
  }

  return undefined;
}

// ---------- Google Chat ----------

/**
 * Format-check a Google Chat credential. The service-account key is the only
 * value with a format worth catching early: it must be a service-account key
 * JSON carrying the two fields the outbound JWT mint needs (`client_email` and
 * `private_key`). A parse failure or a missing field is turned into a message
 * that names the requirement only -- the raw key text is NEVER placed in the
 * message, so no key material leaks through the failure path. This is a
 * format-only typo-catcher, not a security control: the daemon surfaces the real
 * auth error at first use. subscriptionName/audience have no format to check
 * here beyond the non-empty guard applied by the caller.
 */
function validateGoogleChat(
  credentialType: string,
  value: string,
): ValidationResult | undefined {
  if (credentialType === "serviceAccountKey") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        message: "Invalid Google Chat service-account key: not valid JSON.",
        hint: "Paste the downloaded service-account key JSON, or a path to the key file.",
        field: "googlechatServiceAccountKey",
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        message: "Invalid Google Chat service-account key: expected a JSON object.",
        hint: "The service-account key JSON must be an object with client_email and private_key.",
        field: "googlechatServiceAccountKey",
      };
    }
    const key = parsed as { client_email?: unknown; private_key?: unknown };
    const hasClientEmail = typeof key.client_email === "string" && key.client_email.trim() !== "";
    const hasPrivateKey = typeof key.private_key === "string" && key.private_key.trim() !== "";
    if (!hasClientEmail || !hasPrivateKey) {
      return {
        message: "Invalid Google Chat service-account key: missing client_email or private_key.",
        hint: "Use the full service-account key JSON downloaded from the Google Cloud console.",
        field: "googlechatServiceAccountKey",
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
    case "msteams":
      return validateMsTeams(credentialType, trimmed);
    case "googlechat":
      return validateGoogleChat(credentialType, trimmed);
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
