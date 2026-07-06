// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix EditPlace activity renderer.
 *
 * Structurally mirrors the Microsoft Teams renderer — only the error classifier,
 * the render actions, and the (absent) button surface differ. Three parts:
 *
 *   1. `classifyMatrixRenderError` — the per-platform net-new logic. It maps a
 *      Client-Server API failure onto the CLOSED `ActivityRenderError` union —
 *      never the send-path observability taxonomy (`classifyMatrixError` in
 *      errors.ts), which reports `errorKind` / `retryable` / `hint` for logging
 *      rather than a render variant. It reads the STRUCTURAL string `errcode` and
 *      numeric `httpStatus` off the error itself and — when the adapter wrapped
 *      the failure in `new Error(msg, { cause })` — off `error.cause`. For a
 *      rate-limit it also reads the response body's `retry_after_ms` (already in
 *      ms) so the retry buffer can back off. The errcode/status are consulted
 *      ONLY to choose the variant — never rendered or logged as activity text,
 *      and no token/header/body is copied into the payload. Mapping:
 *      `M_LIMIT_EXCEEDED`/`429` → rate_limited; the edit target gone
 *      (`404`/`M_NOT_FOUND`) → not_supported:edit (drop edits);
 *      `M_FORBIDDEN`/`403`/`401` → permission; anything else → internal. The
 *      permission arm delegates the errcode/status read to the one authoritative
 *      `classifyMatrixError` taxonomy (its `auth` verdict), so a rejected token
 *      and a forbidden action classify consistently.
 *
 *   2. `makeMatrixRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts the placeholder (Matrix has no button surface, so it never forwards
 *      approval buttons — a bare text activity). `edit`/`delete` GUARD the
 *      optional `ChannelPort` methods (early `not_supported` — never a non-null
 *      `!` cluster) and map every `.error` through `classifyMatrixRenderError`.
 *      `delete` is the required delete-on-success op (a redaction on the wire).
 *      All paths return `Result`; nothing throws across the boundary.
 *
 *   3. `createMatrixActivityRenderer` — wires the shared `createEditPlaceRenderer`
 *      (the debounce / edit / delete-after-delivery state machine). It does NOT
 *      re-implement any rendering logic, and `buildButtons` is undefined: Matrix
 *      exposes no button surface, so an approval frame degrades to a plain text
 *      prompt — no fake actionable control is ever painted.
 *
 * 429 backoff (mirrors the Slack/Teams renderers): the channels package depends
 * on `core` + `shared` only — no observability substrate — so the buffer is a
 * LOCAL fixed-cap latest-text slot with a `retryAfterMs`-gated retry through the
 * injected `TimerPort` (the handle is `unref`'d and `cancel()`-able — never a raw
 * timer clear). It coalesces to the latest text and never grows unbounded; a
 * `not_supported` (target-gone) edit drops all further edits.
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
import { classifyMatrixError } from "./errors.js";

/** Structural subset of a Matrix SDK error the render classifier reads (also off `error.cause`). */
interface MatrixRenderErrorFields {
  /** The Client-Server API errcode (e.g. "M_LIMIT_EXCEEDED", "M_FORBIDDEN"). */
  errcode?: string;
  /** The HTTP status of the response (e.g. 429, 403, 404). */
  httpStatus?: number;
  /** A rate-limit carries its backoff (already in ms) in the parsed response body. */
  data?: { retry_after_ms?: number };
  cause?: unknown;
}

/** Unwrap the structural fields, preferring the error itself and falling back to
 *  the cause the adapter attached via `new Error(msg, { cause })`. */
function unwrapMatrixError(e: unknown): MatrixRenderErrorFields {
  const direct = (e ?? {}) as MatrixRenderErrorFields;
  // No errcode AND no status directly → unwrap the cause (the SDK error).
  return direct.errcode === undefined && direct.httpStatus === undefined && direct.cause != null
    ? ((direct.cause as MatrixRenderErrorFields) ?? direct)
    : direct;
}

/**
 * Classify a raw Client-Server failure into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL `errcode` / `httpStatus`. Reads them off the error and,
 * when wrapped, off `error.cause`. The status is consulted ONLY to pick the
 * variant — never rendered or logged, and no token/body is copied in.
 */
export function classifyMatrixRenderError(e: unknown): ActivityRenderError {
  const me = unwrapMatrixError(e);
  const errcode = me.errcode;
  const status = me.httpStatus;

  // Rate limited: read the homeserver's retry_after_ms (already ms; floor 1s).
  if (errcode === "M_LIMIT_EXCEEDED" || status === 429) {
    return { kind: "rate_limited", retryAfterMs: me.data?.retry_after_ms ?? 1000 };
  }
  // The edit target is gone (redacted / never existed) — stop editing entirely.
  if (status === 404 || errcode === "M_NOT_FOUND") {
    return { kind: "not_supported", capability: "edit" };
  }
  // Permission: delegate the errcode/status read to the one authoritative
  // taxonomy — M_FORBIDDEN/403 and a rejected token read as `auth` there. A bare
  // 401 the taxonomy leaves unclassified, so name it here too. Content-free
  // detail: only the numeric status / errcode, never a token/header/body.
  const classified = classifyMatrixError({
    ...(errcode !== undefined ? { errcode } : {}),
    ...(status !== undefined ? { status } : {}),
    cause: e,
  });
  if (classified.errorKind === "auth" || status === 401) {
    return { kind: "permission", detail: `matrix status ${status ?? errcode ?? "unknown"}` };
  }
  return { kind: "internal", cause: e };
}

/** Optional timer used by the local 429 retry buffer. Omit it and a 429 simply propagates. */
export interface MatrixRenderActionsDeps {
  timer?: TimerPort;
}

/** Latest-text retry cap — a 429 storm coalesces to the latest text; we never replay a backlog. */
const MAX_RETRY_ATTEMPTS = 4;

/**
 * Build the {@link ActivityRenderActions} for a Matrix room. `edit`/`delete`
 * guard the optional port methods and classify Client-Server errors structurally;
 * `delete` is the delete-on-success op (a redaction). When a `timer` is supplied,
 * a `rate_limited` edit schedules a single bounded retry of the LATEST text.
 */
export function makeMatrixRenderActions(
  adapter: ChannelPort,
  channelId: string,
  deps: MatrixRenderActionsDeps = {},
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

    const classified = classifyMatrixRenderError(r.error);
    if (classified.kind === "not_supported") {
      // Target gone → stop editing entirely.
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
      // Matrix has no button surface, so a renderer never produces approval rows
      // (buildButtons is undefined) — `opts.buttons` is therefore always absent
      // and the placeholder is a bare text activity. The forward is kept for the
      // uniform ActivityRenderActions contract; nothing fake is ever painted.
      const r = await adapter.sendMessage(
        channelId,
        text,
        opts?.buttons !== undefined ? { buttons: opts.buttons } : undefined,
      );
      return r.ok ? ok(r.value) : err(classifyMatrixRenderError(r.error));
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      return attemptEdit(id, text);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      cancelRetry();
      pendingText = undefined;
      // The required delete-on-success op (gated on deliveredAtMs by the
      // EditPlace finalize) — a redaction of the placeholder event.
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifyMatrixRenderError(r.error));
    },
  };
}

/**
 * Create the Matrix EditPlace activity renderer — wires the
 * {@link createEditPlaceRenderer} with the per-room render-actions adapter. The
 * daemon composition root constructs this with its runtime `TimerPort` /
 * `ClockPort` and the room id.
 *
 * `buildButtons` is undefined: Matrix declares `buttons:"none"` (no button
 * surface), so an approval frame degrades to a plain text prompt — no signer is
 * consumed and no actionable control is ever rendered.
 */
export function createMatrixActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  return createEditPlaceRenderer({
    actions: makeMatrixRenderActions(adapter, channelId, { timer: deps.timer }),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // No button surface — approval frames degrade to text; never paint buttons.
    buildButtons: undefined,
  });
}
