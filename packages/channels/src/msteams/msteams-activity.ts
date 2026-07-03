// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams EditPlace activity renderer.
 *
 * Structurally mirrors the Slack renderer — only the error classifier differs.
 * Three parts:
 *
 *   1. `classifyMSTeamsError` — the per-platform net-new logic. It maps a
 *      Bot Framework Connector failure onto the CLOSED `ActivityRenderError`
 *      union — never the send-path observability error taxonomy, which reports
 *      `errorKind` / `retryable` for logging rather than a render variant. It
 *      reads the STRUCTURAL numeric `status` (and an
 *      optional `retryAfter` in seconds) off the error itself and — when the
 *      adapter wrapped the failure in `new Error(msg, { cause })` — off
 *      `error.cause`. The Connector edit/delete failure branch attaches
 *      `{ status, retryAfter? }` to the returned Error so this classifier can
 *      pick the variant and the retry buffer can back off; the status is
 *      consulted ONLY to choose the variant — never rendered or logged as
 *      activity text, and no token/header/body is copied into the payload.
 *      Mapping: `429` → rate_limited; `401`/`403` → permission; `404` (activity
 *      gone) → not_supported:edit (drop edits); anything else → internal.
 *
 *   2. `makeMSTeamsRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts the placeholder (plain text; no native buttons in this phase).
 *      `edit`/`delete` GUARD the optional `ChannelPort` methods (early
 *      `not_supported` — never a non-null `!` cluster) and map every `.error`
 *      through `classifyMSTeamsError`. `delete` is the required delete-on-success
 *      op. All paths return `Result`; nothing throws across the boundary.
 *
 *   3. `createMSTeamsActivityRenderer` — wires the shared
 *      `createEditPlaceRenderer` (the debounce / edit / delete-after-delivery
 *      state machine). It does NOT re-implement any rendering logic.
 *
 * 429 backoff (mirrors the Slack renderer): the channels package depends on
 * `core` + `shared` only — no observability substrate — so the buffer is a LOCAL
 * fixed-cap latest-text slot with a `retryAfterMs`-gated retry through the
 * injected `TimerPort` (the handle is `unref`'d and `cancel()`-able — never a raw
 * timer clear). It coalesces to the latest text and never grows unbounded; a
 * `not_supported` (activity-gone) edit drops all further edits.
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  TimerPort,
  TimerHandle,
  ClockPort,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createEditPlaceRenderer } from "../shared/strategies/edit-place.js";
import type { SignCallbackData } from "../shared/strategies/approval-render.js";

/** Structural subset of a Connector error the classifier reads (also off `error.cause`). */
interface MsTeamsErrorFields {
  /** The HTTP status of the Connector response (e.g. 429, 401, 404). */
  status?: number;
  /** Rate-limit backoff in SECONDS (the `Retry-After` header value). */
  retryAfter?: number;
  cause?: unknown;
}

/**
 * Classify a raw Connector failure into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL numeric `status`. Reads `status`/`retryAfter` off the
 * error itself and, when the adapter wrapped the failure in
 * `new Error(msg, { cause })`, off `error.cause`. The status is consulted ONLY
 * to pick the variant — never rendered or logged, and no token/body is copied in.
 */
export function classifyMSTeamsError(e: unknown): ActivityRenderError {
  const direct = (e ?? {}) as MsTeamsErrorFields;
  // Prefer the status attached directly; when absent, unwrap the cause the
  // adapter attached (`new Error(msg, { cause })`).
  const te: MsTeamsErrorFields =
    direct.status === undefined && direct.cause != null
      ? ((direct.cause as MsTeamsErrorFields) ?? direct)
      : direct;

  const status = te.status;
  if (status === 429) {
    return { kind: "rate_limited", retryAfterMs: (te.retryAfter ?? 1) * 1000 };
  }
  if (status === 401 || status === 403) {
    // Content-free: only the numeric status, never a token/header/body.
    return { kind: "permission", detail: `connector status ${status}` };
  }
  if (status === 404) {
    // The activity is gone — stop editing entirely.
    return { kind: "not_supported", capability: "edit" };
  }
  return { kind: "internal", cause: e };
}

/** Optional timer used by the local 429 retry buffer. Omit it and a 429 simply propagates. */
export interface MSTeamsRenderActionsDeps {
  timer?: TimerPort;
}

/** Latest-text retry cap — a 429 storm coalesces to the latest text; we never replay a backlog. */
const MAX_RETRY_ATTEMPTS = 4;

/**
 * Build the {@link ActivityRenderActions} for a Teams conversation. `edit`/`delete`
 * guard the optional port methods and classify Connector errors structurally;
 * `delete` is the delete-on-success op. When a `timer` is supplied, a
 * `rate_limited` edit schedules a single bounded retry of the LATEST text.
 */
export function makeMSTeamsRenderActions(
  adapter: ChannelPort,
  channelId: string,
  deps: MSTeamsRenderActionsDeps = {},
): ActivityRenderActions {
  const { timer } = deps;

  // --- Local bounded 429 buffer (single latest-text slot + single retry) ---
  let pendingText: string | undefined;
  let pendingId: string | undefined;
  let retryHandle: TimerHandle | undefined;
  let retryAttempts = 0;
  let editsDropped = false;

  function cancelRetry(): void {
    if (retryHandle && !retryHandle.cancelled) retryHandle.cancel();
    retryHandle = undefined;
  }

  async function attemptEdit(id: string, text: string): Promise<Result<void, ActivityRenderError>> {
    if (editsDropped) return err({ kind: "not_supported", capability: "edit" });
    if (!adapter.editMessage) return err({ kind: "not_supported", capability: "edit" });

    const r = await adapter.editMessage(channelId, id, text);
    if (r.ok) {
      cancelRetry();
      pendingText = undefined;
      retryAttempts = 0;
      return ok(undefined);
    }

    const classified = classifyMSTeamsError(r.error);
    if (classified.kind === "not_supported") {
      // Activity gone → stop editing entirely.
      editsDropped = true;
      cancelRetry();
      pendingText = undefined;
      return err(classified);
    }
    if (classified.kind === "rate_limited" && timer !== undefined) {
      pendingText = text;
      pendingId = id;
      scheduleRetry(timer, classified.retryAfterMs);
    }
    return err(classified);
  }

  function scheduleRetry(t: TimerPort, retryAfterMs: number): void {
    if (retryAttempts >= MAX_RETRY_ATTEMPTS) {
      cancelRetry();
      pendingText = undefined;
      return;
    }
    cancelRetry();
    retryAttempts += 1;
    retryHandle = t.setTimeout(() => {
      const text = pendingText;
      const id = pendingId;
      retryHandle = undefined;
      if (text === undefined || id === undefined || editsDropped) return;
      void attemptEdit(id, text);
    }, retryAfterMs);
    retryHandle.unref();
  }

  return {
    async send(text, opts): Promise<Result<string, ActivityRenderError>> {
      // Plain-text placeholder. Buttons are forwarded when present so the
      // actions contract stays faithful, but this renderer paints none (no
      // signer is wired), so a Teams placeholder is a bare text activity.
      const r = await adapter.sendMessage(
        channelId,
        text,
        opts?.buttons !== undefined ? { buttons: opts.buttons } : undefined,
      );
      return r.ok ? ok(r.value) : err(classifyMSTeamsError(r.error));
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      return attemptEdit(id, text);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      cancelRetry();
      pendingText = undefined;
      // The required delete-on-success op (gated on deliveredAtMs by the
      // EditPlace finalize).
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifyMSTeamsError(r.error));
    },
  };
}

/**
 * Create the Teams EditPlace activity renderer — wires the
 * {@link createEditPlaceRenderer} with the per-conversation render-actions
 * adapter. The daemon composition root constructs this with its runtime
 * `TimerPort` / `ClockPort` and the conversation id.
 *
 * `signCallbackData` is accepted so this factory's signature stays uniform with
 * the other edit-capable channel renderers (a shared factory-map slot). This
 * renderer is plain text: it paints no native buttons, so `buildButtons` is
 * `undefined` and the signer is not consumed here.
 */
export function createMSTeamsActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; signCallbackData?: SignCallbackData; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  return createEditPlaceRenderer({
    actions: makeMSTeamsRenderActions(adapter, channelId, { timer: deps.timer }),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // Plain-text: no native approval buttons are painted.
    buildButtons: undefined,
  });
}
