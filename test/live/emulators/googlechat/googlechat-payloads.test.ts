// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Google Chat interaction-event payload builders.
 *
 * Two layers of proof:
 *   1. RUNTIME shape — each builder emits exactly the fields the adapter's
 *      inbound path reads.
 *   2. REAL-MAPPER round-trip — the message/attachment builders are fed through
 *      the adapter's OWN exported `mapGoogleChatEventToNormalized` (from
 *      `@comis/channels`, resolved from `dist/`) and the resulting
 *      `NormalizedMessage` is asserted. This is the fidelity tripwire: if the
 *      mapper's field reads drift, these fail. (The CARD_CLICKED builder
 *      round-trips end-to-end through the adapter's `handleChatEvent` in the
 *      scenario proof — its normalizer is not individually exported, so here we
 *      assert its wire shape + that the message mapper returns null for it, the
 *      way the adapter routes a click to the card-action path.)
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/googlechat/googlechat-payloads.test.ts
 *
 * @module
 */

import { describe, expect, it, beforeEach } from "vitest";
import { mapGoogleChatEventToNormalized } from "@comis/channels";
import {
  makeMessageEvent,
  makeCardClickedEvent,
  makeAttachmentEvent,
  nextEventId,
  resetEventIdCounter,
  GOOGLECHAT_APPROVAL_FUNCTION,
} from "./googlechat-payloads.js";

beforeEach(() => {
  resetEventIdCounter();
});

describe("googlechat-payloads — makeMessageEvent (space text round-trip)", () => {
  it("emits a MESSAGE event carrying the space, immutable sender, and text", () => {
    const event = makeMessageEvent("hello from the emulator", {
      space: "spaces/AAAA",
      user: "users/123",
    });
    expect(event.type).toBe("MESSAGE");
    expect(event.space?.name).toBe("spaces/AAAA");
    expect(event.message?.sender?.name).toBe("users/123");
    // argumentText is the mention-stripped text the mapper prefers over text.
    expect(event.message?.argumentText ?? event.message?.text).toBe(
      "hello from the emulator",
    );
    // The stable message resource name (the pull-loop dedup key) is present.
    expect(typeof event.message?.name).toBe("string");
    expect(event.message?.name).toMatch(/^spaces\/AAAA\/messages\//);
  });

  it("round-trips through the REAL adapter mapper to a NormalizedMessage (senderId = users/{id})", () => {
    const event = makeMessageEvent("ping", {
      space: "spaces/AAAA",
      user: "users/123",
    });
    const normalized = mapGoogleChatEventToNormalized(event);
    expect(normalized).not.toBeNull();
    expect(normalized!.channelType).toBe("googlechat");
    // The adapter keys the allowlist on the immutable users/{id} resource name.
    expect(normalized!.senderId).toBe("users/123");
    expect(normalized!.text).toBe("ping");
    expect(normalized!.channelId).toBe("spaces/AAAA");
    // A default SPACE spaceType maps to a "group" chat; the emulator can flip it.
    expect(normalized!.chatType).toBe("group");
  });

  it("maps a DIRECT_MESSAGE spaceType to a dm chatType", () => {
    const event = makeMessageEvent("hi", {
      space: "spaces/DM",
      user: "users/9",
      spaceType: "DIRECT_MESSAGE",
    });
    const normalized = mapGoogleChatEventToNormalized(event);
    expect(normalized!.chatType).toBe("dm");
    expect(normalized!.metadata.isGroup).toBe(false);
  });

  it("threads a reply via thread.name and flags a mention via a USER_MENTION annotation", () => {
    const event = makeMessageEvent("do the thing", {
      space: "spaces/AAAA",
      user: "users/123",
      thread: "spaces/AAAA/threads/T1",
      mentioned: true,
    });
    expect(event.message?.thread?.name).toBe("spaces/AAAA/threads/T1");
    const normalized = mapGoogleChatEventToNormalized(event);
    // The generic threadId key drives inbound→outbound thread propagation.
    expect(normalized!.metadata.threadId).toBe("spaces/AAAA/threads/T1");
    expect(normalized!.metadata.wasMentioned).toBe(true);
  });
});

describe("googlechat-payloads — makeAttachmentEvent (attachment round-trip)", () => {
  it("emits an attachment with an attachmentDataRef the mapper rewrites to googlechat-attachment://", () => {
    const event = makeAttachmentEvent({
      space: "spaces/AAAA",
      user: "users/123",
      resourceName: "spaces/AAAA/messages/CCC/attachments/D1",
      contentType: "image/png",
      contentName: "photo.png",
    });
    expect(event.message?.attachment?.[0]?.attachmentDataRef?.resourceName).toBe(
      "spaces/AAAA/messages/CCC/attachments/D1",
    );
    const normalized = mapGoogleChatEventToNormalized(event);
    expect(normalized!.attachments).toHaveLength(1);
    expect(normalized!.attachments[0]?.url).toMatch(/^googlechat-attachment:\/\//);
    expect(normalized!.attachments[0]?.fileName).toBe("photo.png");
  });
});

describe("googlechat-payloads — makeCardClickedEvent (Cards v2 button click)", () => {
  it("emits a CARD_CLICKED event carrying the invoked function, opaque callback, and verified clicker", () => {
    const event = makeCardClickedEvent({
      space: "spaces/AAAA",
      user: "users/approver",
      callback: "signed-cb-blob",
    });
    expect(event.type).toBe("CARD_CLICKED");
    // The invoked function defaults to the rendered approval verb.
    expect(event.common?.invokedFunction ?? event.action?.actionMethodName).toBe(
      GOOGLECHAT_APPROVAL_FUNCTION,
    );
    // The opaque callback rides both the classic and the newer payload shapes.
    expect(event.common?.parameters?.cb).toBe("signed-cb-blob");
    // The clicker identity is the verified user.name (never a parameter).
    expect(event.user?.name).toBe("users/approver");
    // A CARD_CLICKED is NOT a MESSAGE — the message mapper returns null and the
    // adapter routes it to the card-action normalizer instead.
    expect(
      mapGoogleChatEventToNormalized(event as unknown as Parameters<typeof mapGoogleChatEventToNormalized>[0]),
    ).toBeNull();
  });

  it("supports an arbitrary invoked function + a missing callback (the drop-path probes)", () => {
    const event = makeCardClickedEvent({
      space: "spaces/AAAA",
      user: "users/approver",
      invokedFunction: "attacker.arbitrary.method",
      callback: undefined,
    });
    expect(event.common?.invokedFunction).toBe("attacker.arbitrary.method");
    expect(event.common?.parameters?.cb).toBeUndefined();
  });
});

describe("googlechat-payloads — event-id source + scope guard", () => {
  it("mints strictly-increasing event ids and resets deterministically", () => {
    resetEventIdCounter();
    const a = nextEventId();
    const b = nextEventId();
    expect(a).toBe(1001);
    expect(b).toBe(1002);
    resetEventIdCounter();
    expect(nextEventId()).toBe(1001);
  });

  it("only mints the two in-scope event kinds (MESSAGE / CARD_CLICKED)", () => {
    const kinds = new Set([
      makeMessageEvent("t", { space: "spaces/A", user: "users/1" }).type,
      makeAttachmentEvent({
        space: "spaces/A",
        user: "users/1",
        resourceName: "spaces/A/messages/C/attachments/D",
      }).type,
      makeCardClickedEvent({ space: "spaces/A", user: "users/1" }).type,
    ]);
    expect([...kinds].sort()).toEqual(["CARD_CLICKED", "MESSAGE"]);
  });
});
