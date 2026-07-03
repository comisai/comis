// SPDX-License-Identifier: Apache-2.0
/**
 * Slack approval-UI tests (rich-channel half).
 *
 * The Slack renderer turns its deferred Block Kit `actions` shell into a
 * real signed approval UI: a `kind:"approval"` frame paints the choices as
 * `RichButton` rows whose `callback_data` is the signed wire string
 * `v1.<choice>.<shortId>.<hmac>` (from `buildApprovalButtons` over the
 * renderer-injected `SignCallbackData`). The Slack adapter maps each row to a
 * Block Kit `actions` element whose `value` IS that signed callback (the value is
 * how Slack carries callback data back on a button click). The frame stays
 * redacted — labels/styles come from the choice hints, never raw params.
 *
 * The signing seam is consumed, not re-derived: the renderer reaches the
 * core HMAC primitive through the injected `signCallbackData` — never importing
 * `@comis/orchestrator`.
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createSlackActivityRenderer } from "../slack-activity.js";
import { createFakeSlackAdapter } from "../../__tests__/fakes/slack-fake.js";
import type { FakeSlackCall } from "../../__tests__/fakes/slack-fake.js";

const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

const WIRE = /^v1\.(approve|deny)\.[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{16}$/;

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Slk789Abc012",
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

describe("Slack Block Kit approval actions (signed callback value)", () => {
  it("paints a kind:'approval' frame as action elements whose value is the signed wire string", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeSlackCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeDefined();
    const flat = (send?.buttons ?? []).flat();
    expect(flat).toHaveLength(2);
    for (const el of flat) {
      // The Slack adapter carries callback data in the action `value` — at the
      // port boundary it is the RichButton.callback_data (the signed wire string).
      expect(el.callback_data).toMatch(WIRE);
    }
    expect(flat[0]).toEqual({
      text: "Approve",
      callback_data: `v1.approve.Slk789Abc012.${sign("approve", "Slk789Abc012")}`,
      style: "primary",
    });
    expect(flat[1].callback_data).toBe(`v1.deny.Slk789Abc012.${sign("deny", "Slk789Abc012")}`);
  });

  it("renders the approval prompt text alongside the actions", async () => {
    const timer = createFakeTimers();
    const fake = createFakeSlackAdapter();
    // Drop clock so the elapsed-time fallback is skipped — the test asserts
    // send.text byte-stably.
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeSlackCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.text).toBe("approval required: bash");
  });

  it("a non-approval frame carries NO buttons (button-less send stays byte-stable)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeSlackAdapter();
    const r = createSlackActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

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
      (c): c is Extract<FakeSlackCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeUndefined();
  });
});
