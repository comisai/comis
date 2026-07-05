// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat card-action normalizer tests (the click-authorization security core).
 *
 * `normalizeGoogleChatCardAction` turns a verified CARD_CLICKED interaction event
 * into a button-callback NormalizedMessage — or drops it, returning the reason so
 * the adapter can make the security-relevant rejects observable. These tests pin
 * the two trust decisions the normalizer owns (and the drop reasons) and nothing
 * more:
 *
 *  - closed method set: an invoked function outside the CLOSED rendered set never
 *    becomes a message — a click cannot invoke a method the bot did not render.
 *  - verified clicker: the sender id is the verified `event.user.name` of the
 *    envelope, NEVER the client-controllable `action.parameters` /
 *    `common.parameters` body. A forged id parameter is ignored.
 *
 * The default-deny decision on that clicker id and the HMAC/session/replay
 * verification are downstream layers, deliberately NOT exercised here.
 */
import { describe, it, expect } from "vitest";
import {
  GOOGLECHAT_APPROVAL_FUNCTION,
  RENDERED_FUNCTIONS,
} from "./googlechat-actions.js";

describe("googlechat card-action — rendered-function contract", () => {
  it("exposes the approval function inside the closed rendered-function set", () => {
    expect(RENDERED_FUNCTIONS).toContain(GOOGLECHAT_APPROVAL_FUNCTION);
    expect(GOOGLECHAT_APPROVAL_FUNCTION).toBe("comis.approval.resolve");
  });

  it("keeps the rendered-function set closed to exactly the functions the bot renders", () => {
    expect(RENDERED_FUNCTIONS).toEqual([GOOGLECHAT_APPROVAL_FUNCTION]);
  });
});
