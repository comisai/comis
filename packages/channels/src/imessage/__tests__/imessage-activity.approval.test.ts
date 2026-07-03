// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage plain-text approval-prompt tests (renderer half).
 *
 * iMessage has NO button surface (AppendOnly, send-only, `buttons:"none"`), so a
 * `kind:"approval"` frame appends the plain-text prompt
 * `buildApprovalText(event, { includeShortId })` to the opening status:
 * "Reply approve or deny within the approval timeout" for a single pending
 * approval, and the shortId-disambiguated form when more than one is pending in the
 * same session. NO signed buttons are attached — HMAC is skipped for plaintext
 * prompts; the router's plain-text branch scopes the reply to
 * `pendingForSession` and replay is blocked by pending-table removal.
 *
 * The imessage-fake's send row is `{ op, id, text }` (no buttons field at all), so
 * a text-only assertion proves no button surface is introduced. The prompt copy is
 * fixed + the redacted shortId — never raw user/tool content.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { createIMessageActivityRenderer } from "../imessage-activity.js";
import { createFakeIMessageAdapter } from "../../__tests__/fakes/imessage-fake.js";

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Ims123Abc456",
    expiresAt: 300000,
    choices: [
      { id: "approve", defaultLabel: "Approve", style: "primary" },
      { id: "deny", defaultLabel: "Deny", style: "danger" },
    ],
    ...overrides,
  };
}

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

function frame(events: readonly ActivityEvent[]): ActivityRenderFrame {
  return {
    frameSeq: 0,
    visibleEvents: events,
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

describe("iMessage plain-text approval prompt (no buttons, shortId when ambiguous)", () => {
  it("appends 'Reply approve or deny ...' for a single pending approval (no shortId)", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

    await r.apply(frame([approvalEvent("a-1")]));

    const send = fake.recorded.calls.find((c) => c.op === "send");
    if (send?.op === "send") {
      expect(send.text).toContain("Reply approve or deny within the approval timeout");
      expect(send.text).toContain("approval required: bash");
    }
  });

  it("uses the shortId-disambiguated form when MORE THAN ONE approval is pending", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

    const first = approvalEvent("a-1", approval({ shortId: "Ims111Aaa111" }));
    const second = approvalEvent("a-2", approval({ shortId: "Ims222Bbb222" }));
    await r.apply(frame([first, second]));

    const send = fake.recorded.calls.find((c) => c.op === "send");
    if (send?.op === "send") {
      expect(send.text).toContain("Reply approve Ims111Aaa111 or deny Ims111Aaa111");
      expect(send.text).toContain("Reply approve Ims222Bbb222 or deny Ims222Bbb222");
    }
  });

  it("posts the prompt as TEXT only — the send carries no button surface", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

    await r.apply(frame([approvalEvent("a-1")]));

    const send = fake.recorded.calls.find((c) => c.op === "send");
    // The imessage send row is exactly { op, id, text } — no buttons field.
    expect(send).toEqual({
      op: "send",
      id: "imsg-msg-0",
      text: "approval required: bash\nReply approve or deny within the approval timeout",
    });
    if (send?.op === "send") expect(send.text).not.toMatch(/v1\./);
  });

  it("a non-approval frame appends no prompt (opening status only)", async () => {
    const fake = createFakeIMessageAdapter();
    const r = createIMessageActivityRenderer(fake, "chat-1");

    const plain: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [
        {
          schemaVersion: 1,
          activityId: "a-1",
          sessionKey: "sess-a",
          agentId: "main",
          traceId: "trace-a",
          ts: "2026-05-26T00:00:00.000Z",
          phase: "progress",
          status: "running",
          kind: "tool",
          semanticPhase: "tool",
          defaultLabel: "running tool",
        } as ActivityEvent,
      ],
      groupedActivityIds: {},
      planSnapshot: undefined,
      changeSet: { added: [], edited: [], removed: [] },
    };
    await r.apply(plain);

    const send = fake.recorded.calls.find((c) => c.op === "send");
    // A non-failed tool event renders with the per-step running 🔧 marker
    // (derived by eventLabel); the no-prompt invariant is this test's
    // load-bearing point.
    if (send?.op === "send") expect(send.text).toBe("🔧 running tool");
  });
});
