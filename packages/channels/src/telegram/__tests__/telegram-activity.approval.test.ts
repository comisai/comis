// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram approval-UI tests (rich-channel half).
 *
 * The Telegram renderer paints a `kind:"approval"` frame as a
 * grammY inline keyboard: `buildApprovalButtons` (over the renderer-injected
 * `SignCallbackData`) yields signed `RichButton` rows, and `renderTelegramButtons`
 * (the budget-guarded mapper) turns them into the `InlineKeyboard`. Each
 * `callback_data` is the signed wire string `v1.<choice>.<shortId>.<hmac>` and
 * survives the 64-byte budget — the over-budget guard OMITS a button (never
 * truncates a signed payload), but the worst-case real payload is ~40 bytes so
 * every choice fits.
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
import { createTelegramActivityRenderer } from "../telegram-activity.js";
import { renderTelegramButtons } from "../rich-renderer.js";
import { createFakeTelegramAdapter } from "../../__tests__/fakes/telegram-fake.js";
import type { FakeTelegramCall } from "../../__tests__/fakes/telegram-fake.js";

const SECRET = "test-callback-signing-secret-0123456789";
const sign = (choice: "approve" | "deny" | "details", shortId: string): string =>
  signCallbackData(SECRET, choice, shortId);

const WIRE = /^v1\.(approve|deny)\.[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{16}$/;
const MAX_CALLBACK_DATA_BYTES = 64;

function approval(overrides: Partial<ApprovalCorrelation> = {}): ApprovalCorrelation {
  return {
    shortId: "Tg345Hjk678X",
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

describe("Telegram inline-keyboard approval (budget-safe signed callback_data)", () => {
  it("paints a kind:'approval' frame as buttons whose callback_data is the signed wire string", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeTelegramCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeDefined();
    const flat = (send?.buttons ?? []).flat();
    expect(flat).toHaveLength(2);
    for (const btn of flat) {
      expect(btn.callback_data).toMatch(WIRE);
      // Every real signed payload fits Telegram's 64-byte budget.
      const bytes = new TextEncoder().encode(btn.callback_data ?? "").length;
      expect(bytes).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    }
    expect(flat[0].callback_data).toBe(`v1.approve.Tg345Hjk678X.${sign("approve", "Tg345Hjk678X")}`);
    expect(flat[1].callback_data).toBe(`v1.deny.Tg345Hjk678X.${sign("deny", "Tg345Hjk678X")}`);
  });

  it("the rows render through renderTelegramButtons into a grammY InlineKeyboard (no over-budget omission)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

    await r.apply(approvalFrame());

    const send = fake.recorded.calls.find(
      (c): c is Extract<FakeTelegramCall, { op: "send" }> => c.op === "send",
    );
    const keyboard = renderTelegramButtons(send?.buttons ?? []);
    // Both buttons survive the budget — none omitted.
    expect(keyboard.inline_keyboard[0]).toHaveLength(2);
    expect(keyboard.inline_keyboard[0][0]).toEqual({
      text: "Approve",
      callback_data: `v1.approve.Tg345Hjk678X.${sign("approve", "Tg345Hjk678X")}`,
    });
    for (const btn of keyboard.inline_keyboard[0]) {
      expect(btn.callback_data).toMatch(WIRE);
    }
  });

  it("a non-approval frame carries NO buttons (button-less send stays byte-stable)", async () => {
    const timer = createFakeTimers();
    const clock = createFakeClock(0);
    const fake = createFakeTelegramAdapter();
    const r = createTelegramActivityRenderer(fake, "chat-1", { timer, clock, signCallbackData: sign });

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
      (c): c is Extract<FakeTelegramCall, { op: "send" }> => c.op === "send",
    );
    expect(send?.buttons).toBeUndefined();
  });
});
