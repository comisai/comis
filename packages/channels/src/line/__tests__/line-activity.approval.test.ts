// SPDX-License-Identifier: Apache-2.0
/**
 * LINE Quick-Reply approval-chip tests.
 *
 * A `kind:"approval"` frame causes LINE's send-only AppendOnly renderer to carry
 * Quick-Reply chips (the `buttons` param) whose callback data is the signed
 * wire string `v1.<choice>.<shortId>.<hmac>` (LINE Quick-Reply postback carries the
 * signed callback). The chips are built via `buildApprovalButtons(event,
 * signCallbackData)` over the renderer-injected `SignCallbackData`; the renderer
 * reaches the core HMAC primitive through it and never imports `@comis/orchestrator`.
 *
 * The frame stays redacted — chip labels/styles come from the choice hints, never
 * raw params. A non-approval frame stays send-only (no chips), preserving plain
 * AppendOnly behavior.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createLineActivityRenderer } from "../line-activity.js";
import { createFakeLineAdapter } from "../../__tests__/fakes/line-fake.js";
import type { FakeLineCall } from "../../__tests__/fakes/line-fake.js";

/** Fixed secret → deterministic 16-char base64url HMAC tag for the assertions. */
const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

/** The signed-callback wire shape: `v1.<choice>.<12 base62>.<16 base64url>`. */
const WIRE = /^v1\.(approve|deny)\.[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{16}$/;

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Lne789Abc012",
    expiresAt: 300000,
    choices: [
      { id: "approve", defaultLabel: "Approve", style: "primary" },
      { id: "deny", defaultLabel: "Deny", style: "danger" },
    ],
    ...overrides,
  };
}

function approvalFrame(corr: ApprovalCorrelation = approval()): ActivityRenderFrame {
  const event: ActivityEvent = {
    schemaVersion: 1,
    activityId: "00000000-0000-0000-0000-000000000000",
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
  return {
    frameSeq: 0,
    visibleEvents: [event],
    groupedActivityIds: {},
    planSnapshot: undefined,
    changeSet: { added: [], edited: [], removed: [] },
  };
}

function firstSend(fake: ReturnType<typeof createFakeLineAdapter>): Extract<FakeLineCall, { op: "send" }> | undefined {
  return fake.recorded.calls.find((c): c is Extract<FakeLineCall, { op: "send" }> => c.op === "send");
}

describe("LINE Quick-Reply approval chips (signed callback data)", () => {
  it("paints a kind:'approval' frame's send with Quick-Reply chips whose callback_data is the signed wire string", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1", { signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = firstSend(fake);
    expect(send?.buttons).toBeDefined();
    const flat = (send?.buttons ?? []).flat();
    expect(flat).toHaveLength(2);
    for (const chip of flat) {
      expect(chip.callback_data).toMatch(WIRE);
    }
    expect(flat[0]).toEqual({
      text: "Approve",
      callback_data: `v1.approve.Lne789Abc012.${sign("approve", "Lne789Abc012")}`,
      style: "primary",
    });
    expect(flat[1].callback_data).toBe(`v1.deny.Lne789Abc012.${sign("deny", "Lne789Abc012")}`);
  });

  it("renders the approval prompt text alongside the chips (the opening status)", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1", { signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = firstSend(fake);
    expect(send?.text).toBe("approval required: bash");
  });

  it("a non-approval frame stays send-only — NO chips (preserve AppendOnly behavior)", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1", { signCallbackData: sign });

    const plain: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [
        {
          schemaVersion: 1,
          activityId: "00000000-0000-0000-0000-000000000001",
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
    // Non-approval tool event renders
    // with the per-step running 🔧 marker; the no-chips invariant (this
    // test's load-bearing point — no Quick Reply chips on non-approval
    // frames) is unchanged.
    expect(send?.text).toBe("🔧 running tool");
    expect(send?.buttons).toBeUndefined();
  });

  it("without an injected signer, an approval frame degrades to send-only (no chips, no crash)", async () => {
    const fake = createFakeLineAdapter();
    const r = createLineActivityRenderer(fake, "chat-1");

    await r.apply(approvalFrame());

    const send = firstSend(fake);
    expect(send?.text).toBe("approval required: bash");
    expect(send?.buttons).toBeUndefined();
  });
});
