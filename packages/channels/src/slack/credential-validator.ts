/**
 * Slack Credential Validator: Validates bot token and mode-specific credentials.
 *
 * Supports two modes:
 * - Socket Mode: Requires botToken + appToken (xapp-*)
 * - HTTP Mode: Requires botToken + signingSecret
 *
 * Calls Slack's auth.test() API to verify the bot token and retrieve
 * bot identity information (userId, teamId, botId).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Bot identity information returned after successful credential validation.
 */
export interface SlackBotInfo {
  /** Slack user ID of the bot (e.g. "U1234567890") */
  userId: string;
  /** Slack team/workspace ID (e.g. "T1234567890") */
  teamId: string;
  /** Slack bot ID (e.g. "B1234567890") */
  botId: string;
}

/** Options for Slack credential validation. */
interface SlackValidateOpts {
  botToken: string;
  mode: "socket" | "http";
  appToken?: string;
  signingSecret?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate Slack credentials by checking mode-specific requirements
 * and calling auth.test() to verify the bot token.
 *
 * @param opts.botToken - The Slack bot token (xoxb-*)
 * @param opts.mode - "socket" for Socket Mode, "http" for HTTP Mode
 * @param opts.appToken - App-level token for Socket Mode (xapp-*)
 * @param opts.signingSecret - Signing secret for HTTP Mode
 * @returns SlackBotInfo on success, Error on failure
 */
export const validateSlackCredentials: (opts: SlackValidateOpts) => Promise<Result<SlackBotInfo, Error>> =
  createCredentialValidator<SlackValidateOpts, SlackBotInfo>({
    platform: "Slack",
    validateInputs: (opts) => {
      if (!opts.botToken || opts.botToken.trim() === "") {
        return "botToken must not be empty";
      }
      if (opts.mode === "socket") {
        if (!opts.appToken || opts.appToken.trim() === "") {
          return "Socket Mode requires appToken (xapp-*)";
        }
        if (!opts.appToken.startsWith("xapp-")) {
          return 'Socket Mode appToken must start with "xapp-" (got a different token type)';
        }
      }
      if (opts.mode === "http") {
        if (!opts.signingSecret || opts.signingSecret.trim() === "") {
          return "HTTP Mode requires signingSecret";
        }
      }
      return undefined;
    },
    callApi: async (opts) => {
      try {
        const { WebClient } = await import("@slack/web-api");
        const client = new WebClient(opts.botToken);
        const result = await client.auth.test();

        return ok({
          userId: String(result.user_id ?? ""),
          teamId: String(result.team_id ?? ""),
          botId: String(result.bot_id ?? ""),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Slack auth.test() failed: ${message}`));
      }
    },
  });
