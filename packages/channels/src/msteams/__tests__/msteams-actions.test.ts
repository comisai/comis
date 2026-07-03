// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams card-action normalizer tests (the T-2 / T-6 security core).
 *
 * `normalizeCardAction` turns a Bot Framework "adaptiveCard/action" invoke into
 * a button-callback NormalizedMessage — or drops it (returns null). These tests
 * pin the two trust decisions the normalizer owns and nothing more:
 *
 *  - APPROVE-02 (verb-set): a verb outside the CLOSED rendered set never becomes
 *    a message — an attacker cannot invoke a method the bot did not render.
 *  - APPROVE-01 (verified clicker): the sender id is the verified
 *    `from.aadObjectId` of the activity, NEVER the client-controllable
 *    `value.action.data`. A forged `data.userId` is ignored.
 *
 * The default-deny decision on that clicker id and the HMAC/session/replay
 * verification are downstream layers, deliberately NOT exercised here.
 */
import { describe, it, expect } from "vitest";
import type { TeamsActivity } from "../message-mapper.js";
import {
  normalizeCardAction,
  MSTEAMS_APPROVAL_VERB,
  RENDERED_VERBS,
} from "../msteams-actions.js";

/** A neutral, well-formed signed callback wire string (not a real secret). */
const CB = "v1.approve.Abc123Def456.QWERTYuiop123456";

interface InvokeOverrides {
  type?: string;
  name?: string;
  conversationId?: string;
  from?: { id: string; aadObjectId?: string };
  action?: { verb?: string; data?: Record<string, unknown> };
}

/**
 * Build a TeamsActivity-shaped card-action invoke. Every knob defaults to a
 * valid value; passing a key (even set to `undefined`) overrides that slot so a
 * test can express a missing verb / cb / aadObjectId or a forged data field.
 */
function invoke(overrides: InvokeOverrides = {}): TeamsActivity {
  const action =
    "action" in overrides
      ? overrides.action
      : { verb: MSTEAMS_APPROVAL_VERB, data: { cb: CB } };
  return {
    type: "type" in overrides ? overrides.type : "invoke",
    id: "activity-99",
    name: "name" in overrides ? overrides.name : "adaptiveCard/action",
    conversation: {
      id: overrides.conversationId ?? "19:generalchannel@thread.tacv2",
      conversationType: "channel",
    },
    from:
      "from" in overrides
        ? overrides.from
        : { id: "29:bot-conn-id", aadObjectId: "clicker-aad" },
    value: action === undefined ? undefined : { action },
  } as unknown as TeamsActivity;
}

describe("normalizeCardAction — verb-set validation (APPROVE-02)", () => {
  it("drops an invoke whose verb is not in the rendered verb set", () => {
    expect(
      normalizeCardAction(
        invoke({ action: { verb: "attacker.arbitrary.method", data: { cb: CB } } }),
      ),
    ).toBeNull();
  });

  it("drops an invoke that carries no verb at all", () => {
    expect(normalizeCardAction(invoke({ action: { data: { cb: CB } } }))).toBeNull();
  });

  it("exposes the approval verb inside the closed rendered verb set", () => {
    expect(RENDERED_VERBS).toContain(MSTEAMS_APPROVAL_VERB);
    expect(MSTEAMS_APPROVAL_VERB).toBe("comis.approval.resolve");
  });
});

describe("normalizeCardAction — verified clicker identity (APPROVE-01)", () => {
  it("keys the sender on from.aadObjectId of the verified activity", () => {
    const msg = normalizeCardAction(invoke());
    expect(msg).not.toBeNull();
    expect(msg?.senderId).toBe("clicker-aad");
    expect(msg?.metadata.callbackData).toBe(CB);
  });

  it("ignores a forged value.action.data.userId and keeps the verified sender", () => {
    const msg = normalizeCardAction(
      invoke({
        action: { verb: MSTEAMS_APPROVAL_VERB, data: { cb: CB, userId: "attacker-aad" } },
      }),
    );
    expect(msg).not.toBeNull();
    expect(msg?.senderId).toBe("clicker-aad");
  });

  it("drops the invoke when the verified activity has no aadObjectId", () => {
    expect(normalizeCardAction(invoke({ from: { id: "29:bot-conn-id" } }))).toBeNull();
  });
});

describe("normalizeCardAction — button-callback message shape", () => {
  it("marks the message as a button callback carrying the signed callback data", () => {
    const msg = normalizeCardAction(invoke());
    expect(msg?.metadata.isButtonCallback).toBe(true);
    expect(msg?.metadata.callbackData).toBe(CB);
    expect(msg?.text).toBe(CB);
    expect(msg?.channelType).toBe("msteams");
    expect(msg?.metadata.messageId).toBe("activity-99");
  });

  it("strips a ;messageid= reply suffix from the conversation id for channelId", () => {
    const msg = normalizeCardAction(
      invoke({ conversationId: "19:generalchannel@thread.tacv2;messageid=1700000000000" }),
    );
    expect(msg?.channelId).toBe("19:generalchannel@thread.tacv2");
  });

  it("drops the invoke when the signed callback data is missing", () => {
    expect(
      normalizeCardAction(invoke({ action: { verb: MSTEAMS_APPROVAL_VERB, data: {} } })),
    ).toBeNull();
  });
});

describe("normalizeCardAction — only adaptiveCard/action invokes normalize", () => {
  it("drops a non-invoke activity type such as a plain message", () => {
    expect(normalizeCardAction(invoke({ type: "message" }))).toBeNull();
  });

  it("drops an invoke whose name is not the adaptive card action", () => {
    expect(normalizeCardAction(invoke({ name: "task/fetch" }))).toBeNull();
  });
});
