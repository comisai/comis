// SPDX-License-Identifier: Apache-2.0
/**
 * IRC LinePerEvent activity renderer (CHAN-09; §7.2 / §18.3 row "LinePerEvent").
 * IRC is text-only — no in-place edit, no delete, a hard per-line character cap
 * (§7.1). Three parts, copying the Phase-72 non-EditPlace
 * `make<Ch>RenderActions` / `classify<Ch>Error` / `create<Ch>ActivityRenderer`
 * shape (signal-activity.ts / whatsapp-activity.ts are the structural analogs —
 * `buttons:"none"`, no rich effect, thin wiring):
 *
 *   1. `classifyIrcError` — the single net-new piece of logic here. IRC's live
 *      adapter wraps send failures in `new Error("Failed to send IRC message: …")`
 *      with NO structured numeric code, so there is no reliable structural signal
 *      to disambiguate a richer variant; the classifier DEFAULTS to
 *      `{kind:"internal", cause:e}` (KISS — Pitfall 4; no invented rich
 *      classifier). SEC-05/§19.3: the wrapped error is read for NOTHING
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
 *   3. `createIrcActivityRenderer` — wires the Phase-70
 *      {@link createLinePerEventRenderer} (one capped line per
 *      `frame.changeSet.added` event; a closing `✓ done · N steps · Xs` on a
 *      non-trivial success — elapsed via the injected clock — or `[ERR] {errorKind}`
 *      on failure). The per-line character cap + ellipsis truncation and the
 *      closing-summary logic live IN the strategy body; this file re-implements
 *      none of it. The `↳ ` subagent depth prefix is DATA
 *      carried on the event's `defaultLabel` (set upstream by the projection) and
 *      painted verbatim by `eventLabel` — the renderer adds no prefix.
 *
 * NOTE the factory signature is `(adapter, channelId, { clock })` — clock ONLY,
 * NO timer (Pitfall 5). LinePerEvent needs the clock for the elapsed-time suffix
 * but schedules nothing, so it takes `{ actions, clock? }`. The channels package
 * depends on core + shared only (no diagnostics substrate is reachable here).
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  ClockPort,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createLinePerEventRenderer } from "../shared/strategies/line-per-event.js";

/**
 * Classify a raw IRC platform error into the closed {@link ActivityRenderError}
 * union. IRC's send failures arrive wrapped as
 * `new Error("Failed to send IRC message: …")` with no structured numeric code to
 * read, so this DEFAULTS to `internal` carrying the cause. The error is consulted
 * for NOTHING that reaches the user — it selects the variant only and is never
 * rendered or logged as activity text (SEC-05/§19.3, T-72-03-01).
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
 * Create the IRC LinePerEvent activity renderer — wires the Phase-70
 * {@link createLinePerEventRenderer} with the per-channel render-actions adapter.
 * The daemon composition root constructs this with its runtime `ClockPort` and the
 * channel id (WIRE-02); the `{clock}` feeds ONLY the elapsed-time suffix on the
 * success closing line — LinePerEvent schedules nothing, so there is NO timer.
 * This is the signature the 72-05 wiring constructs.
 */
export function createIrcActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { clock: ClockPort },
): ChannelActivityRenderer {
  return createLinePerEventRenderer({
    actions: makeIrcRenderActions(adapter, channelId),
    clock: deps.clock,
  });
}
