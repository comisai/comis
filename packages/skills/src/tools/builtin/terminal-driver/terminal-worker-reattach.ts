// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-reattach -- the worker's `reattach` frame handler (BL-01,
 * 165-REVIEW), extracted from `terminal-worker-entry.ts` so that file keeps headroom
 * under the 800-line architecture cap.
 *
 * THE BUG IT FIXES (the recover-on-boot ZOMBIE). The registry rehydrates a recovered
 * durable session `running`, but the freshly-spawned worker has an EMPTY `sessions`
 * map and only re-attaches a tmux pane inside `handleCreate`. So a recovered session's
 * first `read`/`status` returned `alive:false` — a zombie `running` that swallows every
 * read. This handler is the missing seam: the `reattach` frame the registry sends for a
 * recovered session.
 *
 * THE CONTRACT (I10 — never double-drive). It attaches to an EXISTING detached tmux
 * session BY NAME (`attachBackend({ attachOnly:true })` → `loadTmux.reattach`, which is
 * `has-session`-gated). A LIVE session is REGISTERED `running` and the handler replies
 * `ok:true` (the next `read` returns the live pane). A GONE session (reattach →
 * undefined) / no tmux backend registers NOTHING and replies `ok:false` (the registry
 * flips `lost` + fires `onUnrecoverable` — honest death, NEVER a fresh `new-session` /
 * a second CLI). No bwrap plan composition: the surviving pane is read, never re-spawned.
 *
 * INFRA-FREE (like every worker-side sibling): value-imports ONLY sibling skills leaves +
 * `@comis/shared` (`suppressError`); never `@comis/infra` / `@comis/observability`.
 *
 * @module
 */

import { suppressError } from "@comis/shared";

import { attachBackend } from "./terminal-worker-backend-attach.js";
import { createAttentionEmitter } from "./terminal-attention-emitter.js";
import { observeSettledFrame } from "./terminal-worker-classify.js";
import type { SessionEmulator } from "./terminal-render.js";
import type { TerminalRequestFrame } from "./terminal-ipc.js";
import type {
  PtyModuleLike,
  PipeChildLike,
  SessionState,
  TmuxBackendLike,
  WorkerBackend,
  WorkerLogger,
} from "./terminal-worker-types.js";

/** The worker-closure pieces the reattach handler needs (passed by the entry's dispatch — no module state). */
export interface ReattachWorkerArgs {
  frame: TerminalRequestFrame;
  /** The worker's closure-local per-session map (the re-attached session is registered here). */
  sessions: Map<string, SessionState>;
  /** The worker's @xterm emulator factory. */
  createEmulator: (opts: { cols: number; rows: number; scrollback: number }) => SessionEmulator;
  /** The worker's fd3 attention writer (absent ⇒ no emitter). */
  writeFd3?: (b: Buffer) => void;
  /** The worker's injected clock. */
  nowMs: () => number;
  /** The operator stuck threshold (OPS-04). */
  stuckMs: number;
  /** The worker's structural logger. */
  logger: WorkerLogger;
  /** The worker's node-pty loader (unused on the attach-only path; threaded for the attachBackend contract). */
  loadPty: () => PtyModuleLike;
  /** The worker's pipe spawner (unused on the attach-only path). */
  spawnPipe: (bin: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => PipeChildLike;
  /** The tmux backend loader — REQUIRED to re-attach (absent ⇒ ok:false). */
  loadTmux?: TmuxBackendLike;
  /** The child env for the tmux command (capture-pane). */
  envSnapshot: () => NodeJS.ProcessEnv;
  /** The per-session scrollback ceiling (the worker's SCROLLBACK_DEFAULT). */
  scrollbackDefault: number;
}

/**
 * Handle a `reattach` frame (BL-01). Returns `{ ok, backend }`; the entry maps `ok:false`
 * straight onto the reply's `ok` channel (the registry flips `lost`). Total/never-throws
 * (the dispatch try/catch is the boundary, but this path has no throw site).
 */
export async function reattachWorkerSession(args: ReattachWorkerArgs): Promise<{ ok: boolean; backend: WorkerBackend }> {
  const { frame, sessions, createEmulator, writeFd3, nowMs, stuckMs, logger } = args;
  const p = frame.params;
  const sessionId = String(p["sessionId"] ?? frame.sessionId);
  const cols = typeof p["cols"] === "number" ? p["cols"] : 80;
  const rows = typeof p["rows"] === "number" ? p["rows"] : 24;
  // RECUR-03: the surviving session's OWN per-boot socket (the daemon threads it from the
  // descriptor onto the reattach frame) — re-attach targets THAT server, not this boot's fresh one.
  const tmuxSocket = typeof p["tmuxSocket"] === "string" ? (p["tmuxSocket"] as string) : undefined;

  const state: SessionState = {
    backend: "tmux",
    cols,
    rows,
    ring: "",
    alive: true,
    interactions: 0,
    ringListeners: new Set(),
    exitListeners: new Set(),
  };
  state.emu = createEmulator({ cols, rows, scrollback: args.scrollbackDefault });
  if (writeFd3 !== undefined) {
    const emitter = createAttentionEmitter({ sessionId, writeFd3 });
    state.emitter = emitter;
    state.observeExit = () => {
      suppressError(
        observeSettledFrame({ state, emitter, settled: true, nowMs, stuckMs }),
        "terminal exit-wake fd3 emit",
        (m) => logger.debug({ submodule: "exit-wake", sessionId, errorKind: "internal" }, m),
      );
    };
  }
  // attachOnly: re-attach the surviving pane (never new-session). bin/argv are unused on
  // this path — the pane is read, not re-spawned. envSnapshot() rides as the tmux command env.
  const attached = attachBackend({
    plan: { bin: "", argv: [], env: args.envSnapshot() },
    cols,
    rows,
    state,
    loadPty: args.loadPty,
    spawnPipe: args.spawnPipe,
    logger,
    requestedBackend: "tmux",
    loadTmux: args.loadTmux,
    sessionId,
    attachOnly: true,
    tmuxSocket,
  });
  if (!attached) {
    logger.warn(
      { sessionId, hint: "re-attach failed (tmux session gone or no tmux backend); the registry flips the durable drive lost (journal preserved)", errorKind: "dependency" as const, step: "reattach_gone" },
      "terminal worker re-attach failed (session gone)",
    );
    return { ok: false, backend: state.backend };
  }
  sessions.set(sessionId, state);
  logger.info({ sessionId, backend: state.backend, step: "reattach" }, "terminal session re-attached");
  return { ok: true, backend: state.backend };
}
