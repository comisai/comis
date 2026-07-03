// SPDX-License-Identifier: Apache-2.0
/**
 * WhatsApp windowed EditPlace activity renderer. Copies the Telegram
 * canonical shape with a baileys-specific classifier and the windowing
 * semantics. Three parts:
 *
 *   1. `classifyWhatsAppError` — the single net-new piece of logic here. WhatsApp
 *      Business edit/delete is WINDOWED (~15 min); baileys offers NO numeric
 *      error code dedicated to the windowed-expiry case — it surfaces an
 *      operation failure as a thrown `Boom` (`@hapi/boom`) carrying a 4xx
 *      `output.statusCode`. The classifier reads that STRUCTURAL field off the
 *      error AND off `error.cause` (the live adapter wraps the throw in
 *      `new Error(msg, { cause })`). A 4xx client rejection (400/403) →
 *      `{kind:"not_supported", capability:"edit"}` (same drop-further-edits
 *      semantics as Telegram message-not-found). The distinct "WhatsApp not
 *      connected" Error → `{kind:"transient_network", cause}`. Everything else
 *      (5xx, connection 408/428, unknown) → `{kind:"internal", cause}`. The
 *      message text is consulted only to disambiguate; it is never rendered or
 *      logged.
 *
 *   2. `makeWhatsAppRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts a plain-text placeholder (WhatsApp has NO button surface —
 *      `buttons:"none"`; the approval instruction is plain text). `edit`/`delete`
 *      GUARD the OPTIONAL `ChannelPort` methods (early
 *      `not_supported` — never a non-null-asserted call, AGENTS.md §2.8), map
 *      every `.error` through `classifyWhatsAppError`, and contain any throw the
 *      port lets escape. Once a window-expiry `not_supported` is seen, ALL
 *      further edits are dropped (no retry loop) — the EditPlace
 *      best-effort `flushEdit` tolerates the mid-stream failure; the finalize
 *      edit propagates the error.
 *
 *   3. `createWhatsAppActivityRenderer` — wires the shared
 *      `createEditPlaceRenderer` (the debounce/edit/delete state machine). It
 *      does NOT re-implement any rendering logic.
 *
 * Unlike Telegram there is NO local 429 retry buffer: baileys does not surface a
 * `rate_limited`/retry-after for these ops, and the windowed-expiry failure is
 * TERMINAL for edits (drop), not retryable. Keeping the adapter minimal (KISS).
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
import { createEditPlaceRenderer } from "../shared/strategies/edit-place.js";
import { buildApprovalPrompt } from "../shared/strategies/approval-render.js";

/**
 * Structural subset of a baileys/`@hapi/boom` error the classifier reads (also
 * matched on `error.cause` when the adapter wrapped the throw). `output.statusCode`
 * is the HTTP-style Boom status; `message` selects a variant only.
 */
interface BaileysErrorFields {
  output?: { statusCode?: number };
  message?: string;
  cause?: unknown;
}

/** The bare message the WhatsApp adapter's connection guard returns. */
const NOT_CONNECTED = "WhatsApp not connected";

/**
 * Classify a raw WhatsApp platform error into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL shape. Reads `output.statusCode` off the error itself
 * and, when the live adapter wrapped the baileys throw in `new Error(msg, { cause })`,
 * off `error.cause`. A windowed edit-expiry surfaces as a 4xx client rejection
 * (baileys has no dedicated numeric code for it); the not-connected guard surfaces
 * as a distinct message. Neither the status nor the message is ever rendered/logged.
 */
