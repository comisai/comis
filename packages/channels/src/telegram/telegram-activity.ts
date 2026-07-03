// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram EditPlace activity renderer.
 *
 * This is the canonical reference the other 3 EditPlace channels (Discord,
 * Slack, WhatsApp) copy. It has three parts:
 *
 *   1. `classifyTelegramError` — the single net-new piece of logic here.
 *      It reads STRUCTURAL `GrammyError` fields (`error_code`,
 *      `parameters.retry_after`, and `description` ONLY to disambiguate the
 *      message-not-found case) to choose one of the closed `ActivityRenderError`
 *      variants. It NEVER parses the generic "Failed to…" string the live
 *      adapter wraps the error in — the adapter attaches the original
 *      GrammyError as `error.cause`, which the classifier reads structurally.
 *      The `description` selects the variant only; it is never
 *      rendered or logged as activity text.
 *
 *   2. `makeTelegramRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      passes `{effects:["silent"]}` so the existing outbound path sets
 *      `disable_notification:true` (no new adapter code). `edit`/`delete` GUARD
 *      the OPTIONAL `ChannelPort` methods (early `not_supported` — never a
 *      non-null-asserted call, AGENTS.md §2.8) and map every
 *      `.error` through `classifyTelegramError`. All paths return `Result`;
 *      nothing throws across the boundary.
 *
 *   3. `createTelegramActivityRenderer` — wires the
 *      `createEditPlaceRenderer` (the debounce/edit/delete state machine). It
 *      does NOT re-implement any rendering logic.
 *
 * 429 backoff: the channels package depends on `core` and
 * `shared` only — no observability substrate — so a shared bounded-queue helper
 * is unreachable here. The 429 buffer is a LOCAL fixed-cap latest-text slot with
 * a `retryAfterMs`-gated retry through the injected `TimerPort` (the retry handle
 * is `unref`'d and `cancel()`-able — never a raw timer clear). It coalesces to the
 * latest text and never grows unbounded. A `not_supported` (message-not-found)
 * edit drops all further edits.
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  TimerPort,
  TimerHandle,
  ClockPort,
  RichButton,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createEditPlaceRenderer } from "../shared/strategies/edit-place.js";
import {
  buildApprovalButtons,
  type SignCallbackData,
} from "../shared/strategies/approval-render.js";
import { validateCallbackDataWithinBudget } from "./rich-renderer.js";

/** Structural subset of a `GrammyError` the classifier reads (also matched on `error.cause`). */
interface GrammyErrorFields {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
  cause?: unknown;
}

/** Telegram "this message can no longer be edited" descriptions (400 family). */
const MESSAGE_NOT_EDITABLE = /message (to edit )?not found|message can.?t be edited/i;

/**
 * Classify a raw Telegram platform error into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL fields. Reads `error_code`/`parameters` off the error
 * itself and, when the live adapter wrapped the `GrammyError` in
 * `new Error(msg, { cause })`, off `error.cause`. The `description` is consulted
 * ONLY to pick the message-not-found variant — never rendered or logged.
 */
export function classifyTelegramError(e: unknown): ActivityRenderError {
  const direct = (e ?? {}) as GrammyErrorFields;
  // Prefer the typed GrammyError the adapter attached as `cause`; fall back to
  // the error object itself (the fake injects the GrammyError shape directly).
  const ge: GrammyErrorFields =
    direct.error_code === undefined && direct.cause != null
      ? ((direct.cause as GrammyErrorFields) ?? direct)
      : direct;

  if (ge.error_code === 429) {
    return { kind: "rate_limited", retryAfterMs: (ge.parameters?.retry_after ?? 1) * 1000 };
  }
  if (ge.error_code === 400 && MESSAGE_NOT_EDITABLE.test(ge.description ?? "")) {
    return { kind: "not_supported", capability: "edit" };
  }
  if (ge.error_code === 403) {
    return { kind: "permission", detail: ge.description ?? "forbidden" };
  }
  return { kind: "internal", cause: e };
}

/** Optional timer used by the local 429 retry buffer. Omit it and a 429 simply propagates. */
export interface TelegramRenderActionsDeps {
  timer?: TimerPort;
}

/** Latest-text retry cap — a 429 storm coalesces to the latest text; we never replay a backlog. */
const MAX_RETRY_ATTEMPTS = 4;

/**
 * Build the {@link ActivityRenderActions} for a Telegram chat. `send` carries the
 * silent effect; `edit`/`delete` guard the optional port methods and classify
 * platform errors structurally. When a `timer` is supplied, a `rate_limited`
 * edit schedules a single bounded retry of the LATEST text.
 */
export function makeTelegramRenderActions(
  adapter: ChannelPort,
  channelId: string,
  deps: TelegramRenderActionsDeps = {},
): ActivityRenderActions {
  const { timer } = deps;

  // --- Local bounded 429 buffer (single latest-text slot + single retry) ---
  /** The latest text awaiting a rate-limit retry (latest-wins; bounded to one slot). */
  let pendingText: string | undefined;
  /** The id of the message being edited under backoff. */
  let pendingId: string | undefined;
  /** The single in-flight retry timer; cancelled + rescheduled via handle.cancel(). */
  let retryHandle: TimerHandle | undefined;
  /** Consecutive retry attempts; caps the backoff so a sustained 429 cannot loop forever. */
  let retryAttempts = 0;
  /** Set once a message-not-found is seen — all further edits are dropped (drop-on-not_supported policy). */
  let editsDropped = false;

  function cancelRetry(): void {
    if (retryHandle && !retryHandle.cancelled) retryHandle.cancel();
    retryHandle = undefined;
  }

  // Perform one edit attempt, applying the 429 buffer + drop-on-not_supported policy.
  async function attemptEdit(id: string, text: string): Promise<Result<void, ActivityRenderError>> {
    if (editsDropped) return err({ kind: "not_supported", capability: "edit" });
    if (!adapter.editMessage) return err({ kind: "not_supported", capability: "edit" });

    const r = await adapter.editMessage(channelId, id, text);
    if (r.ok) {
      // Success: any pending backoff is satisfied by the latest send.
      cancelRetry();
      pendingText = undefined;
      retryAttempts = 0;
      return ok(undefined);
    }

    const classified = classifyTelegramError(r.error);
    if (classified.kind === "not_supported") {
      // Message can no longer be edited → stop editing entirely.
      editsDropped = true;
      cancelRetry();
      pendingText = undefined;
      return err(classified);
    }
    if (classified.kind === "rate_limited" && timer !== undefined) {
      // Coalesce to the latest text in the single slot and schedule ONE retry.
      // Pass the narrowed timer so scheduleRetry needs no undefined guard.
      pendingText = text;
      pendingId = id;
      scheduleRetry(timer, classified.retryAfterMs);
    }
    return err(classified);
  }

  function scheduleRetry(t: TimerPort, retryAfterMs: number): void {
    if (retryAttempts >= MAX_RETRY_ATTEMPTS) {
      // Bounded: give up replaying after the cap; the buffer never grows.
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
      // Defensive: a delete/success between scheduling and firing clears the slot.
      if (text === undefined || id === undefined || editsDropped) return;
      void attemptEdit(id, text);
    }, retryAfterMs);
    // Never hold the event loop open for a retry at shutdown.
    retryHandle.unref();
  }

  return {
    async send(text, opts): Promise<Result<string, ActivityRenderError>> {
      // An approval placeholder carries the signed inline-keyboard buttons
      // (callback_data = v1.<choice>.<shortId>.<hmac>); the adapter maps them via
      // renderTelegramButtons. The silent effect is preserved. Resolution is
      // owned by the InteractiveCallbackRouter, not this renderer.
      const r = await adapter.sendMessage(channelId, text, {
        effects: ["silent"],
        ...(opts?.buttons !== undefined ? { buttons: opts.buttons } : {}),
      });
      return r.ok ? ok(r.value) : err(classifyTelegramError(r.error));
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      return attemptEdit(id, text);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      // A delete supersedes any pending edit retry.
      cancelRetry();
      pendingText = undefined;
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifyTelegramError(r.error));
    },
  };
}

/**
 * Drop any over-budget callback button BEFORE it reaches the adapter.
 *
 * `renderTelegramButtons` is the adapter-side budget guard, but filtering
 * here keeps the renderer's emitted rows honest: a >64-byte `callback_data` is
 * OMITTED (refuse-loud), never truncated — truncation would corrupt the signed
 * HMAC. The worst-case real signed payload is ~40 bytes, so this never fires in
 * practice; it is defense-in-depth.
 */
function omitOverBudgetButtons(rows: RichButton[][]): RichButton[][] {
  return rows.map((row) =>
    row.filter((btn) => {
      if (btn.callback_data === undefined) return true;
      return validateCallbackDataWithinBudget(btn.callback_data).ok;
    }),
  );
}

/**
 * Create the Telegram EditPlace activity renderer — wires the
 * {@link createEditPlaceRenderer} with the per-channel render-actions adapter.
 * The daemon composition root constructs this with its runtime `TimerPort` /
 * `ClockPort` and the chat id.
 *
 * `signCallbackData` is the secret-bound signer injected at the composition root:
 * the renderer CONSUMES it to build the signed inline keyboard and never
 * imports the orchestrator package. When omitted, an
 * approval frame degrades to a button-less text prompt.
 */
export function createTelegramActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; signCallbackData?: SignCallbackData; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  const { signCallbackData } = deps;
  return createEditPlaceRenderer({
    actions: makeTelegramRenderActions(adapter, channelId, { timer: deps.timer }),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // Approval frame → signed inline-keyboard rows (rendered to a grammY
    // InlineKeyboard by renderTelegramButtons in the adapter). Over-budget
    // buttons are omitted here too (never truncated).
    buildButtons:
      signCallbackData === undefined
        ? undefined
        : (events) =>
            omitOverBudgetButtons(
              events.flatMap((event) => buildApprovalButtons(event, signCallbackData)),
            ),
  });
}
