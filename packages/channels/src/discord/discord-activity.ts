// SPDX-License-Identifier: Apache-2.0
/**
 * Discord EditPlace activity renderer.
 *
 * Copies the canonical Telegram shape — only the error classifier and
 * the subagent thread-affordance differ. Three parts:
 *
 *   1. `classifyDiscordError` — the per-platform net-new logic. It reads the
 *      STRUCTURAL `DiscordAPIError` fields (`.code`, `.status`, `.retryAfter`)
 *      off the error AND off `error.cause` (the live adapter wraps the
 *      DiscordAPIError in `new Error(msg, { cause })` at the edit/delete swallow
 *      sites). discord.js uses a numeric `.code` (10008 Unknown Message → drop
 *      edits; 50013 Missing Permissions → permission) and surfaces HTTP-429 via
 *      `RateLimitError.retryAfter` / `.status === 429`. It NEVER parses the
 *      generic "Failed to…" string. The `.code` /
 *      `.message` is used ONLY to choose the closed `ActivityRenderError`
 *      variant — never rendered or logged as activity text.
 *
 *   2. `makeDiscordRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      surfaces the subagent thread-expand AFFORDANCE SHELL: when the placeholder
 *      text carries the subagent marker it requests `{ threadReply: true }` so
 *      the adapter creates a public thread (discord-adapter.ts:399-411). This is
 *      a DISPLAY affordance only — it registers NO interaction handler and signs
 *      no interaction payload; the signed-callback router lives in a separate
 *      component. `edit`/`delete` GUARD the optional `ChannelPort`
 *      methods (early `not_supported` — never a non-null `!` cluster, AGENTS.md
 *      §2.8) and map every `.error` through `classifyDiscordError`. All paths
 *      return `Result`; nothing throws across the boundary.
 *
 *   3. `createDiscordActivityRenderer` — wires the
 *      `createEditPlaceRenderer` (the debounce/edit/delete state machine). It
 *      does NOT re-implement any rendering logic.
 *
 * 429 backoff: the channels package depends on
 * `core` + `shared` only — no observability substrate — so the buffer is a LOCAL
 * fixed-cap latest-text slot with a `retryAfterMs`-gated retry through the
 * injected `TimerPort` (the handle is `unref`'d and `cancel()`-able — never a raw
 * timer clear). It coalesces to the latest text and never grows unbounded; a
 * `not_supported` (Unknown Message) edit drops all further edits.
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

/** Structural subset of a `DiscordAPIError` / `RateLimitError` the classifier reads (also off `error.cause`). */
interface DiscordErrorFields {
  /** discord.js numeric API error code (e.g. 10008 Unknown Message, 50013 Missing Permissions). */
  code?: number;
  /** HTTP status (429 for rate limits). */
  status?: number;
  /** RateLimitError backoff in SECONDS. */
  retryAfter?: number;
  message?: string;
  cause?: unknown;
}

/** discord.js API error codes the classifier maps to closed variants. */
const CODE_UNKNOWN_MESSAGE = 10008; // → not_supported:edit (drop further edits)
const CODE_MISSING_PERMISSIONS = 50013; // → permission

/**
 * Classify a raw Discord platform error into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL fields. Reads `code`/`status`/`retryAfter` off the error
 * itself and, when the live adapter wrapped the `DiscordAPIError` in
 * `new Error(msg, { cause })`, off `error.cause`. The `.code` / `.message` is
 * consulted ONLY to pick the variant — never rendered or logged.
 */