export function classifyWhatsAppError(e: unknown): ActivityRenderError {
  const direct = (e ?? {}) as BaileysErrorFields;

  // The not-connected guard returns a bare Error (possibly wrapped as cause).
  // Recognise it by message on the error and on its cause → transient_network.
  if (isNotConnected(direct)) {
    return { kind: "transient_network", cause: e };
  }

  // Prefer the typed Boom the adapter attached as `cause`; fall back to the error
  // object itself (the fake injects the Boom shape directly).
  const boom: BaileysErrorFields =
    direct.output?.statusCode === undefined && direct.cause != null
      ? ((direct.cause as BaileysErrorFields) ?? direct)
      : direct;

  const statusCode = boom.output?.statusCode;
  // 4xx client rejection = the windowed edit-expiry (baileys offers no dedicated
  // code). 400 Bad Request / 403 Forbidden are the observed window-closed shapes;
  // map them to not_supported so the renderer stops editing. 408/428 (connection)
  // and 5xx (server) are NOT window-expiry — they fall through to internal so the
  // renderer does not silently drop edits on a transient blip.
  if (statusCode === 400 || statusCode === 403) {
    return { kind: "not_supported", capability: "edit" };
  }

  return { kind: "internal", cause: e };
}

/** True when the error (or its cause) is the WhatsApp not-connected guard error. */
function isNotConnected(e: BaileysErrorFields): boolean {
  if (typeof e.message === "string" && e.message.includes(NOT_CONNECTED)) return true;
  const cause = e.cause as BaileysErrorFields | undefined;
  return (
    cause != null &&
    typeof cause.message === "string" &&
    cause.message.includes(NOT_CONNECTED)
  );
}

/**
 * Build the {@link ActivityRenderActions} for a WhatsApp chat. `send` posts a
 * plain-text placeholder (no button surface — `buttons:"none"`); `edit`/`delete`
 * guard the optional port methods, classify platform errors structurally, and
 * contain any throw. A windowed edit-expiry (`not_supported`) drops all further
 * edits (no retry loop).
 */
export function makeWhatsAppRenderActions(
  adapter: ChannelPort,
  channelId: string,
): ActivityRenderActions {
  /** Set once a window-expiry is seen — all further edits are dropped. */
  let editsDropped = false;

  return {
    async send(text): Promise<Result<string, ActivityRenderError>> {
      // Plain-text placeholder/approval shell: NO buttons (WhatsApp has no button
      // surface). No silent effect either —
      // WhatsApp ignores rich effects.
      const r = await runAdapter(() => adapter.sendMessage(channelId, text));
      if (!r.ok) return err(classifyWhatsAppError(r.error));
      return ok(r.value);
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      if (editsDropped) return err({ kind: "not_supported", capability: "edit" });
      if (!adapter.editMessage) return err({ kind: "not_supported", capability: "edit" });

      const editMessage = adapter.editMessage;
      const r = await runAdapter(() => editMessage(channelId, id, text));
      if (r.ok) return ok(undefined);

      const classified = classifyWhatsAppError(r.error);
      // Window closed → stop editing entirely (drop-further-edits, no retry loop).
      if (classified.kind === "not_supported") editsDropped = true;
      return err(classified);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const deleteMessage = adapter.deleteMessage;
      const r = await runAdapter(() => deleteMessage(channelId, id));
      return r.ok ? ok(undefined) : err(classifyWhatsAppError(r.error));
    },
  };
}

/**
 * Run a port call, containing a throw the port lets escape (baileys throws before
 * the live adapter's try/catch in some paths). Returns the same `Result<_, Error>`
 * the port contract promises so the caller classifies one error shape.
 */
async function runAdapter<T>(
  fn: () => Promise<Result<T, Error>>,
): Promise<Result<T, Error>> {
  try {
    return await fn();
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown : new Error(String(thrown), { cause: thrown }));
  }
}

/**
 * Create the WhatsApp EditPlace activity renderer — wires the shared
 * {@link createEditPlaceRenderer} with the per-channel render-actions adapter. The
 * daemon composition root constructs this with its runtime `TimerPort` /
 * `ClockPort` and the chat id.
 */
export function createWhatsAppActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  return createEditPlaceRenderer({
    actions: makeWhatsAppRenderActions(adapter, channelId),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // WhatsApp has no button surface (`buttons:"none"`), so an approval frame
    // appends the plain-text prompt ("Reply approve or deny …", with shortIds when
    // >1 pending) to the placeholder. A non-approval frame yields
    // "" (the placeholder text stays byte-identical).
    buildPrompt: buildApprovalPrompt,
  });
}
