// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-supervisor -- the registry's worker-supervision glue (the
 * crash-isolation listeners + the fd3 attention reader), extracted from
 * `terminal-session-registry.ts` so that file keeps headroom under the 800-line cap.
 *
 * {@link wireWorkerSupervision} installs the three crash-isolation listeners
 * (stdout/error/close) AND the no-poll fd3 events-push reader on `child.stdio?.[3]` —
 * decoding each `TerminalEventFrame` the worker pushes on a state transition and
 * dispatching it to the daemon-injected `onTerminalEvent` hook. The fd3 reader copies the
 * stdout decode guard VERBATIM (a corrupt event frame WARNs + drops the worker, never
 * crashes the daemon). The three listeners are:
 *   - stdout `data`: the guarded frame decoder (a malformed reply NEVER throws out of the
 *     listener — a throw on a stream listener becomes an `uncaughtException` that takes the
 *     DAEMON down, the opposite of "a crash restarts the WORKER, never the daemon"). A
 *     `FrameTooLargeError` (corrupt/hostile length prefix) is logged with a distinct
 *     `hint` from a JSON-parse failure; both WARN `errorKind:"validation"`, flip the worker's
 *     running sessions to `lost`, clear the handle (next `create` re-spawns), and NEVER rethrow.
 *     On success: `for (const f of frames) correlate(pending, f)`.
 *   - `error`: WARN `errorKind:"dependency"`, flip sessions `lost`, clear the handle.
 *   - `close`: INFO, flip running sessions to `exited(code)`, clear the handle.
 *
 * INFRA-FREE (like the registry + every worker-side sibling): value-imports ONLY the
 * terminal-ipc framer + node builtins, and type-imports the registry's structural contracts
 * from the neutral leaf `terminal-session-types.ts` (NOT the registry itself — that would
 * re-introduce the import cycle the registry's `wireWorkerSupervision` value-import forms);
 * never the infra or observability packages (Shared Pattern A; the registry MUST NOT cross
 * into those layers).
 *
 * @module
 */

import {
  createFrameDecoder,
  correlate,
  FrameTooLargeError,
  type TerminalEventFrame,
  type TerminalFrame,
  type TerminalReplyFrame,
} from "./terminal-ipc.js";
import type {
  FakeWorkerChild,
  RegistryLogger,
  SessionHandle,
} from "./terminal-session-types.js";

/** Explicit dependencies for {@link wireWorkerSupervision} — the closure locals `ensureWorker` used, passed as params (no module-global state, no hidden closure). */
export interface WireWorkerSupervisionArgs {
  /** The freshly-spawned worker child whose stdout/error/close this supervises. */
  child: FakeWorkerChild;
  /** The registry's closure-local pending-reply map (`${sessionId}:${requestId}` → resolver); `correlate` flushes matched replies. */
  pending: Map<string, (f: TerminalReplyFrame) => void>;
  /** The registry's closure-local session map — the `close` handler flips still-running handles to `exited(code)`. */
  sessions: Map<string, SessionHandle>;
  /** Structural registry logger (the daemon injects the real one). */
  logger: RegistryLogger;
  /** Flip every still-`running` session of the current worker to `lost` (the registry's closure-local helper). */
  markRunningSessionsLost: () => void;
  /** Clear the worker handle + flush its pending waiters (the registry's closure-local helper); the next `ensureWorker` re-spawns. */
  clearWorker: () => void;
  /** The daemon-injected sink for each decoded fd3 {@link TerminalEventFrame} (the no-poll attention seam). Absent ⇒ the fd3 reader still decodes + guards, but drops events (no consumer). */
  onTerminalEvent?: (frame: TerminalEventFrame) => void;
}

/**
 * Wire the crash-isolation listeners (stdout/error/close) + the fd3 events-push
 * reader onto a freshly-spawned worker child — see the module doc for the
 * per-listener contract. The fd3 reader on `child.stdio?.[3]` decodes the worker's
 * attention/event frames with the SAME decode guard the stdout reader has
 * (a corrupt event frame never crashes the daemon) and dispatches each to `onTerminalEvent`.
 */
export function wireWorkerSupervision(args: WireWorkerSupervisionArgs): void {
  const { child, pending, sessions, logger, markRunningSessionsLost, clearWorker, onTerminalEvent } = args;

  // The worker-crash paths (error / close / a corrupt-frame decode fault) flip this
  // worker's still-`running` sessions to `lost`/`exited` IN MEMORY; they MUST also emit a
  // lifecycle signal, or the daemon's per-session reclaimers (onSessionGone →
  // promotedSessions / driveJournals / driveStartedAtMs / the loop-guard ring / the FSM state /
  // the wake-state file) never fire and a promoted drive whose worker crashed leaks its
  // drive-state for the daemon's lifetime. This re-publishes a CONTENT-FREE
  // terminal:session_state frame (sessionId + a `state` enum ONLY — no screen/keys/payload)
  // per affected session through the SAME injected onTerminalEvent seam the PTY-exit path uses
  // (buildTerminalEventHook re-publishes it onto the bus → onSessionGone reclaims). Snapshot the
  // running ids BEFORE the caller flips them (the flip clears `status === "running"`), then emit.
  //
  // Wrapped never-throw: onTerminalEvent runs inside a stream 'data' / 'error' / 'close'
  // listener, so a hook fault must NEVER become an uncaughtException that takes the daemon down
  // (the crash-isolation guarantee this whole module upholds). A null sink (no daemon hook) is a no-op.
  const runningSessionIds = (): string[] => {
    const ids: string[] = [];
    for (const handle of sessions.values()) {
      if (handle.status === "running") ids.push(handle.sessionId);
    }
    return ids;
  };
  const publishCrashLifecycle = (sessionIds: readonly string[], state: "lost" | "exited"): void => {
    if (onTerminalEvent === undefined) return;
    for (const sessionId of sessionIds) {
      try {
        onTerminalEvent({ sessionId, event: "terminal:session_state", payload: { state } });
      } catch (err) {
        logger.warn(
          { err, sessionId, hint: "worker-crash lifecycle re-publish failed; the daemon may briefly retain this session's drive-state until the next reaper sweep", errorKind: "internal" as const },
          "terminal worker-crash lifecycle emit failed",
        );
      }
    }
  };

  // Decode reply frames off the worker's stdout and correlate them to waiters.
  //
  // Crash-isolation guarantee: decode/correlate is wrapped in try/catch so a
  // malformed reply frame NEVER throws out of this 'data' listener (a throw on a
  // stream listener becomes an `uncaughtException` that takes the DAEMON down —
  // the opposite of "a crash restarts the WORKER, never the daemon"). Throw
  // sources: `JSON.parse` on non-JSON body bytes (stray console.log / partial
  // write / post-desync garbage) + the `FrameTooLargeError` on a corrupt
  // length prefix. On any decode failure we treat the worker as corrupt: WARN,
  // flip its running sessions to `lost`, clear the handle so the next `create`
  // re-spawns — never reaching `uncaughtException`.
  const decoder = createFrameDecoder();
  child.stdout?.on("data", (chunk: Buffer) => {
    let frames: TerminalReplyFrame[];
    try {
      frames = decoder.push(chunk) as TerminalReplyFrame[];
    } catch (err) {
      // A FrameTooLargeError (corrupt/hostile length prefix) is a distinct,
      // more-actionable signal than a JSON parse failure — surface it precisely.
      const hint =
        err instanceof FrameTooLargeError
          ? "oversized worker frame length (corrupt/hostile prefix); dropping worker"
          : "corrupt worker frame on stdout; dropping worker";
      // errorKind:"validation" — the inbound frame failed structural decode
      // (the closest closed-union member for a corrupt/malformed wire frame).
      logger.warn({ err, hint, errorKind: "validation" as const }, "terminal worker frame decode failed");
      // Snapshot the running ids BEFORE the flip, then emit the lost-lifecycle signal.
      const lostIds = runningSessionIds();
      markRunningSessionsLost();
      publishCrashLifecycle(lostIds, "lost");
      clearWorker();
      return;
    }
    for (const frame of frames) correlate(pending, frame);
  });

  // The no-poll attention READER on fd3 (child.stdio[3]).
  // The worker writes a TerminalEventFrame to fd3 on a state TRANSITION (the emitter);
  // this reads it and dispatches to the daemon-injected onTerminalEvent
  // hook (which re-publishes onto the TypedEventBus). A SEPARATE push channel from the
  // busy stdout reply stream so a busy session cannot delay an attention event.
  //
  // Crash-isolation guarantee (identical to the stdout guard above): decode is wrapped in
  // try/catch so a malformed/oversized event frame (a stray worker write on fd3, a partial
  // write, post-desync garbage, or an oversized length prefix) NEVER throws out of
  // this 'data' listener (a throw on a stream listener becomes an `uncaughtException` that
  // takes the DAEMON down). On any decode failure we treat the worker as corrupt: WARN
  // errorKind:"validation" (FrameTooLargeError gets a distinct hint), flip its running
  // sessions to `lost`, clear the handle so the next `create` re-spawns — never rethrow.
  // The reader is optional-chained: a worker without fd3 (or stderr) is fine. Frames are
  // routed by SHAPE — only event-shaped frames (`"event" in f`, no requestId) reach the
  // hook; a reply-shaped frame is not expected on fd3 and is ignored.
  const eventDecoder = createFrameDecoder();
  child.stdio?.[3]?.on("data", (chunk: Buffer) => {
    let frames: TerminalFrame[];
    try {
      frames = eventDecoder.push(chunk);
    } catch (err) {
      const hint =
        err instanceof FrameTooLargeError
          ? "oversized worker event frame length (corrupt/hostile prefix); dropping worker"
          : "corrupt worker event frame on fd3; dropping worker";
      logger.warn({ err, hint, errorKind: "validation" as const }, "terminal worker event frame decode failed");
      // Snapshot the running ids BEFORE the flip, then emit the lost-lifecycle signal.
      const lostIds = runningSessionIds();
      markRunningSessionsLost();
      publishCrashLifecycle(lostIds, "lost");
      clearWorker();
      return;
    }
    for (const frame of frames) {
      if ("event" in frame) onTerminalEvent?.(frame as TerminalEventFrame);
    }
  });

  // A worker error flips its sessions to `lost` and clears the handle.
  child.on("error", (err) => {
    logger.warn(
      { err, hint: "terminal worker error; sessions lost, worker will re-spawn", errorKind: "dependency" as const },
      "terminal worker error",
    );
    // Snapshot the running ids BEFORE the flip, then emit the lost-lifecycle signal so
    // the daemon reclaims the per-session drive-state (no leak across a worker crash).
    const lostIds = runningSessionIds();
    markRunningSessionsLost();
    publishCrashLifecycle(lostIds, "lost");
    clearWorker();
  });

  // A worker close flips its sessions to `exited(code)` and clears.
  child.on("close", (code) => {
    const exitCode = typeof code === "number" ? code : null;
    logger.info(
      { exitCode, hint: "terminal worker closed; sessions exited, worker will re-spawn", errorKind: "dependency" as const },
      "terminal worker closed",
    );
    // Snapshot the running ids BEFORE the flip, then emit the exited-lifecycle signal so
    // the daemon reclaims the per-session drive-state (no leak across a worker close/crash).
    const exitedIds = runningSessionIds();
    for (const handle of sessions.values()) {
      if (handle.status === "running") {
        handle.status = "exited";
        if (exitCode !== null) handle.exitCode = exitCode;
      }
    }
    publishCrashLifecycle(exitedIds, "exited");
    clearWorker();
  });
}
