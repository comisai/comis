// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Microsoft Teams `Activity` payload builders.
 *
 * Two layers of proof:
 *   1. RUNTIME shape — each builder emits exactly the fields the adapter's
 *      inbound path reads.
 *   2. REAL-MAPPER round-trip — the `message`/media builders are fed through the
 *      adapter's OWN exported `mapMsTeamsActivityToNormalized` (from
 *      `@comis/channels`, resolved from `dist/`) and the resulting
 *      `NormalizedMessage` is asserted. This is the fidelity tripwire: if the
 *      mapper's field reads drift, these fail. (The reaction + card-action
 *      builders round-trip end-to-end through the adapter's `handleWebhookEvents`
 *      in the scenario proof — their mappers are not individually exported.)
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/msteams/msteams-payloads.test.ts
 *
 * @module
 */

import { describe, expect, it, beforeEach } from "vitest";
import { mapMsTeamsActivityToNormalized } from "@comis/channels";
import {
  makeMessageActivity,
  makeReactionActivity,
  makeCardActionInvoke,
  makeMediaActivity,
  nextActivityId,
  resetActivityIdCounter,
  MSTEAMS_CONNECTOR_SERVICE_URL,
  MSTEAMS_TEST_TENANT_ID,
} from "./msteams-payloads.js";

beforeEach(() => {
  resetActivityIdCounter();
});

