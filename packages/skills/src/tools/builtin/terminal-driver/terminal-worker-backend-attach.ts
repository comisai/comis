// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-backend-attach -- the worker's PTY-vs-pipe backend-attach glue plus
 * its two exclusive ring/exit primitives, extracted from `terminal-worker-entry.ts` so
 * that file keeps headroom under the 800-line architecture cap before the P5 attention
 * wiring lands (the fd3 emitter call is added to the worker in Wave 2 / 124-05).
 *
 * BEHAVIOR-NEUTRAL: this is pure code movement. {@link attachBackend} performs the EXACT
 * same wiring `handleCreate` did inline (try `loadPty()` → on success wire the node-pty
 * session's `onData`→ring / `onExit`→exit and set `state.pty`; on throw WARN
 * `errorKind:"dependency"`, flip to `degraded`, spawn the pipe child and wire its
 * `stdout.on("data")`→ring + `close`/`error`→exit and set `state.pipe`). {@link appendRing}
 * and {@link markExited} (the worker's former closure locals, whose ONLY callers were these
 * backend stream handlers) move with it byte-for-byte. Both backends spawn
 * `bwrap [scope args] -- bin argv` (the plan is composed upstream) — no unjailed path. Only
 * the LOCATION of this block changed.
 *
 * INFRA-FREE (like every worker-side sibling): value-imports ONLY node builtins, and
 * type-imports the worker's structural contracts from the neutral leaf
 * `terminal-worker-types.ts` (NOT the entry itself — that would re-introduce the import
 * cycle the entry's `attachBackend` value-import forms); never the infra or observability
 * packages (Shared Pattern A; the worker MUST NOT cross into those layers).
 *
 * @module
 */

import type {
  PipeChildLike,
  PtyModuleLike,
  SessionState,
  TmuxBackendLike,
  WorkerBackend,
  WorkerLogger,
} from "./terminal-worker-types.js";

/** The composed spawn plan a backend attaches to — the `{bin,argv,env}` ride VERBATIM after the bwrap composer's `--` (M-1). */
interface BackendSpawnPlan {
  bin: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Append a chunk to the session ring (RAW settle feed + degraded view) AND feed it into the
 * @xterm emulator (the rendered-`read` source of truth), then notify the settle's ring-change
 * subscribers. The emu write chains onto {@link SessionState.writeFlush} (serialized,
 * @xterm-PARSE-backed) so `handleRead` awaits it before serializing a settled frame.
 *
 * Exported so the worker can hand the SAME primitive to other call sites if needed; in P0 its
 * only callers are the backend stream handlers in {@link attachBackend}.
 */
export function appendRing(state: SessionState, chunk: string): void {
  state.ring += chunk;
  state.writeFlush = (state.writeFlush ?? Promise.resolve()).then(() => state.emu?.write(chunk));
  for (const cb of state.ringListeners) cb();
}

/**
 * Flip a session to not-alive + notify the settle's exit subscribers (onExit half) so a pending
 * `wait`/settle resolves `exit`. ALSO disposes the `listed-hosts` egress materialization ONCE
 * (socket cleanup, 122-06) — nulling the handle first so a second exit signal (close AND error)
 * cannot double-dispose. `logger` is passed in (the worker's injected structural logger) so this
 * module stays infra-free.
 */
export function markExited(state: SessionState, logger: WorkerLogger, exitCode?: number): void {
  state.alive = false;
  // 124-06: capture the PTY exit code when the backend reported one (the pty `onExit`
  // payload). The pipe close/error path passes none → `exitCode` stays undefined. The
  // `status` frame surfaces it as the spec §5 `exitCode`. Recorded once; a 2nd signal
  // (close AND error) does not clobber a captured code with undefined.
  if (exitCode !== undefined) state.exitCode = exitCode;
  if (state.egress !== undefined) {
    const { egress } = state;
    state.egress = undefined; // dispose once, even if close+error both fire
    void egress.dispose().catch((err: unknown) => {
      logger.warn(
        { err, hint: "egress dispose failed on session teardown", errorKind: "internal" as const },
        "terminal egress dispose failed",
      );
    });
  }
  for (const cb of state.exitListeners) cb();
  // The exit wake (124-05 gap-close, TR-11): push the exited transition on fd3 even when
  // NO settle is pending (no wait/read in flight — the "finished while the agent sat idle"
  // shape). The hook is the worker's single-homed classify-and-emit seam; the edge-triggered
  // emitter dedups it against a settle the exit listeners just resolved, and a 2nd exit
  // signal (close AND error) re-observes the SAME exited state → no double frame.
  state.observeExit?.();
}

/** Explicit dependencies for {@link attachBackend} — the closure locals `handleCreate` used, passed as params (no module-global state, no hidden closure). */
export interface AttachBackendArgs {
  /** The composed spawn plan (`{bin,argv,env}`) — the frame's `{bin,argv}` after the 122-06 bwrap composer. */
  plan: BackendSpawnPlan;
  /** Terminal columns for the PTY winsize. */
  cols: number;
  /** Terminal rows for the PTY winsize. */
  rows: number;
  /** The closure-local per-session record this backend feeds (ring + liveness + the `pty`/`pipe` handle). */
  state: SessionState;
  /** Load node-pty (the worker's injected `deps.loadPty`); a throw → the pipe backend, `degraded` (TR-08). */
  loadPty: () => PtyModuleLike;
  /** Spawn the pipe-backend child (the worker's resolved `spawnPipe`). */
  spawnPipe: (
    bin: string,
    argv: string[],
    opts: { env: NodeJS.ProcessEnv },
  ) => PipeChildLike;
  /** Structural worker logger (the worker's injected logger) — threaded to {@link markExited}. */
  logger: WorkerLogger;
  /**
   * 124-08 (OPS-05): the requested backend off the create frame. `"tmux"` selects the
   * tmux named-session backend (survival) WHEN {@link loadTmux} is wired; absent/`"pty"`
   * falls to the existing node-pty → pipe path. The daemon threads this from the
   * allow-entry `backend` field (124-09); until then it is `undefined` (default pty/pipe).
   */
  requestedBackend?: WorkerBackend;
  /**
   * 124-08 (OPS-05): the tmux-backend loader (the worker's injected `deps.loadTmux`). The
   * 3rd option behind the same {@link FakePtyLike} seam as node-pty | pipe. Used ONLY when
   * the create frame requests `backend:"tmux"`; absent ⇒ the request silently falls back to
   * the pty/pipe path (a worker built without the tmux loader cannot drive a tmux session).
   */
  loadTmux?: TmuxBackendLike;
  /** The worker sessionId — the tmux backend derives its DETERMINISTIC `comis-<id>` name from it (survival). */
  sessionId: string;
  /**
   * BL-01 (165-REVIEW): RE-ATTACH ONLY (recover-on-boot). When `true` the tmux branch
   * calls {@link TmuxBackendLike.reattach} (attach to an EXISTING session by name; a GONE
   * session yields `undefined` → NOTHING is attached, NEVER a fresh `new-session`) instead
   * of {@link TmuxBackendLike.spawn} — and there is NO pty/pipe fallback (a re-attach with
   * no live tmux session is a genuine death, not a degrade). Absent/false ⇒ today's
   * create-or-attach behavior (byte-identical). The plan's `{bin,argv}` are NOT used on
   * this path (the surviving pane is read, never re-spawned).
   */
  attachOnly?: boolean;
  /** RECUR-03: on the `attachOnly` re-attach, the surviving session's OWN per-boot `-S` socket
   *  (from its descriptor) — forwarded to {@link TmuxBackendLike.reattach} so it targets THAT
   *  server, not this boot's. Absent ⇒ the worker's legacy single-socket default. */
  tmuxSocket?: string;
}

/**
 * Attach a session's backend (PTY or, fail-soft, the degraded pipe). EXACT movement of the block
 * formerly inline in `handleCreate`:
 *   - try `loadPty()`; on throw WARN `errorKind:"dependency"` + flip `state.backend="degraded"`.
 *   - PTY branch: `pty.spawn(plan.bin, plan.argv, {cols,rows,env:plan.env})`, wire
 *     `onData`→`appendRing(state,d)`, `onExit`→`markExited(state)` (payload ignored — only the
 *     exit signal matters; WITHOUT it a real node-pty child exit never notifies an in-flight
 *     `wait({forExit:true})`), set `state.pty`.
 *   - degraded branch: `spawnPipe(plan.bin, plan.argv, {env:plan.env})` (ALSO bwrap-wrapped — no
 *     unjailed degraded path), wire `stdout.on("data")`→appendRing, `close`/`error`→markExited,
 *     set `state.pipe`.
 *
 * Returns `true` when a backend was attached (the create path ALWAYS attaches one) and
 * `false` ONLY on the BL-01 `attachOnly` re-attach of a gone session (or no tmux backend)
 * — the caller (`handleReattach`) maps `false` to a worker `ok:false` reply.
 */
export function attachBackend(args: AttachBackendArgs): boolean {
  const { plan, cols, rows, state, loadPty, spawnPipe, logger, requestedBackend, loadTmux, sessionId, attachOnly, tmuxSocket } = args;

  // BL-01 (165-REVIEW): the recover-on-boot RE-ATTACH path — attach to an EXISTING tmux
  // session by name, NEVER create. A GONE session (reattach → undefined) attaches NOTHING
  // and returns false (the worker replies ok:false → the registry flips lost); there is NO
  // pty/pipe fallback (a re-attach with no live session is a genuine death, not a degrade).
  if (attachOnly === true) {
    if (loadTmux === undefined) return false; // cannot re-attach without the tmux backend.
    const handle = loadTmux.reattach({ sessionId, cols, rows, env: plan.env, tmuxSocket });
    if (handle === undefined) return false; // the tmux session is gone — honest death (I10).
    handle.onData((d) => appendRing(state, d));
    handle.onExit((e) => {
      markExited(state, logger, e?.exitCode);
    });
    state.pty = handle;
    state.backend = "tmux";
    return true;
  }

  // 124-08 (OPS-05): the tmux named-session backend — selected ONLY when the create frame
  // requested it AND the worker was built with the tmux loader. The handle is FakePtyLike-
  // shaped, so it wires EXACTLY like the pty branch (onData→ring, onExit→markExited, set
  // state.pty so writeToBackend uses it) — one seam, no worker-entry branching. The driven
  // plan command + geometry ride into the loader; the loader owns has-session-then-attach.
  if (requestedBackend === "tmux" && loadTmux !== undefined) {
    const handle = loadTmux.spawn({
      sessionId,
      bin: plan.bin,
      argv: plan.argv,
      cols,
      rows,
      env: plan.env,
    });
    handle.onData((d) => appendRing(state, d));
    handle.onExit((e) => {
      markExited(state, logger, e?.exitCode);
    });
    state.pty = handle;
    state.backend = "tmux";
    return true;
  }

  let pty: PtyModuleLike | undefined;
  try {
    pty = loadPty();
  } catch (err) {
    // TR-08: node-pty unavailable → the pipe backend, reported as degraded.
    logger.warn(
      { err, hint: "node-pty unavailable; pipe fallback", errorKind: "dependency" as const },
      "terminal worker degraded",
    );
    state.backend = "degraded";
  }

  if (pty !== undefined) {
    // PTY backend — spawn the bwrap jail; the child rides after the composer's `--`.
    const handle = pty.spawn(plan.bin, plan.argv, { cols, rows, env: plan.env });
    handle.onData((d) => appendRing(state, d));
    // Wire child exit -> markExited (the pty analog of the pipe close/error below).
    // WITHOUT it a real node-pty child that exits never notifies an in-flight
    // wait({forExit:true}) (the VPS real-PTY gate). 124-06: the exit code rides
    // through so the `status` frame can surface it (spec §5 `exitCode`).
    handle.onExit((e) => {
      markExited(state, logger, e?.exitCode);
    });
    state.pty = handle;
  } else {
    // Pipe backend (degraded) — ALSO wrapped in bwrap (no unjailed degraded path).
    const child = spawnPipe(plan.bin, plan.argv, { env: plan.env });
    child.stdout?.on("data", (chunk: Buffer) => appendRing(state, chunk.toString("utf8")));
    child.on("close", () => {
      markExited(state, logger);
    });
    child.on("error", () => {
      markExited(state, logger);
    });
    state.pipe = child;
  }
  // The create path always attaches a backend (pty or the degraded pipe) — the only
  // not-attached outcome is the attachOnly re-attach of a gone session (handled above).
  return true;
}
