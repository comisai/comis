// SPDX-License-Identifier: Apache-2.0
/**
 * Signal DeleteAndRepost activity renderer.
 * Signal is the ONLY one of the 5 non-EditPlace channels
 * with a real `deleteMessage`, so this is the canonical DeleteAndRepost wiring
 * the strategy was designed for. Three parts, copying the established
 * `make<Ch>RenderActions` / `classify<Ch>Error` / `create<Ch>ActivityRenderer`
 * shape (whatsapp-activity.ts is the closest structural analog — `buttons:"none"`,
 * no rich effect, thin wiring):
 *
 *   1. `classifySignalError` — the single net-new piece of logic here. Signal
 *      exposes NO structured numeric error code for send/delete failures: the
 *      live adapter returns `err(result.error)`, a raw signal-cli JSON-RPC
 *      `Error`. There is no reliable structural signal to disambiguate a
 *      retryable/permission case, so the classifier DEFAULTS to
 *      `{kind:"internal", cause:e}` (KISS — no invented rich
 *      classifier). The raw RPC error `.message` is read for NOTHING
 *      user-facing — it selects the variant only and is NEVER rendered or logged
 *      as activity text. The S4 fixture proves the failure text is
 *      `❌ {errorKind}` (from `failureLabel`), not the RPC body.
 *
 *   2. `makeSignalRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts a plain message via `adapter.sendMessage` (NO silent effect — Signal
 *      ignores it; NO buttons — `buttons:"none"`). `edit` returns
 *      `not_supported:edit` immediately — Signal has no in-place edit and the
 *      live adapter exposes no `editMessage` (a guard, never `adapter.editMessage!`
 *      — AGENTS.md §2.8). `delete` GUARDS the OPTIONAL `ChannelPort.deleteMessage`
 *      (early `not_supported` — never a non-null-asserted call) and maps the
 *      `.error` through `classifySignalError`. All paths return `Result`; nothing
 *      throws across the boundary.
 *
 *   3. `createSignalActivityRenderer` — wires the
 *      {@link createDeleteAndRepostRenderer} (the delete-prev + post-new state
 *      machine; success deletes the last activity after `deliveredAtMs`; failure
 *      deletes the running activity then posts a KEPT ❌). It does NOT
 *      re-implement any sequencing — the strategy owns the finalize table.
 *
 * Unlike the Telegram/Discord/Slack EditPlace renderers there is NO local 429
 * retry buffer: signal-cli surfaces no rate-limit/retry-after for send/delete,
 * and the DeleteAndRepost timer is the strategy body's own unref'd handle — this
 * file adds no raw timer. The channels package depends on core + shared only (no
 * observability substrate), so no diagnostics primitive is reachable here.
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
import { createDeleteAndRepostRenderer } from "../shared/strategies/delete-and-repost.js";
import { buildApprovalPrompt } from "../shared/strategies/approval-render.js";

/**
 * Classify a raw Signal platform error into the closed {@link ActivityRenderError}
 * union. Signal's send/delete failures arrive as a raw signal-cli JSON-RPC
 * `Error` with no structured numeric code to read, so this DEFAULTS to `internal`
 * carrying the cause. The error is consulted for NOTHING that reaches the user —
 * it selects the variant only and is never rendered or logged as activity text.
 */
export function classifySignalError(e: unknown): ActivityRenderError {
  // signal-cli offers no structured code for these ops; there is no reliable
  // structural signal to map a richer variant, so internal is the only branch
  // (KISS — do not invent a rich classifier on an unstructured RPC error).
  return { kind: "internal", cause: e };
}

/**
 * Build the {@link ActivityRenderActions} for a Signal chat. `send` posts a plain
 * message (no silent effect, no buttons); `edit` is unsupported (Signal has no
 * in-place edit); `delete` guards the optional port method and classifies
 * platform errors structurally. All paths return `Result`; nothing throws across
 * the boundary.
 */
export function makeSignalRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  return {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      // Plain message per transition: Signal ignores the silent effect and has no
      // button surface, so send carries no options.
      const r = await adapter.sendMessage(channelId, text);
      return r.ok ? ok(r.value) : err(classifySignalError(r.error));
    },

    async edit(_id, _text): Promise<Result<void, ActivityRenderError>> {
      // Signal has no in-place edit — the live adapter exposes no editMessage.
      // DeleteAndRepost never calls this, but the port contract requires it; an
      // early not_supported is the honest answer (never `adapter.editMessage!`).
      return err({ kind: "not_supported", capability: "edit" });
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifySignalError(r.error));
    },
  };
}

/**
 * Create the Signal DeleteAndRepost activity renderer — wires the
 * {@link createDeleteAndRepostRenderer} with the per-channel render-actions
 * adapter. The daemon composition root constructs this with its runtime
 * `TimerPort` / `ClockPort` and the chat id; the `{timer, clock}` gate
 * the deliveredAt-timed success delete.
 */
export function createSignalActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  return createDeleteAndRepostRenderer({
    actions: makeSignalRenderActions(adapter, channelId),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // Signal has no button surface, so an approval frame appends the plain-text
    // prompt ("Reply approve or deny …", with shortIds when >1 pending) to the
    // reposted message. A non-approval frame yields "" (no append).
    buildPrompt: buildApprovalPrompt,
  });
}
