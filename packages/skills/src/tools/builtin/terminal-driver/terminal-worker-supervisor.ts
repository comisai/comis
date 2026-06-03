// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-supervisor -- the registry's worker-supervision glue (the OPS-01
 * crash-isolation listeners), extracted from `terminal-session-registry.ts` so that file
 * keeps headroom under the 800-line architecture cap before the P5 attention wiring lands
 * (the fd3 reader on `child.stdio?.[3]` is wired here in Wave 2 / 124-05 — see the seam note
 * at the bottom of {@link wireWorkerSupervision}).
 *
 * BEHAVIOR-NEUTRAL: this is pure code movement. {@link wireWorkerSupervision} installs the
 * EXACT three listeners `ensureWorker` did inline:
 *   - stdout `data`: the HR-02-guarded frame decoder (a malformed reply NEVER throws out of the
 *     listener — a throw on a stream listener becomes an `uncaughtException` that takes the
 *     DAEMON down, the opposite of "a crash restarts the WORKER, never the daemon"). A
 *     `FrameTooLargeError` (HR-01 corrupt/hostile length prefix) is logged with a distinct
 *     `hint` from a JSON-parse failure; both WARN `errorKind:"validation"`, flip the worker's
 *     running sessions to `lost`, clear the handle (next `create` re-spawns), and NEVER rethrow.
 *     On success: `for (const f of frames) correlate(pending, f)`.
 *   - `error`: WARN `errorKind:"dependency"`, flip sessions `lost`, clear the handle.
 *   - `close`: INFO, flip running sessions to `exited(code)`, clear the handle.
 * Only the LOCATION of this block changed.
 *
 * INFRA-FREE (like the registry + every worker-side sibling): value-imports ONLY the
 * terminal-ipc framer + structural types from the registry + node builtins — never the infra
 * or observability packages (Shared Pattern A; the registry MUST NOT cross into those layers).
 *
 * @module
 */

import {
  createFrameDecoder,
  correlate,
  FrameTooLargeError,
  type TerminalReplyFrame,
} from "./terminal-ipc.js";
import type {
  FakeWorkerChild,
  RegistryLogger,
  SessionHandle,
} from "./terminal-session-registry.js";

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
}

/**
 * Wire the three OPS-01 crash-isolation listeners onto a freshly-spawned worker child. EXACT
 * movement of the block formerly inline in `ensureWorker` (after `worker = child`) — see the
 * module doc for the per-listener contract. The fd3 events-push reader (spec §2.3) will be
 * added HERE in Wave 2 (124-05): `child.stdio?.[3]?.on("data", …)` decoding the worker's
 * attention/event frames. Do NOT add it now — this plan is pure movement.
 */
export function wireWorkerSupervision(args: WireWorkerSupervisionArgs): void {
  const { child, pending, sessions, logger, markRunningSessionsLost, clearWorker } = args;

  // Decode reply frames off the worker's stdout and correlate them to waiters.
  //
  // HR-02 (OPS-01 guarantee): decode/correlate is wrapped in try/catch so a
  // malformed reply frame NEVER throws out of this 'data' listener (a throw on a
  // stream listener becomes an `uncaughtException` that takes the DAEMON down —
  // the opposite of "a crash restarts the WORKER, never the daemon"). Throw
  // sources: `JSON.parse` on non-JSON body bytes (stray console.log / partial
  // write / post-desync garbage) + the HR-01 `FrameTooLargeError` on a corrupt
  // length prefix. On any decode failure we treat the worker as corrupt: WARN,
  // flip its running sessions to `lost`, clear the handle so the next `create`
  // re-spawns — never reaching `uncaughtException`.
  const decoder = createFrameDecoder();
  child.stdout?.on("data", (chunk: Buffer) => {
    let frames: TerminalReplyFrame[];
    try {
      frames = decoder.push(chunk) as TerminalReplyFrame[];
    } catch (err) {
      // A FrameTooLargeError (HR-01: corrupt/hostile length prefix) is a distinct,
      // more-actionable signal than a JSON parse failure — surface it precisely.
      const hint =
        err instanceof FrameTooLargeError
          ? "oversized worker frame length (corrupt/hostile prefix); dropping worker"
          : "corrupt worker frame on stdout; dropping worker";
      // errorKind:"validation" — the inbound frame failed structural decode
      // (the closest closed-union member for a corrupt/malformed wire frame).
      logger.warn({ err, hint, errorKind: "validation" as const }, "terminal worker frame decode failed");
      markRunningSessionsLost();
      clearWorker();
      return;
    }
    for (const frame of frames) correlate(pending, frame);
  });

  // OPS-01: a worker error flips its sessions to `lost` and clears the handle.
  child.on("error", (err) => {
    logger.warn(
      { err, hint: "terminal worker error; sessions lost, worker will re-spawn", errorKind: "dependency" as const },
      "terminal worker error",
    );
    markRunningSessionsLost();
    clearWorker();
  });

  // OPS-01: a worker close flips its sessions to `exited(code)` and clears.
  child.on("close", (code) => {
    const exitCode = typeof code === "number" ? code : null;
    logger.info(
      { exitCode, hint: "terminal worker closed; sessions exited, worker will re-spawn", errorKind: "dependency" as const },
      "terminal worker closed",
    );
    for (const handle of sessions.values()) {
      if (handle.status === "running") {
        handle.status = "exited";
        if (exitCode !== null) handle.exitCode = exitCode;
      }
    }
    clearWorker();
  });
}
