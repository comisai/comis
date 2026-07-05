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
import { parseMessage } from "@comis/core";
import {
  normalizeGoogleChatCardAction,
  GOOGLECHAT_APPROVAL_FUNCTION,
  RENDERED_FUNCTIONS,
  type GoogleChatCardClickEvent,
} from "./googlechat-actions.js";

/** The verified clicker id off the event envelope (a "users/{id}" resource name). */
const CLICKER = "users/123456789";
/** A neutral, well-formed opaque callback wire string (not a real secret). */
const CB = "v1.approve.Abc123Def456.QWERTYuiop123456";
const SPACE = "spaces/AAAA";
const MSG = "spaces/AAAA/messages/CCCC";

interface ClickOverrides {
  type?: string;
  user?: { name?: string };
  space?: { name?: string };
  message?: { name?: string };
  action?: { actionMethodName?: string; parameters?: Array<{ key?: string; value?: string }> };
  common?: { invokedFunction?: string; parameters?: Record<string, string> };
}

/**
 * Build a verified CARD_CLICKED event. Every knob defaults to a valid value;
 * passing a key (even set to `undefined`) overrides that slot so a test can
 * express a missing type / method / callback / clicker or a forged parameter.
 * The method and callback are seeded in BOTH the classic `action` object and the
 * newer `common` object so a test can drop either location independently.
 */
function clickEvent(overrides: ClickOverrides = {}): GoogleChatCardClickEvent {
  return {
    type: "type" in overrides ? overrides.type : "CARD_CLICKED",
    user: "user" in overrides ? overrides.user : { name: CLICKER },
    space: "space" in overrides ? overrides.space : { name: SPACE },
    message: "message" in overrides ? overrides.message : { name: MSG },
    action:
      "action" in overrides
        ? overrides.action
        : { actionMethodName: GOOGLECHAT_APPROVAL_FUNCTION, parameters: [{ key: "cb", value: CB }] },
    common:
      "common" in overrides
        ? overrides.common
        : { invokedFunction: GOOGLECHAT_APPROVAL_FUNCTION, parameters: { cb: CB } },
  };
}

describe("googlechat card-action — rendered-function contract", () => {
  it("exposes the approval function inside the closed rendered-function set", () => {
    expect(RENDERED_FUNCTIONS).toContain(GOOGLECHAT_APPROVAL_FUNCTION);
    expect(GOOGLECHAT_APPROVAL_FUNCTION).toBe("comis.approval.resolve");
  });

  it("keeps the rendered-function set closed to exactly the functions the bot renders", () => {
    expect(RENDERED_FUNCTIONS).toEqual([GOOGLECHAT_APPROVAL_FUNCTION]);
  });
});

describe("normalizeGoogleChatCardAction — only CARD_CLICKED events normalize", () => {
  it("drops a non-CARD_CLICKED event such as a plain message as a benign ignored drop", () => {
    const result = normalizeGoogleChatCardAction(clickEvent({ type: "MESSAGE" }));
    expect(result.message).toBeNull();
    expect(result.reason).toBe("ignored");
  });

  it("drops an event carrying no type as a benign ignored drop", () => {
    const result = normalizeGoogleChatCardAction(clickEvent({ type: undefined }));
    expect(result.message).toBeNull();
    expect(result.reason).toBe("ignored");
  });
});

describe("normalizeGoogleChatCardAction — closed rendered-method set", () => {
  it("drops a click whose invoked method is outside the rendered set", () => {
    const result = normalizeGoogleChatCardAction(
      clickEvent({
        action: {
          actionMethodName: "attacker.arbitrary.method",
          parameters: [{ key: "cb", value: CB }],
        },
        common: { invokedFunction: "attacker.arbitrary.method", parameters: { cb: CB } },
      }),
    );
    expect(result.message).toBeNull();
    expect(result.reason).toBe("unrendered-method");
  });

  it("drops a click that names no method at all in either location", () => {
    const result = normalizeGoogleChatCardAction(
      clickEvent({
        action: { parameters: [{ key: "cb", value: CB }] },
        common: { parameters: { cb: CB } },
      }),
    );
    expect(result.message).toBeNull();
    expect(result.reason).toBe("unrendered-method");
  });
});

