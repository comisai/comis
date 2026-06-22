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
import { classifiedValidationErr } from "../shared/credential-validation-error.js";

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
  /**
   * Optional Messaging API base URL override. Production: undefined
   * (SDK uses api.line.me). E2E tests: 127.0.0.1 mock URL.
   */
  apiRoot?: string;
}

/**
 * Validate LINE credentials by calling the getBotInfo() API.
 *
 * Creates a MessagingApiClient with the provided token, calls getBotInfo(),
 * and returns bot identity on success. Also validates that the channel secret
 * is non-empty (needed for webhook signature verification).
 *
 * @param opts - Channel access token, secret, and optional apiRoot override
 * @returns LineBotInfo on success, Error on failure
 */
export async function validateLineCredentials(
  opts: LineValidateOpts,
): Promise<Result<LineBotInfo, Error>> {
  if (!opts.channelAccessToken.trim()) {
    return err(new Error("Invalid LINE credentials: channel access token must not be empty"));
  }
  if (!opts.channelSecret.trim()) {
    return err(
      new Error(
        "Invalid LINE credentials: channel secret must not be empty (needed for webhook signature verification)",
      ),
    );
  }

  // E2E seam: when caller passes apiRoot, the LINE SDK client targets the
  // override URL. Production omits the baseURL key so the SDK uses its
  // default.
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: opts.channelAccessToken,
    ...(opts.apiRoot ? { baseURL: opts.apiRoot } : {}),
  });

  // Transport note: @line/bot-sdk v10 MessagingApiClient uses the global fetch
  // (HTTPFetchClient), so LINE API traffic already routes through the installed
  // undici proxy dispatcher — no explicit agent needed (unlike grammy/axios
  // SDKs). We still classify the failure so a reachability problem (proxy down,
  // api.line.me blocked) is reported as network, not as a bad credential.
  const result = await fromPromise(client.getBotInfo());
  if (!result.ok) {
    return classifiedValidationErr(
      result.error,
      "Invalid LINE credentials",
      "LINE getBotInfo() unreachable (network/proxy)",
    );
  }

  const botInfo = result.value;
  return ok({
    displayName: botInfo.displayName,
    userId: botInfo.userId,
    basicId: botInfo.basicId,
  });
}
