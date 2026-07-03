// SPDX-License-Identifier: Apache-2.0
/**
 * iMessage AppendOnly activity renderer.
 * iMessage is send-only — no in-place edit, no delete — so it wires the
 * `createAppendOnlyRenderer`: ONE opening status (the first non-trivial frame),
 * later frames are no-ops, the closing follow-up is SUPPRESSED on success (the
 * assistant reply is the signal — posting a "✓ done" on every success would be
 * noise on a channel that cannot edit), and a failure posts exactly one
 * `❌ {errorKind}` follow-up. Three parts, copying the per-channel
 * `classify<Ch>Error` / `make<Ch>RenderActions` / `create<Ch>ActivityRenderer`
 * shape (signal-activity.ts is the closest non-EditPlace structural analog —
 * `buttons:"none"`, no rich effect, thin wiring):
 *
 *   1. `classifyIMessageError` — the single net-new piece of logic here. The live
 *      iMessage adapter wraps send failures in `new Error("Failed to send
 *      iMessage: …")` (and a not-started guard in `new Error("iMessage adapter
 *      not started")`), with NO structured numeric code to read. There is no
 *      reliable structural signal to disambiguate a retryable/permission case on
 *      this send-only channel, so the classifier DEFAULTS to
 *      `{kind:"internal", cause:e}` (KISS — no invented rich
 *      classifier). The wrapped "Failed to send …" message is read
 *      for NOTHING user-facing — it selects the variant only and is NEVER rendered
 *      or logged as activity text. The S4 fixture proves the failure text is
 *      `❌ {errorKind}` (from `failureLabel`), not the bridge error body.
 *
 *   2. `makeIMessageRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts a plain opening status via `adapter.sendMessage` (NO silent effect —
 *      iMessage ignores it; NO buttons — `buttons:"none"`). `edit` and `delete`
 *      return `not_supported` immediately — iMessage has neither and the live
 *      adapter exposes no `editMessage` / `deleteMessage` (a guard, never
 *      `adapter.editMessage!` — AGENTS.md §2.8). AppendOnly never calls edit/delete
 *      (canEdit/canDelete are false), but the port contract requires both; an early
 *      `not_supported` is the honest answer. All paths return `Result`; nothing
 *      throws across the boundary.
 *
 *   3. `createIMessageActivityRenderer` — wires the
 *      {@link createAppendOnlyRenderer}. AppendOnly has no delete to sequence, so
 *      its deps are `{ actions }` ONLY — there is NO TimerPort / ClockPort (the
 *      strategy schedules nothing). It does NOT re-implement any
 *      sequencing — the strategy owns the opening-once + suppress-on-success +
 *      one-closing-on-failure finalize table. This is the signature the daemon
 *      wiring constructs.
 *
 * The channels package depends on core + shared only (no observability substrate),
 * so no diagnostics primitive is reachable here.
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  ActivityStatusMarkers,
  ClockPort,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createAppendOnlyRenderer } from "../shared/strategies/append-only.js";
import { buildApprovalPrompt } from "../shared/strategies/approval-render.js";

/**
 * Classify a raw iMessage platform error into the closed {@link ActivityRenderError}
 * union. The live adapter wraps send/not-started failures in a bare `Error` with
 * no structured numeric code to read, so this DEFAULTS to `internal` carrying the
 * cause. The error is consulted for NOTHING that reaches the user — it selects the
 * variant only and is never rendered or logged as activity text.
 */
export function classifyIMessageError(e: unknown): ActivityRenderError {
  // The iMessage bridge offers no structured code for send failures; there is no
  // reliable structural signal to map a richer variant, so internal is the only
  // branch (KISS — do not invent a rich classifier on an unstructured error).
  return { kind: "internal", cause: e };
}

/**
 * Build the {@link ActivityRenderActions} for an iMessage chat. `send` posts a
 * plain opening status (no silent effect, no buttons); `edit` and `delete` are
 * unsupported (iMessage is send-only) and return `not_supported` without touching
 * the port. All paths return `Result`; nothing throws across the boundary.
 */
export function makeIMessageRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  return {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      // Plain opening status: iMessage ignores the silent effect and has no button
      // surface, so send carries no options.
      const r = await adapter.sendMessage(channelId, text);
      return r.ok ? ok(r.value) : err(classifyIMessageError(r.error));
    },

    async edit(_id, _text): Promise<Result<void, ActivityRenderError>> {
      // iMessage has no in-place edit — the live adapter exposes no editMessage.
      // AppendOnly never calls this (canEdit:false), but the port contract requires
      // it; an early not_supported is the honest answer (never `adapter.editMessage!`).
      return err({ kind: "not_supported", capability: "edit" });
    },

    async delete(_id): Promise<Result<void, ActivityRenderError>> {
      // iMessage has no delete — the live adapter exposes no deleteMessage.
      // AppendOnly never calls this (canDelete:false); the early not_supported is
      // the honest answer (never `adapter.deleteMessage!`).
      return err({ kind: "not_supported", capability: "delete" });
    },
  };
}

/**
 * Create the iMessage AppendOnly activity renderer — wires the
 * {@link createAppendOnlyRenderer} with the per-channel render-actions adapter.
 *
 * AppendOnly has no delete to sequence — NO TimerPort (a scheduling
 * TimerPort is a different concern from a read-only clock for elapsed display).
 * The optional `deps.clock` is forwarded into
 * the strategy so the "(running N s)" fallback lights up when no SEP plan is
 * active; `clock.now()` is read-only display arithmetic (no scheduling, no
 * I/O). The optional `deps.markers` is forwarded to the strategy's
 * themed closing line. The daemon constructs this with the chat id
 * and threads `clock` via the uniform `ActivityRendererDeps` spread (at
 * `setup-channels-activity-renderers.ts:189-197`).
 */
export function createIMessageActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { clock?: ClockPort; markers?: ActivityStatusMarkers } = {},
): ChannelActivityRenderer {
  return createAppendOnlyRenderer({
    actions: makeIMessageRenderActions(adapter, channelId),
    // Forward the daemon-injected ClockPort so AppendOnly's first-apply
    // startedAtMs capture + elapsedMs feeds renderFrameText's "(running N s)"
    // fallback. Without this forward, the elapsed fallback would be silently
    // inert in iMessage.
    clock: deps.clock,
    markers: deps.markers,
    // iMessage has no button surface, so an approval frame appends the plain-text
    // prompt ("Reply approve or deny …", with shortIds when >1 pending) to the
    // opening status. A non-approval frame yields "" (no append).
    buildPrompt: buildApprovalPrompt,
  });
}
