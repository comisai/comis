// SPDX-License-Identifier: Apache-2.0
/**
 * IRC LinePerEvent activity renderer.
 * IRC is text-only — no in-place edit, no delete, a hard per-line character
 * cap. Three parts, copying the non-EditPlace
 * `make<Ch>RenderActions` / `classify<Ch>Error` / `create<Ch>ActivityRenderer`
 * shape (signal-activity.ts / whatsapp-activity.ts are the structural analogs —
 * `buttons:"none"`, no rich effect, thin wiring):
 *
 *   1. `classifyIrcError` — the single net-new piece of logic here. IRC's live
 *      adapter wraps send failures in `new Error("Failed to send IRC message: …")`
 *      with NO structured numeric code, so there is no reliable structural signal
 *      to disambiguate a richer variant; the classifier DEFAULTS to
 *      `{kind:"internal", cause:e}` (KISS — no invented rich
 *      classifier). The wrapped error is read for NOTHING
 *      user-facing — it selects the variant only and is NEVER rendered or logged
 *      as activity text. The S4 fixture proves the failure line is
 *      `[ERR] {errorKind}` (from the strategy), not the platform error body.
 *
 *   2. `makeIrcRenderActions` — the `ActivityRenderActions` adapter. `send` posts
 *      a plain line via `adapter.sendMessage` (NO silent effect — IRC has no rich
 *      effects; NO buttons — `buttons:"none"`). `edit` AND `delete` return
 *      `not_supported` immediately — IRC supports neither and the live adapter
 *      exposes no `editMessage`/`deleteMessage` (an honest early return, never
 *      `adapter.editMessage!` — AGENTS.md §2.8). All paths return `Result`;
 *      nothing throws across the boundary.
 *
 *   3. `createIrcActivityRenderer` — wires the
 *      {@link createLinePerEventRenderer} (one capped line per
 *      `frame.changeSet.added` event; a closing `✓ done · N steps · Xs` on a
 *      non-trivial success — elapsed via the injected clock — or `[ERR] {errorKind}`
 *      on failure; the success/failure glyph follows the resolved theme `markers`,
 *      omitting them yields those defaults). The per-line character cap
 *      + ellipsis truncation and the
 *      closing-summary logic live IN the strategy body; this file re-implements
 *      none of it. The `↳ ` subagent depth prefix is DATA
 *      carried on the event's `defaultLabel` (set upstream by the projection) and
 *      painted verbatim by `eventLabel` — the renderer adds no prefix.
 *
 * NOTE the factory signature is `(adapter, channelId, { clock })` — clock ONLY,
 * NO timer. LinePerEvent needs the clock for the elapsed-time suffix
 * but schedules nothing, so it takes `{ actions, clock? }`. The channels package
 * depends on core + shared only (no diagnostics substrate is reachable here).
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  ClockPort,
  ActivityEvent,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createLinePerEventRenderer } from "../shared/strategies/line-per-event.js";
import { eventLabel, subagentLine } from "../shared/strategies/render.js";
import {
  buildApprovalText,
  countPendingApprovals,
} from "../shared/strategies/approval-render.js";

/**
 * Classify a raw IRC platform error into the closed {@link ActivityRenderError}
 * union. IRC's send failures arrive wrapped as
 * `new Error("Failed to send IRC message: …")` with no structured numeric code to
 * read, so this DEFAULTS to `internal` carrying the cause. The error is consulted
 * for NOTHING that reaches the user — it selects the variant only and is never
 * rendered or logged as activity text.
 */
export function classifyIrcError(e: unknown): ActivityRenderError {
  // IRC offers no structured code for send failures; there is no reliable
  // structural signal to map a richer variant, so internal is the only branch
  // (KISS — do not invent a rich classifier on a wrapped send error).
  return { kind: "internal", cause: e };
}

/**
 * Build the {@link ActivityRenderActions} for an IRC channel. `send` posts a plain
 * line (no silent effect, no buttons); `edit` and `delete` are both unsupported
 * (IRC is text-only — no in-place edit, no delete). All paths return `Result`;
 * nothing throws across the boundary.
 */
export function makeIrcRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  return {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      // Plain line per event: IRC has no rich effects and no button surface, so
      // send carries no options.
      const r = await adapter.sendMessage(channelId, text);
      return r.ok ? ok(r.value) : err(classifyIrcError(r.error));
    },

    async edit(_id, _text): Promise<Result<void, ActivityRenderError>> {
      // IRC has no in-place edit — the live adapter exposes no editMessage.
      // LinePerEvent never calls this, but the port contract requires it; an early
      // not_supported is the honest answer (never `adapter.editMessage!`).
      return err({ kind: "not_supported", capability: "edit" });
    },

    async delete(_id): Promise<Result<void, ActivityRenderError>> {
      // IRC cannot delete a sent line — the live adapter exposes no deleteMessage.
      // Unconditional not_supported (never `adapter.deleteMessage!`).
      return err({ kind: "not_supported", capability: "delete" });
    },
  };
}

/**
 * The IRC subagent depth prefix. IRC has no thread primitive, so a
 * `kind:"subagent"` event renders INLINE with this prefix; the `🤖`/agentId portion
 * rides on the projection's `defaultLabel` and is painted verbatim after it.
 */
const SUBAGENT_DEPTH_PREFIX = "↳ ";

/**
 * Build one IRC line for an event, the {@link createLinePerEventRenderer} `lineFor`
 * override. IRC has no button surface, so a
 * `kind:"approval"` event renders the plain-text prompt
 * `buildApprovalText(event, { includeShortId })` — the shortId form only when MORE
 * THAN ONE approval is pending in the same frame (so the user's reply, parsed by
 * the router's plain-text branch, is unambiguous). A
 * `kind:"subagent"` event renders with a `↳ ` depth prefix via `subagentLine`.
 * Everything else keeps the redacted `eventLabel`. No signing — HMAC is skipped for
 * plaintext prompts; the router scopes replies to `pendingForSession`.
 */
export function ircLineFor(
  event: ActivityEvent,
  visibleEvents: readonly ActivityEvent[],
): string {
  if (event.kind === "approval") {
    return buildApprovalText(event, {
      includeShortId: countPendingApprovals(visibleEvents) > 1,
    });
  }
  if (event.kind === "subagent") {
    return subagentLine(event, { depthPrefix: SUBAGENT_DEPTH_PREFIX });
  }
  return eventLabel(event);
}

/**
 * Create the IRC LinePerEvent activity renderer — wires the
 * {@link createLinePerEventRenderer} with the per-channel render-actions adapter.
 * The daemon composition root constructs this with its runtime `ClockPort` and the
 * channel id; the `{clock}` feeds ONLY the elapsed-time suffix on the
 * success closing line — LinePerEvent schedules nothing, so there is NO timer.
 *
 * The `lineFor` override paints the plain-text approval prompt and the
 * `↳ ` subagent inline — IRC's button-less, thread-less form.
 */
export function createIrcActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { clock: ClockPort; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  return createLinePerEventRenderer({
    actions: makeIrcRenderActions(adapter, channelId),
    clock: deps.clock,
    // Forward the resolved theme markers so the closing success/failure
    // glyphs follow the operator theme; omitting them keeps the `✓`/`[ERR]`
    // defaults byte-identical to the prior output.
    markers: deps.markers,
    lineFor: ircLineFor,
  });
}
