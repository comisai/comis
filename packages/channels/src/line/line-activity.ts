// SPDX-License-Identifier: Apache-2.0
/**
 * LINE AppendOnly activity renderer.
 * LINE is send-only for the activity renderer — no in-place edit, no delete — so
 * it wires the `createAppendOnlyRenderer` IDENTICALLY to iMessage: ONE
 * opening status (the first non-trivial frame), later frames are no-ops, the
 * closing follow-up is SUPPRESSED on success (the assistant reply is the signal),
 * and a failure posts exactly one `❌ {errorKind}` follow-up. Three parts,
 * copying the per-channel `classify<Ch>Error` / `make<Ch>RenderActions` /
 * `create<Ch>ActivityRenderer` shape (signal-activity.ts is the closest
 * non-EditPlace structural analog — `buttons:"none"`, no rich effect, thin wiring):
 *
 *   1. `classifyLineError` — the single net-new piece of logic here. The live LINE
 *      adapter wraps send failures in `new Error("Failed to send LINE message:
 *      …")` (catch-wrapped around the LINE SDK throw), with NO structured numeric
 *      code preserved on the wrapper. There is no reliable structural signal to
 *      disambiguate a retryable/permission/quota case on this send-only renderer,
 *      so the classifier DEFAULTS to `{kind:"internal", cause:e}` (KISS — no
 *      invented rich classifier). The wrapped "Failed to send …" message is read
 *      for NOTHING user-facing — it selects the variant only and is NEVER
 *      rendered or logged as activity text. The S4 fixture proves the failure
 *      text is `❌ {errorKind}` (from `failureLabel`), not the SDK body.
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
 *   3. `createLineActivityRenderer` — wires the
 *      {@link createAppendOnlyRenderer}. AppendOnly has no delete to sequence, so
 *      it takes NO TimerPort (the strategy schedules nothing). It does NOT
 *      re-implement any sequencing — the strategy owns the finalize table. This is
 *      the signature the daemon wiring constructs (plus the optional
 *      `signCallbackData` injected later).
 *
 * Quick-Reply approval chips: a `kind:"approval"` frame's opening
 * `send` carries the signed Quick-Reply chips (the `buttons` rows from
 * `buildApprovalButtons` over the renderer-injected `SignCallbackData`); each
 * chip's callback data is the signed wire string `v1.<choice>.<shortId>.<hmac>`
 * (LINE Quick-Reply postback carries it back). The renderer reaches the core HMAC
 * primitive through the injected signer and never imports `@comis/orchestrator`.
 * When the signer is absent, an approval frame degrades to a
 * send-only status; a non-approval frame is always send-only.
 *
 * The channels package depends on core + shared only (no observability substrate),
 * so no diagnostics primitive is reachable here.
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  TimerPort,
  ClockPort,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createAppendOnlyRenderer } from "../shared/strategies/append-only.js";
import {
  buildApprovalButtons,
  type SignCallbackData,
} from "../shared/strategies/approval-render.js";

/**
 * Classify a raw LINE platform error into the closed {@link ActivityRenderError}
 * union. The live adapter wraps send failures in a bare `Error` with no structured
 * numeric code preserved, so this DEFAULTS to `internal` carrying the cause. The
 * error is consulted for NOTHING that reaches the user — it selects the variant
 * only and is never rendered or logged as activity text.
 */
export function classifyLineError(e: unknown): ActivityRenderError {
  // The LINE SDK throw is catch-wrapped into a bare Error with no structured code
  // preserved; there is no reliable structural signal to map a richer variant, so
  // internal is the only branch (KISS — do not invent a rich classifier).
  return { kind: "internal", cause: e };
}

/**
 * Build the {@link ActivityRenderActions} for a LINE chat. `send` posts a plain
 * opening status (no silent effect) and forwards the signed Quick-Reply approval
 * chips when `opts.buttons` is present; `edit` and `delete` are
 * unsupported (LINE is send-only) and return `not_supported` without touching the
 * port. All paths return `Result`; nothing throws across the boundary.
 */
export function makeLineRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  return {
    async send(text, opts): Promise<Result<string, ActivityRenderError>> {
      // Opening status: LINE ignores the silent effect. An approval frame carries
      // the signed Quick-Reply chips (callback_data = v1.<choice>.<shortId>.<hmac>)
      // as the `buttons` rows; the resolution is owned by the
      // InteractiveCallbackRouter, not this renderer. Omit options when there are
      // no chips so a button-less send stays byte-stable.
      const r = await adapter.sendMessage(
        channelId,
        text,
        opts?.buttons !== undefined ? { buttons: opts.buttons } : undefined,
      );
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
 * Create the LINE AppendOnly activity renderer — wires the
 * {@link createAppendOnlyRenderer} with the per-channel render-actions adapter.
 *
 * AppendOnly has no delete to sequence, so there is NO TimerPort — the no-timer
 * rule bans scheduling, NOT a read-only clock for elapsed display. The optional
 * `deps.clock` is forwarded into the strategy and feeds its elapsed-time
 * fallback "(running N s)" when no SEP plan is active; `clock.now()` is
 * consulted ONLY for read-only display arithmetic (no scheduling, no I/O).
 * `timer` is accepted-but-unused to stay structurally assignable to the
 * daemon's uniform `RendererFactory` deps.
 *
 * The daemon composition root constructs this with the chat id and the optional
 * `signCallbackData`. `signCallbackData` is the secret-bound signer: the
 * renderer CONSUMES it to build the signed Quick-Reply approval chips and never
 * imports the orchestrator package. When omitted, an approval frame
 * degrades to a send-only status; the rest of the renderer is unaffected.
 */
export function createLineActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer?: TimerPort; clock?: ClockPort; signCallbackData?: SignCallbackData; markers?: ActivityStatusMarkers } = {},
): ChannelActivityRenderer {
  const { signCallbackData, clock } = deps;
  return createAppendOnlyRenderer({
    actions: makeLineRenderActions(adapter, channelId),
    // Elapsed-fallback wiring: forward the daemon-injected ClockPort into
    // AppendOnly so the strategy can capture startedAtMs on the first apply() and
    // compute elapsedMs for renderFrameText's "(running N s)" fallback. Merely
    // declaring `clock` on the deps shape is not enough — without this forward it
    // is silently inert.
    clock,
    markers: deps.markers,
    // Approval frame → signed Quick-Reply chips. The signer is the only path to
    // `callback_data`; without it, no chips are painted.
    buildButtons:
      signCallbackData === undefined
        ? undefined
        : (events) => events.flatMap((event) => buildApprovalButtons(event, signCallbackData)),
  });
}
