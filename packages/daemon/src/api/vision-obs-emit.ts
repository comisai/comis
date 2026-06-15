// SPDX-License-Identifier: Apache-2.0
/**
 * VIS-04 (Phase 187): the vision-turn trajectory direct-emit + §2.7 log-line
 * helper.
 *
 * The daemon vision RPC handlers (`image.analyze` / `media.describe_video` in
 * `media-handlers.ts`) record a vision turn's lifecycle onto the per-session
 * trajectory so `comis explain <sessionKey>` reconstructs it (provider /
 * mainProvider / model / path / costUsd / outcome), AND emit the §2.7 INFO
 * completion line / WARN failure line — the SAME observability image generation
 * got in Phase 186 (`image-handlers.ts:210` / `:604` are the templates).
 *
 * Extracted to a sibling (NOT inlined into `media-handlers.ts`) because that
 * file is at its 800-line cap — routing the emits + the §2.7 lines through this
 * helper keeps it shrink-only (the file-size gate keys on path). Each call
 * (`succeeded` / `failed`) does BOTH the trajectory record AND its §2.7 log
 * line, collapsing two handler lines to one per tier site. The `requested`
 * entry record fires at CONSTRUCTION. The daemon RPC context has NO EventBus
 * bridge, so the handler resolves the recorder by the dispatcher-injected
 * `_callerSessionKey` and records DIRECTLY; a null/absent recorder (boot mode
 * without one, env-disabled session, or no session key) makes the trajectory
 * emits NO-OPs (never a crash). The §2.7 log lines ALWAYS fire (recorder or not).
 *
 * CONTENT-FREE (T-187-12): every recorded payload + log field carries ids /
 * labels / the `path` / `costUsd` / `outcome` / `errorKind` / `durationMs` ONLY
 * — NEVER the image bytes, the analysis prompt, the model's answer, or a
 * credential. `costUsd` rides `media.vision.completed` + the INFO line
 * (= `AssistantMessage.usage.cost.total`, OPTIONAL — absent on the
 * registry/gemini-video tiers; Pitfall 4). The domain `ImageErrorKind` maps onto
 * the CLOSED log `ErrorKind` via `IMAGE_ERR_TO_LOG` on every failure line (the
 * closed-errorKind architecture invariant; `imageErrorKind` carries the domain).
 *
 * @module
 */

import type { SessionTrajectoryHandleRegistry, TrajectoryEventType } from "@comis/observability";
import { IMAGE_ERR_TO_LOG } from "@comis/core";
import type { ComisLogger, ImageErrorKind } from "@comis/core";

/** The ladder tier a vision turn took — VIS-03's "which path" signal. Mirrors
 *  the `path` literals `resolveVisionPath` returns (+ the `MediaVisionEvents`
 *  EventMap `VisionPath`); kept local so the daemon helper takes no extra
 *  `@comis/core` barrel surface. `unavailable` is failure-only. */
type VisionPath = "main-vision" | "registry" | "gemini-video" | "unavailable";

/** The `resolveVisionPath` outcome, structurally typed to avoid the barrel. */
type VisionSelection =
  | { ok: true }
  | { ok: false; errorKind: ImageErrorKind; hint: string };

/**
 * WR-03: resolve the honest-unavailable terminal's `{ errorKind, hint }`. A
 * resolver refusal (`sel.ok === false`) is authoritative and wins. Otherwise
 * (a chosen path that then could not serve — e.g. main-vision ran and failed,
 * or a registry/video provider was absent) the caller-supplied `fallbackKind`/
 * `fallbackHint` are used: the image handler passes the LAST bridge failure
 * kind/hint so the terminal keeps the specific reason (auth_required/timeout)
 * instead of the generic `unsupported_provider`; the video handler passes its
 * own generic kind/message (no bridge runs for video — Pitfall 3).
 */
export function resolveTerminalUnavailable(
  sel: VisionSelection,
  fallbackKind: ImageErrorKind,
  fallbackHint: string,
): { errorKind: ImageErrorKind; hint: string } {
  return sel.ok === false
    ? { errorKind: sel.errorKind, hint: sel.hint }
    : { errorKind: fallbackKind, hint: fallbackHint };
}

/** A bound vision-trajectory + §2.7-log emitter. Returned by
 *  `createVisionObsEmitter` (which fires `media.vision.requested` at
 *  construction); the handler calls `succeeded`/`failed` on the tier branches it
 *  takes. The trajectory emits are no-ops when no recorder resolved; the §2.7
 *  log lines always fire. */
