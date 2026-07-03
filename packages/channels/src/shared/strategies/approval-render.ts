// SPDX-License-Identifier: Apache-2.0
/**
 * Shared approval-render helpers (render side of the approval flow).
 *
 * The render path is text-only by default; these helpers are the foundation
 * every per-channel approval UI (buttons, Block-Kit / Quick-Reply,
 * plain-text) consumes. They turn the redacted `ApprovalCorrelation`
 * carried on a `kind:"approval"` ActivityEvent into:
 *
 *   - `buildApprovalButtons(event, sign)` → signed `RichButton[][]`. Each
 *     button's `callback_data` is the wire string
 *     `v1.<choice>.<shortId>.<hmac>`. The `<hmac>` is produced by the INJECTED,
 *     secret-bound signer (`SignCallbackData`) — the renderer never sees the
 *     secret and never reaches across into the orchestrator package. The
 *     visible text and style come from the choice's own redacted
 *     hints; no raw tool params are ever read.
 *   - `buildApprovalText(event, opts?)` → the plain-text fallback for surfaces
 *     with no button affordance (IRC / WhatsApp / Signal / iMessage). Single
 *     pending → "Reply approve or deny …"; `includeShortId` →
 *     "Reply approve <S> or deny <S>" so a renderer that knows there is more
 *     than one pending approval can disambiguate.
 *
 * The signer is wired at the daemon composition root: a function that
 * closes over `activity.interactiveCallbackSigningSecret` and delegates to the
 * core primitive `signCallbackData`. The orchestrator's `InteractiveCallbackRouter`
 * verifies against the SAME core primitive — one implementation, no duplication,
 * no boundary violation.
 *
 * Imports ONLY `@comis/core` + `@comis/shared` (the `channels → core` edge).
 * Pure functions: no I/O, no logger.
 */
import type { ActivityEvent, ApprovalChoice, RichButton } from "@comis/core";

/**
 * The secret-bound signer injected into a renderer's deps at the composition
 * root. Returns the 16-char base64url HMAC tag for `(choice, shortId)`
 * — the `<hmac>` segment of the callback wire string. Delegates to the core
 * primitive `signCallbackData(secret, choice, shortId)`; the secret is captured
 * by the closure and never crosses into the channels package.
 */
export type SignCallbackData = (
  choice: ApprovalChoice["id"],
  shortId: string,
) => string;

/**
 * Assemble the callback wire string for one choice.
 *
 * Byte-identical to `renderCallbackData` from `@comis/core` so the orchestrator's
 * router verifies what the renderer signs. Format: `v1.<choice>.<shortId>.<hmac>`.
 */
function callbackData(choice: ApprovalChoice["id"], shortId: string, sign: SignCallbackData): string {
  return `v1.${choice}.${shortId}.${sign(choice, shortId)}`;
}

/**
 * Build the signed native-button rows for a `kind:"approval"` event.
 *
 * Returns one row carrying every choice in render order. A non-approval event
 * (no `approval` block) yields `[]` — callers can unconditionally spread the
 * result. Each button's `callback_data` is the signed wire string; the text
 * and style come from the choice's redacted hints (never from raw params).
 */
export function buildApprovalButtons(
  event: ActivityEvent,
  sign: SignCallbackData,
): RichButton[][] {
  const approval = event.approval;
  if (approval === undefined) return [];

  const row: RichButton[] = approval.choices.map((choice) => ({
    text: choice.defaultLabel,
    callback_data: callbackData(choice.id, approval.shortId, sign),
    style: choice.style,
  }));

  return [row];
}

/** Options controlling the plain-text approval prompt. */
export interface ApprovalTextOptions {
  /**
   * Include the `shortId` after each verb so a user can disambiguate when more
   * than one approval is pending in the same channel. The renderer
   * (which knows the pending count) decides whether to set this.
   */
  includeShortId?: boolean;
}

/**
 * Build the plain-text approval prompt for surfaces with no button affordance.
 *
 * Single pending (default): `"Reply approve or deny within the approval timeout"`.
 * With `includeShortId`: `"Reply approve <S> or deny <S>"`.
 *
 * A non-approval event yields `""` — the caller renders nothing.
 */
export function buildApprovalText(event: ActivityEvent, opts?: ApprovalTextOptions): string {
  const approval = event.approval;
  if (approval === undefined) return "";

  if (opts?.includeShortId === true) {
    const s = approval.shortId;
    return `Reply approve ${s} or deny ${s}`;
  }
  return "Reply approve or deny within the approval timeout";
}

/** Count the `kind:"approval"` events pending in a frame's visible set. */
export function countPendingApprovals(events: readonly ActivityEvent[]): number {
  let n = 0;
  for (const e of events) if (e.approval !== undefined) n += 1;
  return n;
}

/**
 * Build the plain-text approval prompt(s) for a whole frame — the single helper
 * the four button-less channels (WhatsApp / Signal / iMessage / IRC) consume.
 * For each `kind:"approval"` event it emits `buildApprovalText`, joined
 * by newlines. `includeShortId` is derived HERE from the pending count: a shortId
 * is surfaced ONLY when MORE THAN ONE approval is pending in this same frame, so a
 * single-pending prompt stays terse and cross-session shortIds never appear.
 * A frame with no approval event yields `""` — the caller appends
 * nothing.
 */
export function buildApprovalPrompt(events: readonly ActivityEvent[]): string {
  const includeShortId = countPendingApprovals(events) > 1;
  const lines: string[] = [];
  for (const event of events) {
    const text = buildApprovalText(event, { includeShortId });
    if (text.length > 0) lines.push(text);
  }
  return lines.join("\n");
}
