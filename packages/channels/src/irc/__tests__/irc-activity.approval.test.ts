// SPDX-License-Identifier: Apache-2.0
/**
 * IRC plain-text approval-prompt tests (renderer half).
 *
 * IRC has no button surface (LinePerEvent, text-only), so a `kind:"approval"`
 * event renders the plain-text prompt `buildApprovalText(event, { includeShortId })`
 * as its per-event line: "Reply approve or deny within the approval timeout" when a
 * single approval is pending in the frame, and the shortId-disambiguated form
 * "Reply approve <S> or deny <S>" when more than one is pending in the same session
 * (so the user's reply, parsed by the router's plain-text branch, is
 * unambiguous). NO signed buttons appear — HMAC is skipped for plaintext prompts;
 * the router scopes the reply to `pendingForSession` and replay is blocked by
 * pending-table removal.
 *
 * The prompt copy is fixed + the redacted shortId — never raw user/tool content.
 * The renderer reuses the `buildApprovalText` via the
 * shared `buildApprovalPrompt`; it does NOT re-derive the wire format and signs
 * nothing.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createIrcActivityRenderer } from "../irc-activity.js";
import { createFakeIrcAdapter } from "../../__tests__/fakes/irc-fake.js";

/** A redacted approval correlation (the renderer reads only these fields). */
function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Irc123Abc456",
    expiresAt: 300000,
    choices: [
      { id: "approve", defaultLabel: "Approve", style: "primary" },
      { id: "deny", defaultLabel: "Deny", style: "danger" },
    ],
    ...overrides,
  };
}

/** One `kind:"approval"` event with an explicit activityId (so it can be in `added`). */
function approvalEvent(id: string, corr: ApprovalCorrelation = approval()): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: id,
    sessionKey: "sess-a",
    agentId: "main",
    traceId: "trace-a",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "progress",
    status: "running",
    kind: "approval",
    semanticPhase: "tool",
    defaultLabel: "approval required: bash",
    approval: corr,
  } as ActivityEvent;
}

/** Frame whose `changeSet.added` names every event id (so LinePerEvent emits a line per event). */
function frame(events: readonly ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: events.map((e) => e.activityId), edited: [], removed: [] },
  };
}

describe("IRC plain-text approval prompt (no buttons, shortId when ambiguous)", () => {
  it("renders 'Reply approve or deny ...' for a single pending approval (no shortId)", async () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });

    await r.apply(frame([approvalEvent("a-1")]));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    if (sends[0].op === "send") {
      expect(sends[0].text).toBe("Reply approve or deny within the approval timeout");
    }
  });

  it("renders the shortId-disambiguated form when MORE THAN ONE approval is pending", async () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });

    const first = approvalEvent("a-1", approval({ shortId: "Irc111Aaa111" }));
    const second = approvalEvent("a-2", approval({ shortId: "Irc222Bbb222" }));
    await r.apply(frame([first, second]));

    const sends = fake.recorded.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(2);
    if (sends[0].op === "send") expect(sends[0].text).toBe("Reply approve Irc111Aaa111 or deny Irc111Aaa111");
    if (sends[1].op === "send") expect(sends[1].text).toBe("Reply approve Irc222Bbb222 or deny Irc222Bbb222");
  });

  it("renders the prompt as TEXT only — no buttons reach the IRC send (HMAC skipped for plaintext)", async () => {
    const clock = createFakeClock(0);
    const fake = createFakeIrcAdapter();
    const r = createIrcActivityRenderer(fake, "chan-1", { clock });

    await r.apply(frame([approvalEvent("a-1")]));

    const send = fake.recorded.calls.find((c) => c.op === "send");
    // The fake's send row is `{ op, id, text }` — there is no buttons field at all.
    expect(send).toEqual({ op: "send", id: "irc-msg-0", text: "Reply approve or deny within the approval timeout" });
    // No callback_data / signed wire string leaks into the plain-text line.
    if (send?.op === "send") expect(send.text).not.toMatch(/v1\./);
  });
});