export interface VisionObsEmitter {
  /** True when a non-null recorder resolved (a session key + a registry). */
  readonly active: boolean;
  /**
   * A tier SUCCEEDED: emit media.vision.completed (content-free; costUsd
   * OPTIONAL — Pitfall 4) AND the §2.7 INFO completion line carrying
   * { agentId, visionProvider, mainProvider, model, path, costUsd, durationMs,
   * step:"vision_complete" }. ONE call per success site.
   */
  succeeded(args: { provider: string; mainProvider: string; path: VisionPath; model?: string; costUsd?: number }): void;
  /**
   * A tier FAILED (a classified bridge/registry error OR an honest
   * no-tier-available): emit media.vision.failed (content-free, domain
   * errorKind) AND the §2.7 WARN line (domain → closed log union via
   * IMAGE_ERR_TO_LOG; the domain rides `imageErrorKind`). ONE call per failure
   * site; `message`/`hint` are caller-supplied so each site keeps its UX text.
   */
  failed(args: {
    errorKind: ImageErrorKind | "dependency";
    path: VisionPath;
    provider: string;
    mainProvider: string;
    hint: string;
    message: string;
  }): void;
  /**
   * WR-01 convenience: read the domain `errorKind` off a Result error (a
   * `VisionUnavailable` or any Error) — `?? "dependency"` when absent — then
   * delegate to {@link failed}. Lets each tier-failure branch instrument in ONE
   * line (the registry / gemini-video throw sites) without re-deriving the cast.
   */
  failedFrom(
    error: unknown,
    args: { path: VisionPath; provider: string; mainProvider: string; hint: string; message: string },
  ): void;
}

/**
 * Resolve the per-session recorder by `_callerSessionKey`, fire the
 * `media.vision.requested` entry record, and return a bound `VisionObsEmitter`.
 * The trajectory emits record the `media.vision.*` events directly (no bus
 * bridge in the daemon RPC context — the `image-handlers.ts:210` precedent);
 * when the registry is absent or `getRecorder` returns null/undefined or there
 * is no session key, the trajectory emits are NO-OPs (never a crash). The §2.7
 * log lines ALWAYS fire. `durationMs` is computed from the injected `startMs`
 * (the handler's `systemNowMs()` at entry — never `Date.now()`, the globals
 * gate) via the injected `now`. Optional `model`/`costUsd` spread only when
 * present so an absent value never appears as an `undefined` key.
 */
export function createVisionObsEmitter(
  sessionKey: string | undefined,
  trajectoryRegistry: SessionTrajectoryHandleRegistry | undefined,
  logger: ComisLogger,
  agentId: string,
  startMs: number,
  now: () => number,
  requested: { provider: string; mainProvider: string },
): VisionObsEmitter {
  const recorder =
    sessionKey != null && sessionKey.length > 0 && trajectoryRegistry != null
      ? trajectoryRegistry.getRecorder?.(sessionKey)
      : undefined;

  const emit = (type: TrajectoryEventType, data: Record<string, unknown>): void => {
    if (recorder != null) recorder.recordEvent(type, data);
  };

  emit("media.vision.requested", { provider: requested.provider, mainProvider: requested.mainProvider });

  return {
    active: recorder != null,
    succeeded({ provider, mainProvider, path, model, costUsd }) {
      const optional = {
        ...(model !== undefined ? { model } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
      emit("media.vision.completed", { provider, mainProvider, path, outcome: "ok", ...optional });
      logger.info(
        { agentId, path, visionProvider: provider, mainProvider, ...optional, durationMs: now() - startMs, step: "vision_complete" },
        "Vision analysis completed",
      );
    },
    failed({ errorKind, path, provider, mainProvider, hint, message }) {
      emit("media.vision.failed", { errorKind, path, provider, mainProvider });
      const logErrorKind = errorKind === "dependency" ? ("dependency" as const) : IMAGE_ERR_TO_LOG[errorKind];
      logger.warn(
        { agentId, path, errorKind: logErrorKind, imageErrorKind: errorKind === "dependency" ? undefined : errorKind, hint, durationMs: now() - startMs, step: "vision_complete" },
        message,
      );
    },
    failedFrom(error, { path, provider, mainProvider, hint, message }) {
      const kind = (error as { errorKind?: ImageErrorKind }).errorKind ?? "dependency";
      this.failed({ errorKind: kind, path, provider, mainProvider, hint, message });
    },
  };
}