describe("msteams-payloads — makeMessageActivity (DM text round-trip)", () => {
  it("emits a message activity carrying the allowlisted serviceUrl + tenant + sender", () => {
    const act = makeMessageActivity({
      fromAadObjectId: "aad-user-1",
      conversationId: "a:dm-conv-1",
      text: "hello from the emulator",
    });
    expect(act.type).toBe("message");
    expect(act.text).toBe("hello from the emulator");
    expect(act.conversation.id).toBe("a:dm-conv-1");
    expect(act.conversation.conversationType).toBe("personal");
    expect(act.conversation.tenantId).toBe(MSTEAMS_TEST_TENANT_ID);
    // The serviceUrl MUST be the isSafeServiceUrl-admitted host (unchanged gate).
    expect(act.serviceUrl).toBe(MSTEAMS_CONNECTOR_SERVICE_URL);
    expect(act.serviceUrl).toMatch(/^https:\/\/smba\.trafficmanager\.net\//);
    // channelData.tenant.id is the preferred capture tenant (proactive-send ref).
    expect(act.channelData?.tenant?.id).toBe(MSTEAMS_TEST_TENANT_ID);
    expect(act.from?.aadObjectId).toBe("aad-user-1");
    expect(typeof act.id).toBe("string");
  });

  it("round-trips through the REAL adapter mapper to a NormalizedMessage (senderId = aadObjectId)", () => {
    const act = makeMessageActivity({
      fromAadObjectId: "aad-user-1",
      fromName: "Ada",
      conversationId: "a:dm-conv-1",
      text: "ping",
    });
    const normalized = mapMsTeamsActivityToNormalized(act);
    expect(normalized).not.toBeNull();
    expect(normalized!.channelType).toBe("msteams");
    // The adapter PREFERS aadObjectId as senderId (the allowlist key).
    expect(normalized!.senderId).toBe("aad-user-1");
    expect(normalized!.text).toBe("ping");
    expect(normalized!.channelId).toBe("a:dm-conv-1");
    expect(normalized!.chatType).toBe("dm");
    expect(normalized!.metadata.serviceUrl).toBe(MSTEAMS_CONNECTOR_SERVICE_URL);
  });

  it("mentionBot adds an <at> span + entities so the mapper flags mentionedBot, and text stays faithful", () => {
    const act = makeMessageActivity({
      fromAadObjectId: "aad-user-1",
      conversationId: "a:dm-conv-1",
      text: "do the thing",
      mentionBot: true,
    });
    expect(act.entities?.[0]?.type).toBe("mention");
    // The mention targets the bot recipient id (detectBotMention keys on it).
    expect(act.entities?.[0]?.mentioned?.id).toBe(act.recipient?.id);
    const normalized = mapMsTeamsActivityToNormalized(act);
    // The <at>…</at> span is stripped from the faithful plain text.
    expect(normalized!.text).toBe("do the thing");
    expect(normalized!.metadata.mentionedBot).toBe(true);
  });

  it("threads a channel reply via replyToId (and never threads a DM)", () => {
    const channelAct = makeMessageActivity({
      fromAadObjectId: "aad-user-1",
      conversationId: "19:abc@thread.tacv2",
      conversationType: "channel",
      text: "reply",
      threadRootId: "root-activity-99",
    });
    expect(channelAct.replyToId).toBe("root-activity-99");
    const normalized = mapMsTeamsActivityToNormalized(channelAct);
    expect(normalized!.chatType).toBe("channel");
    expect(normalized!.metadata.replyToId).toBe("root-activity-99");

    // A DM ignores threadRootId — a 1:1 is always top-level (mapper drops it).
    const dmAct = makeMessageActivity({
      fromAadObjectId: "aad-user-1",
      conversationId: "a:dm-conv-1",
      text: "reply",
      threadRootId: "root-activity-99",
    });
    expect(dmAct.replyToId).toBeUndefined();
  });
});

describe("msteams-payloads — makeMediaActivity (attachment round-trip)", () => {
  it("emits attachments the mapper rewrites to the msteams-file:// scheme", () => {
    const act = makeMediaActivity({
      fromAadObjectId: "aad-user-1",
      conversationId: "a:dm-conv-1",
      text: "see attached",
      attachments: [
        {
          contentType: "image/png",
          downloadUrl: "https://sharepoint.example/preauth/file.png",
          name: "file.png",
        },
      ],
    });
    expect(act.attachments?.[0]?.contentType).toBe("image/png");
    // The mapper prefers content.downloadUrl over contentUrl.
    expect(act.attachments?.[0]?.content?.downloadUrl).toBe(
      "https://sharepoint.example/preauth/file.png",
    );
    const normalized = mapMsTeamsActivityToNormalized(act);
    expect(normalized!.attachments).toHaveLength(1);
    expect(normalized!.attachments[0]?.url).toMatch(/^msteams-file:\/\//);
    expect(normalized!.attachments[0]?.fileName).toBe("file.png");
  });
});

describe("msteams-payloads — makeReactionActivity (inbound reaction FLOW)", () => {
  it("emits a messageReaction activity with reactionsAdded + the target as replyToId", () => {
    const act = makeReactionActivity({
      fromAadObjectId: "aad-user-1",
      conversationId: "a:dm-conv-1",
      reactionType: "like",
      targetActivityId: "bot-activity-7",
    });
    expect(act.type).toBe("messageReaction");
    expect(act.reactionsAdded?.[0]?.type).toBe("like");
    // The adapter resolves the reaction target as replyToId ?? id.
    expect(act.replyToId).toBe("bot-activity-7");
    expect(act.from?.aadObjectId).toBe("aad-user-1");
    // A non-message activity maps to null in the message mapper (routed to the reaction path instead).
    expect(mapMsTeamsActivityToNormalized(act)).toBeNull();
  });
});

describe("msteams-payloads — makeCardActionInvoke (Adaptive Card button click)", () => {
  it("emits an adaptiveCard/action invoke carrying the verb + signed callback", () => {
    const act = makeCardActionInvoke({
      fromAadObjectId: "aad-approver-1",
      conversationId: "a:dm-conv-1",
      callback: "signed-cb-blob",
    });
    expect(act.type).toBe("invoke");
    expect(act.name).toBe("adaptiveCard/action");
    expect(act.value?.action?.verb).toBe("comis.approval.resolve");
    expect(act.value?.action?.data?.cb).toBe("signed-cb-blob");
    // The clicker identity is sourced only from the verified from.aadObjectId.
    expect(act.from?.aadObjectId).toBe("aad-approver-1");
  });

  it("supports an arbitrary verb + a missing callback (the drop-path probes)", () => {
    const act = makeCardActionInvoke({
      fromAadObjectId: "aad-approver-1",
      conversationId: "a:dm-conv-1",
      verb: "attacker.arbitrary.verb",
    });
    expect(act.value?.action?.verb).toBe("attacker.arbitrary.verb");
    expect(act.value?.action?.data?.cb).toBeUndefined();
  });
});

describe("msteams-payloads — activity-id source + scope guard", () => {
  it("mints strictly-increasing, path-safe activity ids and resets deterministically", () => {
    resetActivityIdCounter();
    const a = nextActivityId();
    const b = nextActivityId();
    expect(a).toBe("f:1001");
    expect(b).toBe("f:1002");
    // Path-safe: no control chars, no `..` (isSafeConversationId-clean).
    expect(a).not.toMatch(/\.\./);
    resetActivityIdCounter();
    expect(nextActivityId()).toBe("f:1001");
  });

  it("only mints the three in-scope activity kinds (message / messageReaction / invoke)", () => {
    const kinds = new Set(
      [
        makeMessageActivity({ fromAadObjectId: "u", conversationId: "c", text: "t" }).type,
        makeMediaActivity({
          fromAadObjectId: "u",
          conversationId: "c",
          attachments: [{ contentType: "image/png", contentUrl: "https://x/y.png" }],
        }).type,
        makeReactionActivity({
          fromAadObjectId: "u",
          conversationId: "c",
          reactionType: "heart",
          targetActivityId: "t",
        }).type,
        makeCardActionInvoke({ fromAadObjectId: "u", conversationId: "c" }).type,
      ],
    );
    expect([...kinds].sort()).toEqual(["invoke", "message", "messageReaction"]);
  });
});
