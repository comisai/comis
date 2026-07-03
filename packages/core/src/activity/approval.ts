// SPDX-License-Identifier: Apache-2.0
/**
 * ApprovalCorrelation — the renderer-visible correlation block carried on an
 * ActivityEvent when `kind === "approval"`.
 *
 * Carries ONLY what a channel renderer needs to draw native approval UI: the
 * short callback-safe id, the choices, and the expiry. The full approval
 * request id (the pending-request UUID) is deliberately NOT a field here — it
 * never crosses the channel boundary. The InteractiveCallbackRouter resolves
 * `shortId` back to that full id server-side. No field on this schema
 * carries the full id; the strict object below rejects any attempt to add one.
 */
import { z } from "zod";

export const ApprovalChoiceSchema = z.strictObject({
  /** Short choice key. Used in callback payloads. */
  id: z.enum(["approve", "deny", "details"]),
  /** Localised label hint; renderers may substitute themed text. */
  defaultLabel: z.string().max(32),
  /** Renderer style hint. */
  style: z.enum(["primary", "danger", "secondary"]),
});

export const ApprovalCorrelationSchema = z.strictObject({
  /**
   * 12-char base62 identifier minted by the approval-gate.
   * Renderers pass this to InteractiveCallbackRouter.render(); the router
   * signs callback payloads and later resolves the short id back to the
   * full pending-request id server-side. That full id never crosses the
   * channel boundary.
   */
  shortId: z.string().length(12).regex(/^[0-9A-Za-z]+$/),
  /** Absolute ms timestamp — `createdAt + timeoutMs`. Renderer uses for UI countdown only. */
  expiresAt: z.number().int().nonnegative(),
  /** Choices presented to the user. Order is render order. */
  choices: z.array(ApprovalChoiceSchema).min(2).max(4),
});

export type ApprovalCorrelation = z.infer<typeof ApprovalCorrelationSchema>;
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;
