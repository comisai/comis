// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams approval-UI tests (rich-channel half).
 *
 * The Teams renderer turns its deferred card-action shell into a real signed
 * approval UI: a `kind:"approval"` frame paints the choices as `RichButton` rows
 * whose `callback_data` is the signed wire string `v1.<choice>.<shortId>.<hmac>`
 * (from `buildApprovalButtons` over the renderer-injected `SignCallbackData`).
 * The Teams adapter later maps each row onto an `Action.Execute` card action
 * carrying that signed callback — that Adaptive Card JSON is rendered in the
 * adapter, not here; this file pins the signed rows the renderer emits at the
 * port boundary. When no signer is injected the frame degrades to a button-less
 * text prompt (byte-stable). The frame stays redacted — labels/styles come from
 * the choice hints, never raw params.
 *
 * The signing seam is consumed, not re-derived: the renderer reaches the core
 * HMAC primitive through the injected `signCallbackData` — never importing
 * `@comis/orchestrator`.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createMSTeamsActivityRenderer } from "../msteams-activity.js";
import { createFakeMSTeamsAdapter } from "../../__tests__/fakes/msteams-fake.js";
import type { FakeMSTeamsCall } from "../../__tests__/fakes/msteams-fake.js";

const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

const WIRE = /^v1\.(approve|deny)\.[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{16}$/;

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "MsT789Abc012",
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

describe("Microsoft Teams approval actions (signed callback wire)", () => {
  it("paints a kind:'approval' frame as RichButton rows whose callback_data is the signed wire string", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMSTeamsAdapter();
    const r = createMSTeamsActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeMSTeamsCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeDefined();
    const flat = (send?.buttons ?? []).flat();
    expect(flat).toHaveLength(2);
    for (const el of flat) {
      // The Teams adapter carries callback data on the card action's `data` — at
      // the port boundary it is the RichButton.callback_data (the signed wire).
      expect(el.callback_data).toMatch(WIRE);
    }
    expect(flat[0]).toEqual({
      text: "Approve",
      callback_data: `v1.approve.MsT789Abc012.${sign("approve", "MsT789Abc012")}`,
      style: "primary",
    });
    expect(flat[1].callback_data).toBe(`v1.deny.MsT789Abc012.${sign("deny", "MsT789Abc012")}`);
  });

  it("degrades a kind:'approval' frame to a button-less text prompt when NO signer is injected", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMSTeamsAdapter();
    // No signCallbackData → buildButtons undefined → the approval frame is a bare
    // text activity: send.buttons is undefined (byte-stable text fallback).
    const r = createMSTeamsActivityRenderer(fake, "chat-1", { timer, clock });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeMSTeamsCall, { op: "send" }> => c.op === "send",
    );
    expect(send).toBeDefined();
    expect(send?.buttons).toBeUndefined();
  });

  it("a non-approval frame carries NO buttons (button-less send stays byte-stable)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeMSTeamsAdapter();
    const r = createMSTeamsActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

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

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeMSTeamsCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeUndefined();
  });
});
