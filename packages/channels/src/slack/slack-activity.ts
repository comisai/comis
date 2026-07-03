// SPDX-License-Identifier: Apache-2.0
/**
 * Slack EditPlace activity renderer.
 *
 * Copies the canonical Telegram shape — only the error classifier
 * differs. Three parts:
 *
 *   1. `classifySlackError` — the per-platform net-new logic. It reads the
 *      STRUCTURAL Slack-Bolt field `e.data.error` (a string) off the error AND
 *      off `error.cause` (the live adapter wraps the Slack error in
 *      `new Error(msg, { cause })` at the edit/delete swallow sites). Slack does
 *      NOT use a numeric code — it carries `data.error` strings: `"ratelimited"`
 *      (+ `retryAfter`) → rate_limited; `"message_not_found"` /
 *      `"cant_update_message"` → not_supported:edit (drop edits);
 *      `"not_in_channel"` / `"cant_delete_message"` → permission. It NEVER parses
 *      the generic "Failed to…" string. `data.error`
 *      is used ONLY to choose the closed `ActivityRenderError` variant — never
 *      rendered or logged as activity text.
 *
 *   2. `makeSlackRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts the placeholder and, on an approval frame, paints the signed Block
 *      Kit `actions` (each element's callback value = the signed callback wire string from
 *      `buildApprovalButtons`, via the renderer-injected `SignCallbackData`); a
 *      subagent placeholder opens a thread (`thread_ts`) for its expand. These
 *      are DISPLAY affordances — resolution is owned by the
 *      InteractiveCallbackRouter, not this renderer. `edit`/`delete` GUARD the
 *      optional `ChannelPort` methods (early `not_supported` — never a non-null
 *      `!` cluster, AGENTS.md §2.8) and map every `.error` through
 *      `classifySlackError`. `delete` is `chat.delete` (the required
 *      delete-on-success op). All paths return `Result`; nothing throws across
 *      the boundary.
 *
 *   3. `createSlackActivityRenderer` — wires the
 *      `createEditPlaceRenderer` (the debounce/edit/delete state machine, which
 *      fires `chat.delete` after `deliveredAtMs` on success). It does NOT
 *      re-implement any rendering logic.
 *
 * 429 backoff (mirrors the Telegram renderer): the channels package depends on
 * `core` + `shared` only — no observability substrate — so the buffer is a LOCAL
 * fixed-cap latest-text slot with a `retryAfterMs`-gated retry through the
 * injected `TimerPort` (the handle is `unref`'d and `cancel()`-able — never a raw
 * timer clear). It coalesces to the latest text and never grows unbounded; a
 * `not_supported` (message-not-found) edit drops all further edits.
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
import {
  buildApprovalButtons,
  type SignCallbackData,
} from "../shared/strategies/approval-render.js";

/**
 * The subagent-expand marker the projection paints into the parent line.
 * When a placeholder send carries it, Slack opens a thread
 * (`thread_ts`) for the expand affordance — a DISPLAY affordance, not a
 * resolution (the InteractiveCallbackRouter owns resolution).
 */
const SUBAGENT_MARKER = "🤖";

/** Structural subset of a Slack-Bolt error the classifier reads (also off `error.cause`). */
interface SlackErrorFields {
  /** The Slack API error string (e.g. "ratelimited", "message_not_found", "not_in_channel"). */
  data?: { error?: string };
  /** Rate-limit backoff in SECONDS (the `Retry-After` header value). */
  retryAfter?: number;
  cause?: unknown;
}

/** Slack `data.error` strings the classifier maps to closed variants. */
const RATE_LIMITED = "ratelimited";
const NOT_EDITABLE = new Set(["message_not_found", "cant_update_message"]);
const PERMISSION = new Set(["not_in_channel", "cant_delete_message"]);

/**
 * Classify a raw Slack platform error into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL `data.error` field. Reads `data.error`/`retryAfter` off
 * the error itself and, when the live adapter wrapped the Slack error in
 * `new Error(msg, { cause })`, off `error.cause`. The string is consulted ONLY to
 * pick the variant — never rendered or logged.
 */
