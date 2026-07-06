// SPDX-License-Identifier: Apache-2.0
/**
 * Unit test for {@link createFakeGoogleChatAdapter} — the deterministic Google
 * Chat `ChannelPort` double.
 *
 * Pins the contract the fixtures + activity tests rely on: monotonic `gchat-msg-N`
 * ids, the connectionMode-per-mode status ("polling" for the Pub/Sub-pull default,
 * "webhook" for webhook mode), a one-shot `nextError` seam that surfaces a
 * Chat-API-shaped `{ status, retryAfter }` failure through the `Result` err branch
 * exactly once, and the HONEST omission of the false-capability methods (no
 * reactions, no outbound uploads, no history) so a false-flag call has nothing to
 * hit. No `systemNowMs()` — the double is clock-free so fixtures never flap.
 */
import { describe, it, expect } from "vitest";
import {
  createFakeGoogleChatAdapter,
  type GoogleChatErrorShape,
} from "./googlechat-fake.js";
import type { RichButton } from "@comis/core";

describe("createFakeGoogleChatAdapter", () => {
  it("mints monotonic gchat-msg-N ids and records the send in order", async () => {
    const { port, recorded } = createFakeGoogleChatAdapter();
    const r0 = await port.sendMessage("spaces/AAAA", "hello");
    const r1 = await port.sendMessage("spaces/AAAA", "world");
    expect(r0).toEqual({ ok: true, value: "gchat-msg-0" });
    expect(r1).toEqual({ ok: true, value: "gchat-msg-1" });
    expect(recorded.calls).toEqual([
      { op: "send", id: "gchat-msg-0", text: "hello" },
      { op: "send", id: "gchat-msg-1", text: "world" },
    ]);
  });

  it("records buttons on send ONLY when present (button-less frames stay byte-stable)", async () => {
    const { port, recorded } = createFakeGoogleChatAdapter();
    const buttons: RichButton[][] = [[{ text: "Approve", callback_data: "cb" }]];
    await port.sendMessage("spaces/AAAA", "plain");
    await port.sendMessage("spaces/AAAA", "with-buttons", { buttons });
    expect(recorded.calls[0]).toEqual({ op: "send", id: "gchat-msg-0", text: "plain" });
    expect(recorded.calls[1]).toEqual({
      op: "send",
      id: "gchat-msg-1",
      text: "with-buttons",
      buttons,
    });
  });

  it("reports channelType googlechat and connectionMode polling by default (Pub/Sub pull)", () => {
    const { port } = createFakeGoogleChatAdapter();
    expect(port.channelType).toBe("googlechat");
    const status = port.getStatus?.();
    expect(status?.channelType).toBe("googlechat");
    expect(status?.connected).toBe(true);
    expect(status?.connectionMode).toBe("polling");
  });

  it("reports connectionMode webhook in webhook mode", () => {
    const { port } = createFakeGoogleChatAdapter({ mode: "webhook" });
    expect(port.getStatus?.().connectionMode).toBe("webhook");
  });

  it("nextError fails the next call ONCE with a {status, retryAfter} error, then clears", async () => {
    const { port, nextError } = createFakeGoogleChatAdapter();
    nextError({ status: 429, retryAfter: 2 });
    const failed = await port.sendMessage("spaces/AAAA", "will-fail");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      const e = failed.error as GoogleChatErrorShape & Error;
      expect(e.status).toBe(429);
      expect(e.retryAfter).toBe(2);
    }
    // The seam is one-shot: the next send succeeds AND is the first recorded id
    // (the failed call never recorded).
    const recovered = await port.sendMessage("spaces/AAAA", "recovers");
    expect(recovered).toEqual({ ok: true, value: "gchat-msg-0" });
  });

  it("records edit and delete; both honor the one-shot error seam", async () => {
    const { port, recorded, nextError } = createFakeGoogleChatAdapter();
    const send = await port.sendMessage("spaces/AAAA", "orig");
    const id = send.ok ? send.value : "";
    const edited = await port.editMessage?.("spaces/AAAA", id, "edited");
    expect(edited).toEqual({ ok: true, value: undefined });
    nextError({ status: 500 });
    const delFailed = await port.deleteMessage?.("spaces/AAAA", id);
    expect(delFailed?.ok).toBe(false);
    // The failed delete consumed the seam and did NOT record; the retry lands.
    const delOk = await port.deleteMessage?.("spaces/AAAA", id);
    expect(delOk).toEqual({ ok: true, value: undefined });
    expect(recorded.calls).toEqual([
      { op: "send", id: "gchat-msg-0", text: "orig" },
      { op: "edit", id: "gchat-msg-0", text: "edited" },
      { op: "delete", id: "gchat-msg-0" },
    ]);
  });

  it("start/stop/platformAction return ok without touching the call log", async () => {
    const { port, recorded } = createFakeGoogleChatAdapter();
    expect(await port.start()).toEqual({ ok: true, value: undefined });
    expect(await port.stop()).toEqual({ ok: true, value: undefined });
    const acted = await port.platformAction("noop", { a: 1 });
    expect(acted.ok).toBe(true);
    expect(recorded.calls).toEqual([]);
  });

  it("OMITS the honest-false capability methods (no reactions / uploads / history)", () => {
    const { port } = createFakeGoogleChatAdapter();
    // Reactions, outbound upload, and history are unreachable for a service-account
    // app — the methods are omitted (an honest gap), not stubbed.
    expect(port.reactToMessage).toBeUndefined();
    expect(port.removeReaction).toBeUndefined();
    expect(port.onReaction).toBeUndefined();
    expect(port.sendAttachment).toBeUndefined();
    expect(port.fetchMessages).toBeUndefined();
  });
});