export function classifyDiscordError(e: unknown): ActivityRenderError {
  const direct = (e ?? {}) as DiscordErrorFields;
  // Prefer the typed DiscordAPIError the adapter attached as `cause`; fall back
  // to the error object itself (the fake injects the DiscordAPIError shape
  // directly). "No structural field present" is the signal to unwrap the cause.
  const hasField =
    direct.code !== undefined || direct.status !== undefined || direct.retryAfter !== undefined;
  const de: DiscordErrorFields =
    !hasField && direct.cause != null ? ((direct.cause as DiscordErrorFields) ?? direct) : direct;

  // Terminal API-code classification takes precedence: a coded DiscordAPIError is
  // NEVER a rate limit. discord.js models rate limits as a distinct
  // RateLimitError (no `.code`), so a `code:10008`/`50013` error carrying a stray
  // `retryAfter` (a wrapped/merged error or a future shape change) must still drop
  // edits / report permission — not enter the retry buffer and re-edit a deleted
  // message. The `.retryAfter` branch is only a rate limit when no terminal code
  // disqualifies it.
  if (de.code === CODE_UNKNOWN_MESSAGE) {
    return { kind: "not_supported", capability: "edit" };
  }
  if (de.code === CODE_MISSING_PERMISSIONS) {
    return { kind: "permission", detail: de.message ?? "Missing Permissions" };
  }
  if (de.status === 429 || de.retryAfter != null) {
    return { kind: "rate_limited", retryAfterMs: (de.retryAfter ?? 1) * 1000 };
  }
  return { kind: "internal", cause: e };
}

/** Optional timer used by the local 429 retry buffer. Omit it and a 429 simply propagates. */
export interface DiscordRenderActionsDeps {
  timer?: TimerPort;
}

/** Latest-text retry cap — a 429 storm coalesces to the latest text; we never replay a backlog. */
const MAX_RETRY_ATTEMPTS = 4;

/**
 * The subagent-expand marker the renderer paints into the parent line.
 * When a placeholder send carries it, the Discord adapter surfaces the thread
 * affordance SHELL (a public thread) — a DISPLAY affordance, never a resolution.
 */
const SUBAGENT_MARKER = "🤖";

/**
 * Build the {@link ActivityRenderActions} for a Discord channel. `send` requests
 * the thread-expand affordance SHELL for a subagent placeholder; `edit`/`delete`
 * guard the optional port methods and classify platform errors structurally.
 * When a `timer` is supplied, a `rate_limited` edit schedules a single bounded
 * retry of the LATEST text.
 */
export function makeDiscordRenderActions(
  adapter: ChannelPort,
  channelId: string,
  deps: DiscordRenderActionsDeps = {},
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

    const classified = classifyDiscordError(r.error);
    if (classified.kind === "not_supported") {
      // Unknown Message → stop editing entirely.
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
      // A subagent placeholder surfaces the thread-expand affordance (the parent
      // line in the channel, the expand in a public thread — display only). An
      // approval placeholder carries the signed native component row in `buttons`
      // (callback_data = v1.<choice>.<shortId>.<hmac>); the resolution is owned by
      // the InteractiveCallbackRouter, not this renderer.
      const threadReply = text.includes(SUBAGENT_MARKER);
      const r = await adapter.sendMessage(channelId, text, {
        ...(threadReply ? { threadReply: true } : {}),
        ...(opts?.buttons !== undefined ? { buttons: opts.buttons } : {}),
      });
      return r.ok ? ok(r.value) : err(classifyDiscordError(r.error));
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      return attemptEdit(id, text);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      cancelRetry();
      pendingText = undefined;
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifyDiscordError(r.error));
    },
  };
}

/**
 * Create the Discord EditPlace activity renderer — wires the
 * {@link createEditPlaceRenderer} with the per-channel render-actions adapter.
 * The daemon composition root constructs this with its runtime `TimerPort` /
 * `ClockPort` and the channel id.
 *
 * `signCallbackData` is the secret-bound signer injected at the composition root:
 * the renderer CONSUMES it to build signed approval components and never
 * imports the orchestrator package. When omitted, an
 * approval frame degrades to a button-less text prompt (no signer, no buttons;
 * the rest of the renderer is unaffected).
 */
export function createDiscordActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; signCallbackData?: SignCallbackData; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  const { signCallbackData } = deps;
  return createEditPlaceRenderer({
    actions: makeDiscordRenderActions(adapter, channelId, { timer: deps.timer }),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // Approval frame → signed native component rows. The signer is the only
    // path to `callback_data`; without it, no buttons are painted.
    buildButtons:
      signCallbackData === undefined
        ? undefined
        : (events) => events.flatMap((event) => buildApprovalButtons(event, signCallbackData)),
  });
}
