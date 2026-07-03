// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp plain-text approval-prompt tests (renderer half).
 *
 * WhatsApp has NO button surface (`buttons:"none"`), so a `kind:"approval"` frame
 * appends the plain-text prompt `buildApprovalText(event, { includeShortId })` to
 * the placeholder text: "Reply approve or deny within the approval timeout" for a
 * single pending approval, and the shortId-disambiguated form when more than one is
 * pending in the same session. NO signed buttons are attached — HMAC is skipped for
 * plaintext; the router's plain-text branch scopes the reply to
 * `pendingForSession` and replay is blocked by pending-table removal.
 *
 * The fake records `buttons:boolean` on `send` so we can prove `buttons:"none"`.
 * The prompt copy is fixed + the redacted shortId — never raw user/tool content.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createWhatsAppActivityRenderer } from "../whatsapp-activity.js";
import { createFakeWhatsAppAdapter } from "../../__tests__/fakes/whatsapp-fake.js";
import type { FakeWhatsAppCall } from "../../__tests__/fakes/whatsapp-fake.js";

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Wha123Abc456",
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

function firstSend(fake: ReturnType<typeof createFakeWhatsAppAdapter>): Extract<FakeWhatsAppCall, { op: "send" }> | undefined {
  return fake.recorded.calls.find((c): c is Extract<FakeWhatsAppCall, { op: "send" }> => c.op === "send");
}

describe("WhatsApp plain-text approval prompt (buttons:none, shortId when ambiguous)", () => {
  it("appends 'Reply approve or deny ...' for a single pending approval (no shortId)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeWhatsAppAdapter();
    const r = createWhatsAppActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(frame([approvalEvent("a-1")]));

    const send = firstSend(fake);
    expect(send?.text).toContain("Reply approve or deny within the approval timeout");
    expect(send?.text).toContain("approval required: bash");
  });

  it("uses the shortId-disambiguated form when MORE THAN ONE approval is pending", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeWhatsAppAdapter();
    const r = createWhatsAppActivityRenderer(fake, "chat-1", { timer, clock });

    const first = approvalEvent("a-1", approval({ shortId: "Wha111Aaa111" }));
    const second = approvalEvent("a-2", approval({ shortId: "Wha222Bbb222" }));
    await r.apply(frame([first, second]));

    const send = firstSend(fake);
    expect(send?.text).toContain("Reply approve Wha111Aaa111 or deny Wha111Aaa111");
    expect(send?.text).toContain("Reply approve Wha222Bbb222 or deny Wha222Bbb222");
    expect(send?.text).not.toContain("within the approval timeout");
  });

  it("attaches NO buttons — the prompt is plain text (HMAC skipped for plaintext)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeWhatsAppAdapter();
    const r = createWhatsAppActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(frame([approvalEvent("a-1")]));

    const send = firstSend(fake);
    expect(send?.buttons).toBe(false);
    expect(send?.text).not.toMatch(/v1\./);
  });

  it("a non-approval frame appends no prompt (byte-stable placeholder, buttons:none)", async () => {
    const timer = createFakeTimers();
    const fake = createFakeWhatsAppAdapter();
    // Drop the clock so the "(running N s)" elapsed fallback is skipped — the test asserts
    // the bare "running tool" placeholder byte-stably (no `(running 0 s)` suffix).
    const r = createWhatsAppActivityRenderer(fake, "chat-1", { timer });

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

    const send = firstSend(fake);
    // [Rule 1 — bug fix, quick-260528-nsv] Non-approval tool event renders
    // with the per-step running 🔧 marker; the byte-stable-placeholder /
    // no-buttons invariant (this test's load-bearing point) is unchanged.
    expect(send?.text).toBe("🔧 running tool");
    expect(send?.buttons).toBe(false);
  });
});
