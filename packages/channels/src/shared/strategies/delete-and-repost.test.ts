// SPDX-License-Identifier: Apache-2.0
/**
 * DeleteAndRepost strategy tests (STRAT-05, §7.3 row "DeleteAndRepost").
 *
 * Used by Signal (no edit, has delete). Each render transition deletes the
 * previous activity message and posts a new one. On success the last activity
 * message is deleted after the answer lands; on failure the final ❌ message is
 * KEPT (the diagnostic trail — T-70-07-02).
 */
import { describe, it, expect } from "vitest";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
import type {
  ActivityRenderFrame,
  ActivityEvent,
  TurnOutcome,
  FinalDeliveryReceipt,
  ActivityRenderError,
} from "@comis/core";
import { createDeleteAndRepostRenderer } from "./delete-and-repost.js";
import type { ActivityRenderActions } from "./actions.js";

type Call =
  | { op: "send"; text: string; id: string }
  | { op: "delete"; id: string };

function makeRecordingActions(): { actions: ActivityRenderActions; calls: Call[] } {
  const calls: Call[] = [];
  let seq = 0;
  const actions: ActivityRenderActions = {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      const id = `msg-${seq++}`;
      calls.push({ op: "send", text, id });
      return ok(id);
    },
    async edit(): Promise<Result<void, ActivityRenderError>> {
      // DeleteAndRepost never edits.
      return ok(undefined);
    },
    async delete(id): Promise<Result<void, ActivityRenderError>> {
      calls.push({ op: "delete", id });
      return ok(undefined);
    },
  };
  return { actions, calls };
}

function makeEvent(label: string): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "s",
    agentId: "main",
    traceId: "t",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    defaultLabel: label,
  } as ActivityEvent;
}

function makeFrame(frameSeq: number, label: string): ActivityRenderFrame {
  return {
    frameSeq,
    visibleEvents: [makeEvent(label)],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

const RECEIPT: FinalDeliveryReceipt = {
  ok: true, deliveredChunks: 1, lastChunkMessageId: "final", deliveredAtMs: 0,
};

describe("createDeleteAndRepostRenderer", () => {
  it("reports a DeleteAndRepost identity that can delete but not edit", () => {
    const { actions } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });
    expect(r.strategy).toBe("DeleteAndRepost");
    expect(r.canDelete).toBe(true);
    expect(r.canEdit).toBe(false);
  });

  it("deletes the previous activity message and posts a new one on each transition", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1")); // first: send only, nothing to delete
    await r.apply(makeFrame(1, "step 2")); // delete prev (msg-0) + send msg-1
    await r.apply(makeFrame(2, "step 3")); // delete prev (msg-1) + send msg-2

    expect(calls).toEqual([
      { op: "send", text: "step 1", id: "msg-0" },
      { op: "delete", id: "msg-0" },
      { op: "send", text: "step 2", id: "msg-1" },
      { op: "delete", id: "msg-1" },
      { op: "send", text: "step 3", id: "msg-2" },
    ]);
  });

  it("on success deletes the last activity message after the answer lands", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    const success: TurnOutcome = { kind: "success", trivial: false, delivery: RECEIPT };
    await r.finalize(success);

    // The last activity message (msg-0) is deleted; nothing is kept.
    expect(calls.filter((c) => c.op === "delete").map((c) => c.id)).toEqual(["msg-0"]);
  });

  it("on failure deletes the running activity and posts a final ❌ message that is KEPT", async () => {
    const { actions, calls } = makeRecordingActions();
    const r = createDeleteAndRepostRenderer({ actions });

    await r.apply(makeFrame(0, "step 1"));
    const failure: TurnOutcome = {
      kind: "failure",
      errorKind: "dependency",
      failedEvents: [makeEvent("boom")],
    };
    await r.finalize(failure);

    // The final ❌ message exists and is the LAST send; it is never deleted.
    const sends = calls.filter((c): c is Extract<Call, { op: "send" }> => c.op === "send");
    const lastSend = sends[sends.length - 1];
    expect(lastSend.text).toContain("❌");
    expect(lastSend.text).toContain("dependency");
    // The ❌ message id is NOT among the deletes (kept for diagnosis).
    const deletedIds = calls.filter((c) => c.op === "delete").map((c) => c.id);
    expect(deletedIds).not.toContain(lastSend.id);
  });
});
