// SPDX-License-Identifier: Apache-2.0
/**
 * approval-render helper tests (render side of the approval flow).
 *
 * The render path is text-only today; these helpers are the shared foundation
 * every per-channel approval UI builds on:
 *
 *   - `buildApprovalButtons(event, sign)` turns a `kind:"approval"` event's
 *     redacted `ApprovalCorrelation` (`shortId` + `choices`) into signed
 *     `RichButton` rows. Each button's `callback_data` is the wire
 *     string `v1.<choice>.<shortId>.<hmac>` where `<hmac>` comes from the
 *     INJECTED, secret-bound signer — the renderer never sees the secret and
 *     never reaches `@comis/orchestrator`.
 *   - `buildApprovalText(event, opts?)` is the plain-text fallback (IRC /
 *     WhatsApp / Signal / iMessage): single-pending → "Reply approve or deny …";
 *     `includeShortId` → "Reply approve <S> or deny <S>" so a renderer that
 *     knows the pending count can disambiguate.
 *
 * The signer used here is the REAL `signCallbackData` from `@comis/core` bound
 * to a fixed test secret — so the asserted `callback_data` is byte-identical to
 * what the orchestrator's router will later verify (one primitive, no
 * duplication, no boundary violation).
 */
import { describe, it, expect } from "vitest";
import { signCallbackData } from "@comis/core";
import type { ActivityEvent, RichButton } from "@comis/core";
import type { SignCallbackData } from "./approval-render.js";
import { buildApprovalButtons, buildApprovalText } from "./approval-render.js";

/** Fixed 32-byte-ish test secret — the value is irrelevant; determinism is. */
const TEST_SECRET = "test-signing-secret-do-not-use-in-prod";

/** The injected signer the renderer receives at the composition root. */
const sign: SignCallbackData = (choice, shortId) =>
  signCallbackData(TEST_SECRET, choice, shortId);

const SHORT_ID = "Ab3Cd5Ef7Gh9"; // 12-char base62 (matches ApprovalCorrelationSchema)

/**
 * Build a `kind:"approval"` ActivityEvent carrying a redacted ApprovalCorrelation.
 * Only the fields the helpers read are populated; defaults are spec-shaped.
 */
function approvalEvent(
  choices: ActivityEvent["approval"] extends infer A
    ? A extends { choices: infer C }
      ? C
      : never
    : never = [
    { id: "approve", defaultLabel: "Approve", style: "primary" },
    { id: "deny", defaultLabel: "Deny", style: "danger" },
  ],
): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "11111111-1111-1111-1111-111111111111",
    sessionKey: "sess",
    agentId: "agent",
    traceId: "trace",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "approval",
    semanticPhase: "queued",
    toolName: "shell",
    approval: { shortId: SHORT_ID, expiresAt: 1_700_000_000_000, choices },
    defaultLabel: "approval required: shell",
  } as ActivityEvent;
}

/** A non-approval event (no `approval` block) — helpers must no-op for it. */
function toolEvent(): ActivityEvent {
  return {
    schemaVersion: 1,
    activityId: "22222222-2222-2222-2222-222222222222",
    sessionKey: "sess",
    agentId: "agent",
    traceId: "trace",
    ts: "2026-05-26T00:00:00.000Z",
    phase: "start",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    toolName: "search",
    defaultLabel: "searching",
  } as ActivityEvent;
}

describe("buildApprovalButtons", () => {
  it("emits one signed button per choice; callback_data is v1.<choice>.<shortId>.<hmac>", () => {
    const rows = buildApprovalButtons(approvalEvent(), sign);
    // One row carrying both choices, in render order.
    const flat = rows.flat();
    expect(flat).toHaveLength(2);

    const [approve, deny] = flat as [RichButton, RichButton];

    // Visible text comes from the choice's defaultLabel.
    expect(approve.text).toBe("Approve");
    expect(deny.text).toBe("Deny");

    // callback_data is the exact wire string built from the INJECTED signer.
    expect(approve.callback_data).toBe(
      `v1.approve.${SHORT_ID}.${signCallbackData(TEST_SECRET, "approve", SHORT_ID)}`,
    );
    expect(deny.callback_data).toBe(
      `v1.deny.${SHORT_ID}.${signCallbackData(TEST_SECRET, "deny", SHORT_ID)}`,
    );
  });

  it("every emitted callback_data fits the 64-byte Telegram budget (RichButtonSchema.max)", () => {
    const rows = buildApprovalButtons(approvalEvent(), sign);
    for (const btn of rows.flat()) {
      const bytes = new TextEncoder().encode(btn.callback_data ?? "").length;
      expect(bytes).toBeLessThanOrEqual(64);
    }
  });

  it("produces a `details` button when the choice is present", () => {
    const rows = buildApprovalButtons(
      approvalEvent([
        { id: "approve", defaultLabel: "Approve", style: "primary" },
        { id: "deny", defaultLabel: "Deny", style: "danger" },
        { id: "details", defaultLabel: "Details", style: "secondary" },
      ]),
      sign,
    );
    const details = rows.flat().find((b) => b.callback_data?.startsWith("v1.details."));
    expect(details).toBeDefined();
    expect(details?.text).toBe("Details");
    expect(details?.callback_data).toBe(
      `v1.details.${SHORT_ID}.${signCallbackData(TEST_SECRET, "details", SHORT_ID)}`,
    );
  });

  it("carries the choice's style hint onto the button", () => {
    const rows = buildApprovalButtons(approvalEvent(), sign);
    const [approve, deny] = rows.flat() as [RichButton, RichButton];
    expect(approve.style).toBe("primary");
    expect(deny.style).toBe("danger");
  });

  it("returns no rows for a non-approval event (no approval block)", () => {
    expect(buildApprovalButtons(toolEvent(), sign)).toEqual([]);
  });

  it("never signs over user text — only (choice, shortId) reach the signer", () => {
    // The signer is called with the choice id + shortId ONLY. A spy proves no
    // raw param / label is forwarded (no raw params in the approval UI).
    const seen: Array<{ choice: string; shortId: string }> = [];
    const spySign: SignCallbackData = (choice, shortId) => {
      seen.push({ choice, shortId });
      return signCallbackData(TEST_SECRET, choice, shortId);
    };
    buildApprovalButtons(approvalEvent(), spySign);
    expect(seen).toEqual([
      { choice: "approve", shortId: SHORT_ID },
      { choice: "deny", shortId: SHORT_ID },
    ]);
  });
});

describe("buildApprovalText", () => {
  it("single-pending form omits the shortId", () => {
    const text = buildApprovalText(approvalEvent());
    expect(text).toMatch(/^Reply approve or deny\b/);
    expect(text).not.toContain(SHORT_ID);
  });

  it("includeShortId form embeds the shortId after each verb for multi-pending disambiguation", () => {
    const text = buildApprovalText(approvalEvent(), { includeShortId: true });
    expect(text).toBe(`Reply approve ${SHORT_ID} or deny ${SHORT_ID}`);
  });

  it("returns empty string for a non-approval event", () => {
    expect(buildApprovalText(toolEvent())).toBe("");
  });
});
