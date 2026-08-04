// SPDX-License-Identifier: Apache-2.0
/**
 * The approval card an operator must ACT on was the one surface no locale mechanism reached.
 *
 * `ActivityEvent.defaultLabel` is documented as the English advisory label, and the shared
 * render strategy every themable channel uses reads it verbatim
 * (`channels/shared/strategies/render.ts` → `event.defaultLabel ?? event.toolName ?? event.kind`).
 * It is composed in `@comis/observability`, which has no business knowing about locales, so under
 * a configured non-English `language` the card stayed pure English:
 * `approval required: pipeline graph.execute`. Live: a fully non-English conversation where the
 * model's own answers were correct but the prompt the user had to tap was unreadable to them.
 *
 * The fix is NOT to ship another language — the runtime holds only an English pack by design.
 * It is to make these strings participate in the SAME operator-supplied `localePacks`
 * mechanism as every other runtime notice, and to project them from the event's canonical
 * fields, which is what the schema tells themable renderers to do.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { ActivityEvent } from "@comis/core";
import { createLocaleCatalog } from "./degraded-reply-i18n.js";
import { localizeApprovalCardLabel } from "./activity-card-i18n.js";

function approvalEvent(overrides?: Partial<ActivityEvent>): ActivityEvent {
  return {
    activityId: "a1",
    phase: "start",
    status: "running",
    kind: "approval",
    semanticPhase: "tool",
    toolName: "pipeline",
    action: "graph.execute",
    approval: { shortId: "S1", choices: [] },
    ...overrides,
  } as unknown as ActivityEvent;
}

describe("approval card localization", () => {
  it("resolves the headline from an operator pack for the configured locale", () => {
    const catalog = createLocaleCatalog({
      he: { activity_card_approval_required: "נדרש אישור: {operation}" },
    });

    const label = localizeApprovalCardLabel(approvalEvent(), "he", catalog);

    expect(label).toBe("נדרש אישור: pipeline graph.execute");
  });

  it("keeps the tool identifier verbatim — it is code, not prose", () => {
    const catalog = createLocaleCatalog({
      he: { activity_card_approval_required: "נדרש אישור: {operation}" },
    });

    const label = localizeApprovalCardLabel(approvalEvent(), "he", catalog);

    // A translated pack must never be able to rename the operation being approved: the user is
    // authorizing THIS tool call and has to be able to match it to what the runtime executes.
    expect(label).toContain("pipeline graph.execute");
  });

  it("localizes detail prefixes while leaving their values untouched", () => {
    const catalog = createLocaleCatalog({
      he: {
        activity_card_approval_required: "נדרש אישור: {operation} — {details}",
        activity_card_detail_server: "שרת",
        activity_card_detail_credential: "אישור־גישה",
      },
    });

    const label = localizeApprovalCardLabel(
      approvalEvent({
        params: { server_name: "inventory", env_key: "VENDOR_TOKEN" },
      } as Partial<ActivityEvent>),
      "he",
      catalog,
    );

    expect(label).toContain("שרת inventory");
    expect(label).toContain("אישור־גישה VENDOR_TOKEN");
  });

  it("falls back to English when the pack has no entry for the locale", () => {
    const catalog = createLocaleCatalog({});

    const label = localizeApprovalCardLabel(approvalEvent(), "he", catalog);

    // Unchanged shipped behaviour: English is the only pack the runtime carries, so a locale with
    // no operator pack must render exactly as it does today rather than emptying the card.
    expect(label).toBe("approval required: pipeline graph.execute");
  });

  it("returns undefined for a non-approval event so other cards are untouched", () => {
    const catalog = createLocaleCatalog({
      he: { activity_card_approval_required: "נדרש אישור: {operation}" },
    });

    const label = localizeApprovalCardLabel(
      approvalEvent({ kind: "tool", approval: undefined } as Partial<ActivityEvent>),
      "he",
      catalog,
    );

    expect(label).toBeUndefined();
  });

  it("omits the details token when the event carries no details", () => {
    const catalog = createLocaleCatalog({
      he: { activity_card_approval_required: "נדרש אישור: {operation} — {details}" },
    });

    const label = localizeApprovalCardLabel(approvalEvent(), "he", catalog);

    // A pack author writes ONE template; a dangling separator on the no-details case would be a
    // visible defect in every such card, so the token and its surrounding punctuation collapse.
    expect(label).toBe("נדרש אישור: pipeline graph.execute");
  });
});
