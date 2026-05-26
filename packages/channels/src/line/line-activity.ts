// SPDX-License-Identifier: Apache-2.0
/**
 * LINE AppendOnly activity renderer (CHAN-08; §7.2 / §18.3 row "AppendOnly").
 * LINE is send-only for the activity renderer — no in-place edit, no delete — so
 * it wires the Phase-70 `createAppendOnlyRenderer` IDENTICALLY to iMessage: ONE
 * opening status (the first non-trivial frame), later frames are no-ops, the
 * closing follow-up is SUPPRESSED on success (the assistant reply is the signal),
 * and a failure posts exactly one `❌ {errorKind}` follow-up. Three parts,
 * copying the Phase-71/72 `classify<Ch>Error` / `make<Ch>RenderActions` /
 * `create<Ch>ActivityRenderer` shape (signal-activity.ts is the closest
 * non-EditPlace structural analog — `buttons:"none"`, no rich effect, thin wiring):
 *
 *   1. `classifyLineError` — the single net-new piece of logic here. The live LINE
 *      adapter wraps send failures in `new Error("Failed to send LINE message:
 *      …")` (catch-wrapped around the LINE SDK throw), with NO structured numeric
 *      code preserved on the wrapper. There is no reliable structural signal to
 *      disambiguate a retryable/permission/quota case on this send-only renderer,
 *      so the classifier DEFAULTS to `{kind:"internal", cause:e}` (KISS —
 *      Pitfall 4; no invented rich classifier). SEC-05/§19.3: the wrapped "Failed
 *      to send …" message is read for NOTHING user-facing — it selects the variant
 *      only and is NEVER rendered or logged as activity text. The S4 fixture proves
 *      the failure text is `❌ {errorKind}` (from `failureLabel`), not the SDK body.
 *
 *   2. `makeLineRenderActions` — the `ActivityRenderActions` adapter. `send` posts
 *      a plain opening status via `adapter.sendMessage` (NO silent effect — LINE
 *      ignores it; NO buttons). `edit` and `delete` return `not_supported`
 *      immediately — LINE has neither and the live adapter exposes no `editMessage`
 *      / `deleteMessage` (a guard, never `adapter.editMessage!` — AGENTS.md §2.8).
 *      AppendOnly never calls edit/delete (canEdit/canDelete are false), but the
 *      port contract requires both; an early `not_supported` is the honest answer.
 *      All paths return `Result`; nothing throws across the boundary.
 *
 *   3. `createLineActivityRenderer` — wires the Phase-70
 *      {@link createAppendOnlyRenderer}. AppendOnly has no delete to sequence, so
 *      its deps are `{ actions }` ONLY — there is NO TimerPort / ClockPort (the
 *      strategy schedules nothing; Pitfall 5). It does NOT re-implement any
 *      sequencing — the strategy owns the finalize table. This is the signature the
 *      72-05 WIRE-02 daemon wiring constructs.
 *
 * SCOPE — LINE Quick Reply approval chips are DEFERRED to Phase 73. This renderer
 * delivers the AppendOnly RENDERING half of CHAN-08 only. The `ActivityRenderActions`
 * port is `send(text)`-only (there is no button param), there is no
 * `kind:"approval"` ActivityEvent until Phase 73 (APV-03), and there are ZERO S8
 * fixtures — so no approval / Quick Reply surface is introduced here (no premature
 * trust boundary). When Phase 73's approval router lands, the chip affordance rides
 * with it; this file stays send-only.
 *
 * The channels package depends on core + shared only (no observability substrate),
 * so no diagnostics primitive is reachable here.
 */
import { ok, err, type Result } from "@comis/shared";
import type { ChannelActivityRenderer, ActivityRenderError, ChannelPort } from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createAppendOnlyRenderer } from "../shared/strategies/append-only.js";

/**
 * Classify a raw LINE platform error into the closed {@link ActivityRenderError}
 * union. The live adapter wraps send failures in a bare `Error` with no structured
 * numeric code preserved, so this DEFAULTS to `internal` carrying the cause. The
 * error is consulted for NOTHING that reaches the user — it selects the variant
 * only and is never rendered or logged as activity text (SEC-05/§19.3, T-72-02-01).
 */
export function classifyLineError(e: unknown): ActivityRenderError {
  // The LINE SDK throw is catch-wrapped into a bare Error with no structured code
  // preserved; there is no reliable structural signal to map a richer variant, so
  // internal is the only branch (KISS — do not invent a rich classifier).
  return { kind: "internal", cause: e };
}

/**
 * Build the {@link ActivityRenderActions} for a LINE chat. `send` posts a plain
 * opening status (no silent effect, no buttons — the Quick Reply approval chip is
 * Phase 73); `edit` and `delete` are unsupported (LINE is send-only) and return
 * `not_supported` without touching the port. All paths return `Result`; nothing
 * throws across the boundary.
 */
export function makeLineRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  return {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      // Plain opening status: LINE ignores the silent effect; the Quick Reply
      // approval chip surface is Phase 73, so send carries no options here.
      const r = await adapter.sendMessage(channelId, text);
      return r.ok ? ok(r.value) : err(classifyLineError(r.error));
    },

    async edit(_id, _text): Promise<Result<void, ActivityRenderError>> {
      // LINE has no in-place edit — the live adapter exposes no editMessage.
      // AppendOnly never calls this (canEdit:false), but the port contract requires
      // it; an early not_supported is the honest answer (never `adapter.editMessage!`).
      return err({ kind: "not_supported", capability: "edit" });
    },

    async delete(_id): Promise<Result<void, ActivityRenderError>> {
      // LINE has no delete — the live adapter exposes no deleteMessage. AppendOnly
      // never calls this (canDelete:false); the early not_supported is the honest
      // answer (never `adapter.deleteMessage!`).
      return err({ kind: "not_supported", capability: "delete" });
    },
  };
}

/**
 * Create the LINE AppendOnly activity renderer — wires the Phase-70
 * {@link createAppendOnlyRenderer} with the per-channel render-actions adapter.
 * AppendOnly has no delete to sequence, so its deps are `{ actions }` ONLY: there
 * is NO TimerPort / ClockPort (Pitfall 5). The daemon composition root constructs
 * this with the chat id (WIRE-02). This is the signature the 72-05 wiring builds.
 */
export function createLineActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
): ChannelActivityRenderer {
  return createAppendOnlyRenderer({
    actions: makeLineRenderActions(adapter, channelId),
  });
}
