// SPDX-License-Identifier: Apache-2.0
/**
 * Discord approval-UI tests (rich-channel half).
 *
 * The Discord renderer paints the approval affordance as real
 * native components: a `kind:"approval"` event in a frame's `visibleEvents` is
 * painted as a Discord component row whose `callback_data` is the signed
 * wire string `v1.<choice>.<shortId>.<hmac>` (from `buildApprovalButtons` over
 * the renderer-injected `SignCallbackData`). The frame stays redacted — the
 * button labels/styles come from the choice hints, never raw params.
 *
 * The signing seam is consumed here, not re-derived: the renderer takes
 * a `signCallbackData` dep (wired at the composition root) and reaches
 * the core HMAC primitive through it — never importing `@comis/orchestrator`.
 *
 * Time discipline: the FakeTimers/FakeClock drive every wait (no raw
 * setTimeout/Date.now).
 */
import { describe, it, expect } from "vitest";
import type { ActivityRenderFrame, ActivityEvent, ApprovalCorrelation } from "@comis/core";
import { signCallbackData } from "@comis/core";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { createDiscordActivityRenderer } from "../discord-activity.js";
import { createFakeDiscordAdapter } from "../../__tests__/fakes/discord-fake.js";
import type { FakeDiscordCall } from "../../__tests__/fakes/discord-fake.js";

/** Fixed secret → deterministic 16-char base64url HMAC tag for the assertions. */
const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

/** The signed-callback wire shape: `v1.<choice>.<12 base62>.<16 base64url>`. */
const WIRE = /^v1\.(approve|deny)\.[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{16}$/;

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Abc123Def456",
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

describe("Discord approval components (signed native callback_data)", () => {
  it("paints a kind:'approval' frame as a component row whose callback_data is the signed wire string", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeDiscordCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeDefined();
    const rows = send?.buttons ?? [];
    const flat = rows.flat();
    expect(flat).toHaveLength(2);
    for (const btn of flat) {
      expect(btn.callback_data).toMatch(WIRE);
    }
    // The two choices carry the redacted labels/styles + the signed callback.
    expect(flat[0]).toEqual({
      text: "Approve",
      callback_data: `v1.approve.Abc123Def456.${sign("approve", "Abc123Def456")}`,
      style: "primary",
    });
    expect(flat[1].callback_data).toBe(`v1.deny.Abc123Def456.${sign("deny", "Abc123Def456")}`);
  });

  it("renders the approval prompt text alongside the buttons", async () => {
    const timer = createFakeTimers();
    const fake = createFakeDiscordAdapter();
    // Drop clock so the "(running N s)" elapsed fallback
    // is skipped — the test asserts the approval-prompt text byte-stably.
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeDiscordCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.text).toBe("approval required: bash");
  });

  it("a non-approval frame carries NO buttons (button-less send stays byte-stable)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeDiscordAdapter();
    const r = createDiscordActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

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
      (c): c is Extract<FakeDiscordCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeUndefined();
  });
});