export function classifySlackError(e: unknown): ActivityRenderError {
  const direct = (e ?? {}) as SlackErrorFields;
  // Prefer the typed Slack error the adapter attached as `cause`; fall back to
  // the error object itself (the fake injects the Slack shape directly). "No
  // data.error present" is the signal to unwrap the cause.
  const se: SlackErrorFields =
    direct.data?.error === undefined && direct.cause != null
      ? ((direct.cause as SlackErrorFields) ?? direct)
      : direct;

  const code = se.data?.error;
  if (code === RATE_LIMITED) {
    return { kind: "rate_limited", retryAfterMs: (se.retryAfter ?? 1) * 1000 };
  }
  if (code !== undefined && NOT_EDITABLE.has(code)) {
    return { kind: "not_supported", capability: "edit" };
  }
  if (code !== undefined && PERMISSION.has(code)) {
    return { kind: "permission", detail: code };
  }
  return { kind: "internal", cause: e };
}

/** Optional timer used by the local 429 retry buffer. Omit it and a 429 simply propagates. */
export interface SlackRenderActionsDeps {
  timer?: TimerPort;
}

/** Latest-text retry cap — a 429 storm coalesces to the latest text; we never replay a backlog. */
const MAX_RETRY_ATTEMPTS = 4;

/**
 * Build the {@link ActivityRenderActions} for a Slack channel. `edit`/`delete`
 * guard the optional port methods and classify platform errors structurally;
 * `delete` maps to `chat.delete` (the delete-on-success op). When a `timer`
 * is supplied, a `rate_limited` edit schedules a single bounded retry of the
 * LATEST text.
 */
export function makeSlackRenderActions(
  adapter: ChannelPort,
  channelId: string,
  deps: SlackRenderActionsDeps = {},
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

    const classified = classifySlackError(r.error);
    if (classified.kind === "not_supported") {
      // message_not_found → stop editing entirely.
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
      // Slack has no silent-notification effect. A subagent placeholder opens a
      // thread (thread_ts) for its expand affordance; an approval placeholder
      // carries the signed Block Kit action elements in `buttons` (each element's
      // callback value = v1.<choice>.<shortId>.<hmac>). Both are display
      // affordances — the InteractiveCallbackRouter owns resolution.
      const threadReply = text.includes(SUBAGENT_MARKER);
      const r = await adapter.sendMessage(channelId, text, {
        ...(threadReply ? { threadReply: true } : {}),
        ...(opts?.buttons !== undefined ? { buttons: opts.buttons } : {}),
      });
      return r.ok ? ok(r.value) : err(classifySlackError(r.error));
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      return attemptEdit(id, text);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      cancelRetry();
      pendingText = undefined;
      // chat.delete — the required delete-on-success op (gated on
      // deliveredAtMs by the EditPlace finalize).
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifySlackError(r.error));
    },
  };
}

/**
 * Create the Slack EditPlace activity renderer — wires the
 * {@link createEditPlaceRenderer} with the per-channel render-actions adapter.
 * The daemon composition root constructs this with its runtime `TimerPort` /
 * `ClockPort` and the channel id.
 *
 * `signCallbackData` is the secret-bound signer injected at the composition root:
 * the renderer CONSUMES it to build signed Block Kit action elements and
 * never imports the orchestrator package. When omitted, an
 * approval frame degrades to a button-less text prompt.
 */
export function createSlackActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; signCallbackData?: SignCallbackData; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  const { signCallbackData } = deps;
  return createEditPlaceRenderer({
    actions: makeSlackRenderActions(adapter, channelId, { timer: deps.timer }),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // Approval frame → signed Block Kit action rows. The signer is the only path
    // to the callback value; without it, no actions are painted.
    buildButtons:
      signCallbackData === undefined
        ? undefined
        : (events) => events.flatMap((event) => buildApprovalButtons(event, signCallbackData)),
  });
}
