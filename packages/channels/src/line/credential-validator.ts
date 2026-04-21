// SPDX-License-Identifier: Apache-2.0
/**
 * LINE Credential Validator: Verifies LINE channel access tokens and secrets.
 *
 * Uses the MessagingApiClient.getBotInfo() API to validate that a channel
 * access token is valid and retrieve bot identity information.
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { messagingApi } from "@line/bot-sdk";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

/**
 * Bot identity information returned after successful credential validation.
 */
export interface LineBotInfo {
  /** Bot's display name */
  displayName: string;
  /** Bot's user ID */
  userId: string;
  /** Bot's basic ID (e.g. @123abcde) */
  basicId: string;
}

/** Options for LINE credential validation. */
interface LineValidateOpts {
  channelAccessToken: string;
  channelSecret: string;
}

/**
 * Validate LINE credentials by calling the getBotInfo() API.
 *
 * Creates a MessagingApiClient with the provided token, calls getBotInfo(),
 * and returns bot identity on success. Also validates that the channel secret
 * is non-empty (needed for webhook signature verification).
 *
 * @param opts - Channel access token and secret
 * @returns LineBotInfo on success, Error on failure
 */
export const validateLineCredentials: (opts: LineValidateOpts) => Promise<Result<LineBotInfo, Error>> =
  createCredentialValidator<LineValidateOpts, LineBotInfo>({
    platform: "LINE",
    validateInputs: (opts) => {
      if (!opts.channelAccessToken.trim()) {
        return "channel access token must not be empty";
      }
      if (!opts.channelSecret.trim()) {
        return "channel secret must not be empty (needed for webhook signature verification)";
      }
      return undefined;
    },
    callApi: async (opts) => {
      const client = new messagingApi.MessagingApiClient({
        channelAccessToken: opts.channelAccessToken,
      });

      const result = await fromPromise(client.getBotInfo());
      if (!result.ok) {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        return err(new Error(`Invalid LINE credentials: ${message}`));
      }

      const botInfo = result.value;
      return ok({
        displayName: botInfo.displayName,
        userId: botInfo.userId,
        basicId: botInfo.basicId,
      });
    },
  });
