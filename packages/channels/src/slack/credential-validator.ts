// SPDX-License-Identifier: Apache-2.0
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
import type { HttpsProxyAgent } from "https-proxy-agent";
import { classifiedValidationErr } from "../shared/credential-validation-error.js";

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
  /**
   * Optional Web API root URL override (e.g. `http://127.0.0.1:54321`).
   * When set, the WebClient is constructed with `slackApiUrl=apiRoot` so
   * `auth.test()` hits the mock instead of `slack.com/api`. Production
   * leaves undefined.
   */
  apiRoot?: string;
  /**
   * Optional HttpsProxyAgent for egress-proxy environments. @slack/web-api uses
   * axios (node:https), which does NOT honor undici's global dispatcher, so the
   * proxy must be wired explicitly — the same agent the adapter uses at runtime.
   * Without it this auth.test() goes direct and fails in egress-locked networks
   * even when the token is valid.
   */
  agent?: HttpsProxyAgent<string>;
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
 * @param opts.apiRoot - Optional WebClient API URL override (E2E only).
 * @returns SlackBotInfo on success, Error on failure
 */
export async function validateSlackCredentials(
  opts: SlackValidateOpts,
): Promise<Result<SlackBotInfo, Error>> {
  if (!opts.botToken || opts.botToken.trim() === "") {
    return err(new Error("Invalid Slack credentials: botToken must not be empty"));
  }
  if (opts.mode === "socket") {
    if (!opts.appToken || opts.appToken.trim() === "") {
      return err(new Error("Invalid Slack credentials: Socket Mode requires appToken (xapp-*)"));
    }
    if (!opts.appToken.startsWith("xapp-")) {
      return err(
        new Error(
          'Invalid Slack credentials: Socket Mode appToken must start with "xapp-" (got a different token type)',
        ),
      );
    }
  }
  if (opts.mode === "http") {
    if (!opts.signingSecret || opts.signingSecret.trim() === "") {
      return err(new Error("Invalid Slack credentials: HTTP Mode requires signingSecret"));
    }
  }
  try {
    const { WebClient } = await import("@slack/web-api");
    // E2E seam: pass slackApiUrl only when redirected. Proxy: pass the agent so
    // auth.test() routes through the egress proxy (axios bypasses undici's
    // global dispatcher), mirroring the adapter's WebClient agent wiring.
    const clientOptions = {
      ...(opts.apiRoot ? { slackApiUrl: opts.apiRoot } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
    };
    const client =
      Object.keys(clientOptions).length > 0
        ? new WebClient(opts.botToken, clientOptions)
        : new WebClient(opts.botToken);
    const result = await client.auth.test();

    return ok({
      userId: String(result.user_id ?? ""),
      teamId: String(result.team_id ?? ""),
      botId: String(result.bot_id ?? ""),
    });
  } catch (error: unknown) {
    return classifiedValidationErr(
      error,
      "Slack auth.test() failed",
      "Slack auth.test() unreachable (network/proxy)",
    );
  }
}