describe("normalizeGoogleChatCardAction — verified clicker identity", () => {
  it("keys the sender on the verified event.user.name", () => {
    const { message } = normalizeGoogleChatCardAction(clickEvent());
    expect(message).not.toBeNull();
    expect(message?.senderId).toBe(CLICKER);
    expect(message?.metadata.callbackData).toBe(CB);
  });

  it("ignores a forged clicker id in action.parameters and keeps the verified sender", () => {
    const { message } = normalizeGoogleChatCardAction(
      clickEvent({
        action: {
          actionMethodName: GOOGLECHAT_APPROVAL_FUNCTION,
          parameters: [
            { key: "cb", value: CB },
            { key: "userId", value: "users/attacker" },
          ],
        },
      }),
    );
    expect(message).not.toBeNull();
    expect(message?.senderId).toBe(CLICKER);
  });

  it("drops the click with a missing-clicker reason when user.name is absent", () => {
    const result = normalizeGoogleChatCardAction(clickEvent({ user: undefined }));
    expect(result.message).toBeNull();
    expect(result.reason).toBe("missing-clicker");
  });

  it("drops the click with a missing-clicker reason when user.name is empty", () => {
    const result = normalizeGoogleChatCardAction(clickEvent({ user: { name: "" } }));
    expect(result.message).toBeNull();
    expect(result.reason).toBe("missing-clicker");
  });
});

describe("normalizeGoogleChatCardAction — dual-location field reads", () => {
  it("reads the method from common.invokedFunction when action.actionMethodName is absent", () => {
    const { message } = normalizeGoogleChatCardAction(
      clickEvent({ action: { parameters: [{ key: "cb", value: CB }] } }),
    );
    expect(message).not.toBeNull();
    expect(message?.senderId).toBe(CLICKER);
  });

  it("reads the callback from common.parameters.cb when action.parameters is absent", () => {
    const { message } = normalizeGoogleChatCardAction(
      clickEvent({ action: { actionMethodName: GOOGLECHAT_APPROVAL_FUNCTION } }),
    );
    expect(message).not.toBeNull();
    expect(message?.text).toBe(CB);
    expect(message?.metadata.callbackData).toBe(CB);
  });
});

describe("normalizeGoogleChatCardAction — malformed callback", () => {
  it("drops the click with a missing-callback reason when no callback parameter is present", () => {
    const result = normalizeGoogleChatCardAction(
      clickEvent({
        action: { actionMethodName: GOOGLECHAT_APPROVAL_FUNCTION },
        common: { invokedFunction: GOOGLECHAT_APPROVAL_FUNCTION },
      }),
    );
    expect(result.message).toBeNull();
    expect(result.reason).toBe("missing-callback");
  });
});

describe("normalizeGoogleChatCardAction — button-callback message shape", () => {
  it("produces a schema-valid button-callback message for a rendered click", () => {
    const { message } = normalizeGoogleChatCardAction(clickEvent());
    expect(message).not.toBeNull();
    expect(message?.channelType).toBe("googlechat");
    expect(message?.channelId).toBe(SPACE);
    expect(message?.senderId).toBe(CLICKER);
    expect(message?.text).toBe(CB);
    expect(message?.metadata.isButtonCallback).toBe(true);
    expect(message?.metadata.callbackData).toBe(CB);
    expect(message?.metadata.googlechatMessageName).toBe(MSG);
    // Ground truth: the produced message satisfies the shared NormalizedMessage schema.
    expect(parseMessage(message).ok).toBe(true);
  });

  it("falls back to the sentinel space when the event carries no space name", () => {
    const { message } = normalizeGoogleChatCardAction(clickEvent({ space: undefined }));
    expect(message?.channelId).toBe("spaces/unknown");
  });

  it("omits googlechatMessageName when the event carries no clicked-message name", () => {
    const { message } = normalizeGoogleChatCardAction(clickEvent({ message: undefined }));
    expect(message).not.toBeNull();
    expect(message?.metadata.googlechatMessageName).toBeUndefined();
  });
});
