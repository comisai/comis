// SPDX-License-Identifier: Apache-2.0
/**
 * The supervised Terminal Worker entry (spec §2.1/§2.2/§2.3).
 *
 * The worker is the one net-new process boundary: a daemon-supervised child
 * that owns the PTY (node-pty, optional) and the driven CLI. The daemon-side
 * registry (119-03 `terminal-session-registry.ts`) spawns it under the
 * 118-proven `--permission` posture and exchanges length-prefixed JSON frames
 * (119-02 `terminal-ipc.ts`) over its stdio pipes.
 *
 * This module is a FACTORY (`createTerminalWorker(deps)`) so it is fully
 * unit-testable WITHOUT forking a process: the node-pty loader, the structural
 * logger, the clock, the env snapshot, the pipe spawner, and the durable-fs ops
 * are all injected. The default production deps (used only when the worker runs
 * as a real forked process) wire `child_process.spawn`, `node:fs`, and the
 * `@comis/core` system-time ports.
 *
 * Architecture invariants enforced here:
 *   - NO top-level static `import … from "node-pty"` — node-pty is loaded via
 *     the INJECTED `loadPty` dep (default: a guarded `createRequire` load inside
 *     a try). A throw selects the PIPE backend and reports `backend:"degraded"`
 *     (TR-08) — never an unhandled module-load / spawn crash.
 *   - NO module-global mutable state — the per-session backend + stdout-ring map
 *     is CLOSURE-local to the factory.
 *   - NO `@comis/infra` value-import — the worker takes an injected structural
 *     logger (`{ info, debug, warn, error }`), like `process-tool.ts`'s
 *     ToolLogger. The daemon (composition root) passes the real logger.
 *   - NO redundant path-canonicalization — the worker spawns from the create
 *     frame's `{bin,argv}` (the daemon canonicalized via `buildDirectSpawn`, the
 *     SOLE canonicalization site, 119-02). argsPrefix is preserved end-to-end
 *     (M-1).
 *   - NO raw wall-clock / timer / env globals — injected/system-time ports only
 *     (`globals.test.ts`).
 *
 * @module
 */

import { spawn as childSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  openSync as fsOpenSync,
  fsyncSync as fsFsyncSync,
  closeSync as fsCloseSync,
} from "node:fs";

import {
  systemNowMs,
  systemEnvSnapshot,
  runWithContext,
  systemSetTimeout,
  systemClearTimeout,
  type SystemTimeoutHandle,
} from "@comis/core";
import { isFsyncDisabledByPermissionModel } from "@comis/shared";

import type { TerminalReplyFrame, TerminalRequestFrame } from "./terminal-ipc.js";
import { encodeKeyChord } from "./terminal-key-grammar.js";
import {
  runSettle,
  SETTLE_DEFAULT_IDLE_MS,
  type SettleDeps,
  type SettleParams,
  type SettleResult,
} from "./terminal-settle.js";

// ---------------------------------------------------------------------------
// Injected dependency contracts
// ---------------------------------------------------------------------------

/**
 * A structural logger — the minimal `{ info, debug, warn, error }` surface the
 * worker needs. NOT `getLogger` from `@comis/infra` (the worker must never
 * value-import infra); the daemon injects the real logger.
 */
export interface WorkerLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The structural shape of a node-pty session handle (a subset of `IPty`). The
 * worker wires `onData` into the per-session ring, `onExit` into the liveness
 * flip (markExited — the pty analog of the pipe backend's `close`/`error`), and
 * forwards write/resize/kill. node-pty's real `IPty.onExit` is an event whose
 * listener receives `{exitCode, signal}`; the structural subset here mirrors that
 * call shape (the worker ignores the payload — it only needs the exit signal).
 */
export interface FakePtyLike {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** The structural shape of the node-pty module (only `spawn` is used here). */
export interface PtyModuleLike {
  spawn(
    bin: string,
    argv: string[],
    opts: { cols: number; rows: number; env: NodeJS.ProcessEnv },
  ): FakePtyLike;
}

/**
 * The pipe-backend spawn shape — a structural subset of `child_process.spawn`'s
 * return. The worker wires `stdout.on("data")` into the ring; close/error flip
 * `alive`.
 */
export interface PipeChildLike {
  pid?: number;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  stdin: { write(data: string): void } | null;
  on(event: "close" | "error", cb: (arg?: unknown) => void): void;
  kill(signal?: string): void;
}

/** The durable-fs ops the worker uses — injected so the fsync-thrower test runs on macOS. */
export interface WorkerFsPort {
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  openSync(path: string, flags: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

/** Worker dependencies — all injectable for unit tests; production defaults provided. */
export interface TerminalWorkerDeps {
  /**
   * Load node-pty. Default (production): a guarded `createRequire` load inside a
   * try — NEVER a top-level static import (that crashes module load on a
   * no-prebuild host). A throw → the worker selects the pipe backend (TR-08).
   */
  loadPty: () => PtyModuleLike;
  /** Spawn the pipe-backend child. Default: `child_process.spawn` with stdio pipes. */
  spawnPipe?: (
    bin: string,
    argv: string[],
    opts: { env: NodeJS.ProcessEnv },
  ) => PipeChildLike;
  /** Structural logger (daemon injects the real one). */
  logger: WorkerLogger;
  /** Clock port. Default: `systemNowMs` from `@comis/core`. */
  nowMs?: () => number;
  /** Env snapshot for the child spawn. Default: `systemEnvSnapshot` from `@comis/core`. */
  envSnapshot?: () => NodeJS.ProcessEnv;
  /** Durable-fs ops. Default: `node:fs` sync ops. */
  fs?: WorkerFsPort;
  /**
   * Schedule a one-shot timer. Default (production): wraps `systemSetTimeout`
   * from `@comis/core` (the sanctioned timer indirection — no raw `setTimeout`
   * global) and `.unref()`s the handle so a pending in-worker settle timer never
   * holds the event loop open. Returns an opaque handle for `clearTimer`. The
   * settle engine (Plan 02) routes EVERY timer through this — mirrors the
   * registry's MR-01 port shape.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// Frame result shapes
// ---------------------------------------------------------------------------

/** Which backend a session is driven by — `degraded` is the pipe fallback (TR-08). */
export type WorkerBackend = "pty" | "degraded";

/** The create-frame reply payload. */
interface CreateResult {
  sessionId: string;
  backend: WorkerBackend;
  cols: number;
  rows: number;
}

/**
 * The read-frame reply payload — the P0 minimal terminal view (H-1). `screen`
 * is the raw per-session stdout ring; the full @xterm grid + real cursor/alt is
 * P2/121. `alive` reflects whether the backend is still running.
 */
interface ReadResult {
  screen: string;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  alt: boolean;
  alive: boolean;
}

/**
 * The post-action snapshot a mutating interaction handler (send_text/send_key)
 * returns (TR-03): the SETTLED `{screen,cursor}` subset. `cursor` stays `{0,0}`
 * until the real emulator cursor lands (P2/121).
 */
interface SendResult {
  screen: string;
  cursor: { x: number; y: number };
}

/** The `resize` reply payload (spec §5: `{ ok }`). */
interface ResizeResult {
  ok: boolean;
}

/**
 * The `wait` reply payload (spec §5 / TR-05): the settle outcome plus the
 * post-settle `{screen,cursor}`. `isComplete` is the LOAD-BEARING signal — it
 * flows through from {@link runSettle} VERBATIM (never coerced) so a timeout's
 * `false` survives (the turn ends; the P5 attention model RESUMES it, never
 * finalizes a live session).
 */
interface WaitResult {
  matched: boolean;
  isComplete: boolean;
  reason: SettleResult["reason"];
  screen: string;
  cursor: { x: number; y: number };
}

/** A closure-local per-session record (NOT module-global). */
interface SessionState {
  backend: WorkerBackend;
  cols: number;
  rows: number;
  /** The accumulated stdout ring (P0: a growing string; a true ring is P2/121). */
  ring: string;
  alive: boolean;
  pty?: FakePtyLike;
  pipe?: PipeChildLike;
  /**
   * Settle subscribers notified when this session's ring grows (the
   * `onRingChange` half of {@link SettleDeps}). Closure-local per session — NOT
   * module-global. `appendRing` notifies these.
   */
  ringListeners: Set<() => void>;
  /**
   * Settle subscribers notified when this session's backend exits (the `onExit`
   * half). The pipe `close`/`error` and (live) pty exit notify these.
   */
  exitListeners: Set<() => void>;
}

/** The worker's public surface — `handle` dispatches a frame; `writeDurable` persists state. */
export interface TerminalWorker {
  handle(frame: TerminalRequestFrame): Promise<TerminalReplyFrame>;
  writeDurable(path: string, data: string): void;
}

// ---------------------------------------------------------------------------
// Production-default deps
// ---------------------------------------------------------------------------

/**
 * The production node-pty loader: a guarded `createRequire` load inside a try.
 * NEVER a top-level static import (that crashes module load when the native
 * addon has no prebuild on the host). A throw here is caught by the worker,
 * which falls back to the pipe backend and reports `degraded` (TR-08). The
 * worker runs as ESM (`"type": "module"`), so `createRequire(import.meta.url)`
 * is the lazy load path; the literal module name is referenced only here, never
 * as a top-level static binding.
 */
function defaultLoadPty(): PtyModuleLike {
  const localRequire = createRequire(import.meta.url);
  return localRequire("node-pty") as PtyModuleLike;
}

/** The production pipe-backend spawner: `child_process.spawn` with stdio pipes (mirrors exec-background.ts). */
function defaultSpawnPipe(
  bin: string,
  argv: string[],
  opts: { env: NodeJS.ProcessEnv },
): PipeChildLike {
  return childSpawn(bin, argv, {
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as PipeChildLike;
}

/** The production durable-fs port over `node:fs` sync ops. */
const defaultFsPort: WorkerFsPort = {
  writeFileSync: (path, data) => fsWriteFileSync(path, data),
  renameSync: (from, to) => fsRenameSync(from, to),
  openSync: (path, flags) => fsOpenSync(path, flags),
  fsyncSync: (fd) => fsFsyncSync(fd),
  closeSync: (fd) => fsCloseSync(fd),
};

// ---------------------------------------------------------------------------
// Inbound-context validation (LR-01)
// ---------------------------------------------------------------------------

/** UUID (8-4-4-4-12 hex) shape — matches `RequestContextSchema.traceId` (`z.guid()`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Bracketed-paste delimiters (spec §5 send_text bracketedPaste)
// ---------------------------------------------------------------------------

/**
 * The DECSET 2004 bracketed-paste START marker. With `bracketedPaste:true` the
 * worker wraps the text in {@link BRACKETED_PASTE_START}…{@link BRACKETED_PASTE_END}
 * so a paste-aware program treats the bytes as DATA (a literal paste), not as
 * typed commands — opt-in containment of what a pasted blob can trigger (T-120-10).
 */
const BRACKETED_PASTE_START = "\x1b[200~";
/** The DECSET 2004 bracketed-paste END marker. */
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Sanitize the inbound wire `traceId` before it becomes the ALS context (LR-01).
 *
 * `runWithContext` does NOT validate against `RequestContextSchema` (whose
 * `traceId` is `z.guid()`), so an arbitrary/attacker-chosen traceId off the wire
 * would be stamped onto every worker log line — log-correlation poisoning (a
 * forged id stitches worker logs to an unrelated turn). We accept a valid UUID
 * verbatim (legitimate correlation preserved) and otherwise REGENERATE a fresh
 * id rather than trusting the wire. The caller logs the substitution.
 */
function sanitizeTraceId(wire: unknown): { traceId: string; regenerated: boolean } {
  if (typeof wire === "string" && UUID_RE.test(wire)) {
    return { traceId: wire, regenerated: false };
  }
  return { traceId: randomUUID(), regenerated: true };
}

/**
 * The least-privileged trust level the worker context runs under (LR-01).
 *
 * The worker performs NO authorization decisions — it only spawns from the
 * already-gated `{bin,argv}` and renders read views. An unconditional
 * `trustLevel:"admin"` was a latent trust-elevation foothold for any future
 * worker-side code that consults `getContext().trustLevel`; `guest` (least
 * privilege) removes it. Worker code MUST NOT make trust decisions — authz lives
 * entirely on the daemon side, before the create frame is ever sent.
 */
const WORKER_TRUST_LEVEL = "guest" as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Terminal Worker. The per-session backend + ring map is CLOSURE-local
 * — there is no module-global mutable state. Each `handle(frame)` re-establishes
 * a VALIDATED `traceId` as the ALS context (OPS-07 / LR-01) so worker logs
 * correlate to the originating turn, then dispatches by `frame.method`.
 */
export function createTerminalWorker(deps: TerminalWorkerDeps): TerminalWorker {
  // Closure-local — NOT module scope (no module-global mutable state).
  const sessions = new Map<string, SessionState>();

  const nowMs = deps.nowMs ?? systemNowMs;
  const envSnapshot = deps.envSnapshot ?? systemEnvSnapshot;
  const spawnPipe = deps.spawnPipe ?? defaultSpawnPipe;
  const fs = deps.fs ?? defaultFsPort;
  const { logger } = deps;
  // The sanctioned timer indirection (no raw setTimeout global). The production
  // default `.unref()`s the handle so a pending in-worker settle timer never
  // holds the event loop open — mirrors the registry's MR-01 port shape.
  const setTimer =
    deps.setTimer ??
    ((cb: () => void, ms: number): SystemTimeoutHandle => {
      const h = systemSetTimeout(cb, ms);
      h.unref();
      return h;
    });
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => systemClearTimeout(handle as SystemTimeoutHandle));

  /**
   * Append a chunk to a session's stdout ring and notify the settle's
   * ring-change subscribers (the `onRingChange` half of {@link SettleDeps}) so a
   * pending `wait`/settle sees the new bytes.
   */
  function appendRing(state: SessionState, chunk: string): void {
    state.ring += chunk;
    for (const cb of state.ringListeners) cb();
  }

  /**
   * Flip a session to not-alive and notify the settle's exit subscribers (the
   * `onExit` half) so a pending `wait`/settle resolves `exit`.
   */
  function markExited(state: SessionState): void {
    state.alive = false;
    for (const cb of state.exitListeners) cb();
  }

  /** Resolve the backend write sink: pty.write for the pty backend, else pipe.stdin.write. */
  function writeToBackend(state: SessionState, bytes: string): void {
    if (state.pty !== undefined) {
      state.pty.write(bytes);
      return;
    }
    state.pipe?.stdin?.write(bytes);
  }

  /**
   * Build the {@link SettleDeps} over a session — the injected timer ports + this
   * session's ring/liveness getters + its closure-local listener sets — and run
   * the bounded settle (Plan 02). The heart of every "act then return the SETTLED
   * snapshot" handler (send_text/send_key) and the explicit `wait`. `params`
   * passes straight through to {@link runSettle}.
   */
  function settleSession(state: SessionState, params: SettleParams): Promise<SettleResult> {
    const settleDeps: SettleDeps = {
      setTimer,
      clearTimer,
      getRing: () => state.ring,
      isAlive: () => state.alive,
      onRingChange: (cb) => {
        state.ringListeners.add(cb);
        return () => state.ringListeners.delete(cb);
      },
      onExit: (cb) => {
        state.exitListeners.add(cb);
        return () => state.exitListeners.delete(cb);
      },
    };
    return runSettle(settleDeps, params);
  }

  /**
   * Handle a `create` frame. Selects the backend (pty if `loadPty` succeeds,
   * else the degraded pipe fallback) and spawns the driven command from the
   * frame's `{bin,argv}` VERBATIM — the daemon already canonicalized via
   * buildDirectSpawn (M-1); the worker does NOT re-canonicalize the path.
   */
  function handleCreate(frame: TerminalRequestFrame): CreateResult {
    const startedAt = nowMs();
    const p = frame.params;
    const sessionId = String(p["sessionId"]);
    const bin = String(p["bin"]);
    const argv = Array.isArray(p["argv"]) ? (p["argv"] as string[]) : [];
    const cols = typeof p["cols"] === "number" ? p["cols"] : 80;
    const rows = typeof p["rows"] === "number" ? p["rows"] : 24;

    const state: SessionState = {
      backend: "pty",
      cols,
      rows,
      ring: "",
      alive: true,
      ringListeners: new Set(),
      exitListeners: new Set(),
    };

    let pty: PtyModuleLike | undefined;
    try {
      pty = deps.loadPty();
    } catch (err) {
      // TR-08: node-pty unavailable → the pipe backend, reported as degraded.
      logger.warn(
        { err, hint: "node-pty unavailable; pipe fallback", errorKind: "dependency" as const },
        "terminal worker degraded",
      );
      state.backend = "degraded";
    }

    if (pty !== undefined) {
      // PTY backend — spawn from the frame's bin/argv (no re-canonicalization).
      const handle = pty.spawn(bin, argv, { cols, rows, env: envSnapshot() });
      handle.onData((d) => appendRing(state, d));
      // Wire the child exit -> markExited, the pty analog of the pipe backend's
      // close/error below. node-pty's onExit fires {exitCode,signal} when the
      // child exits; we ignore the payload (markExited only flips liveness +
      // notifies the settle's exit subscribers). WITHOUT this, a real node-pty
      // child that exits never notifies an in-flight wait({forExit:true}), which
      // then runs to timeout instead of settling "exit" (the VPS real-PTY gate).
      handle.onExit(() => {
        markExited(state);
      });
      state.pty = handle;
    } else {
      // Pipe backend (degraded) — mirror exec-background.ts stdio wiring.
      const child = spawnPipe(bin, argv, { env: envSnapshot() });
      child.stdout?.on("data", (chunk: Buffer) => appendRing(state, chunk.toString("utf8")));
      child.on("close", () => {
        markExited(state);
      });
      child.on("error", () => {
        markExited(state);
      });
      state.pipe = child;
    }

    sessions.set(sessionId, state);
    logger.info(
      { sessionId, backend: state.backend, durationMs: nowMs() - startedAt },
      "terminal session created",
    );
    return { sessionId, backend: state.backend, cols, rows };
  }

  /**
   * Handle a `read` frame (H-1). Returns the P0 minimal view from the
   * per-session stdout ring: `{screen,cursor,cols,rows,alt,alive}`. Full @xterm
   * grid rendering (real cursor/alt-screen) is P2/121.
   */
  function handleRead(frame: TerminalRequestFrame): ReadResult {
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) {
      return { screen: "", cursor: { x: 0, y: 0 }, cols: 0, rows: 0, alt: false, alive: false };
    }
    return {
      screen: state.ring,
      cursor: { x: 0, y: 0 },
      cols: state.cols,
      rows: state.rows,
      alt: false,
      alive: state.alive,
    };
  }

  /** The not-alive minimal `{screen,cursor}` for an absent/gone session. */
  function goneSnapshot(): SendResult {
    return { screen: "", cursor: { x: 0, y: 0 } };
  }

  /** §2.7: one bounded INFO line per interaction handler (method + durationMs). */
  function logInteraction(
    sessionId: string,
    method: string,
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): void {
    logger.info(
      { sessionId, method, durationMs: nowMs() - startedAt, step: "interaction", ...extra },
      "terminal interaction",
    );
  }

  /**
   * Handle a `send_key` frame (TR-04). Encodes the chord via the named-key
   * grammar (Plan 01) and writes the EXACT bytes to the backend ONCE. An unknown
   * key name makes `encodeKeyChord` throw `invalid_value`; the throw is caught and
   * surfaced as a frame-level error with NOTHING written (T-120-01b). Returns the
   * post-action `{screen,cursor}` ring view.
   */
  function handleSendKey(frame: TerminalRequestFrame): SendResult {
    const startedAt = nowMs();
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) return goneSnapshot();

    const keys = Array.isArray(frame.params["keys"]) ? (frame.params["keys"] as string[]) : [];
    // encodeKeyChord throws invalid_value on an unknown key — let it propagate to
    // dispatch's catch, which returns ok:false. Crucially, the write is AFTER the
    // encode, so a throw means NOTHING is written (the keystroke-injection guard).
    const bytes = encodeKeyChord(keys);
    writeToBackend(state, bytes);

    logInteraction(sessionId, "send_key", startedAt, { keyCount: keys.length });
    return { screen: state.ring, cursor: { x: 0, y: 0 } };
  }

  /**
   * Handle a `send_text` frame (TR-04). Writes the text (bracketed-paste-wrapped
   * when asked), settles, and — on `submit` — writes `\r` as a SEPARATE write
   * AFTER the settle resolves (text → settle → Enter; NEVER coalesced, so a
   * program always consumes/echoes the line before it sees Enter). Returns the
   * post-action SETTLED `{screen,cursor}`.
   */
  async function handleSendText(frame: TerminalRequestFrame): Promise<SendResult> {
    const startedAt = nowMs();
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) return goneSnapshot();

    const text = typeof frame.params["text"] === "string" ? frame.params["text"] : "";
    const submit = frame.params["submit"] === true;
    const bracketedPaste = frame.params["bracketedPaste"] === true;

    const payload = bracketedPaste
      ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`
      : text;
    writeToBackend(state, payload);

    // Settle so the program has consumed/echoed the text. On submit the settle
    // SEPARATES the text from the Enter byte (TR-04); without submit it still
    // settles so the returned snapshot is the post-action one.
    await settleSession(state, { forIdleMs: SETTLE_DEFAULT_IDLE_MS });
    if (submit) {
      writeToBackend(state, "\r");
    }

    logInteraction(sessionId, "send_text", startedAt, {
      submit,
      bracketedPaste,
      bytes: payload.length,
    });
    return { screen: state.ring, cursor: { x: 0, y: 0 } };
  }

  /**
   * Handle a `resize` frame (TR-03). Resizes the PTY winsize (pty backend) and
   * records the ring geometry on the session (P1 records cols/rows; the real
   * @xterm grid resize is P2/121). The degraded pipe backend has no winsize —
   * geometry is recorded for P2. Replies `{ ok }`.
   */
  function handleResize(frame: TerminalRequestFrame): ResizeResult {
    const startedAt = nowMs();
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) return { ok: false };

    const cols = typeof frame.params["cols"] === "number" ? frame.params["cols"] : state.cols;
    const rows = typeof frame.params["rows"] === "number" ? frame.params["rows"] : state.rows;

    state.pty?.resize(cols, rows); // pty backend; the pipe backend has no winsize
    state.cols = cols;
    state.rows = rows;

    logInteraction(sessionId, "resize", startedAt, { cols, rows });
    return { ok: true };
  }

  /**
   * Handle a `wait` frame (TR-05) — the explicit, parameterized settle. Runs the
   * bounded {@link runSettle} against the session's ring/liveness and replies
   * `{matched,isComplete,reason,screen,cursor}`. An absent session is effectively
   * gone (reason `exit`, not-complete). CRITICAL: `isComplete` is passed through
   * from {@link runSettle} VERBATIM — it is `false` on a timeout (the worker
   * never holds the frame open; the turn ends and is resumed by the P5 attention
   * model). It is NEVER hard-coded to `true`.
   */
  async function handleWait(frame: TerminalRequestFrame): Promise<WaitResult> {
    const startedAt = nowMs();
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) {
      // A missing session is effectively gone — the honest not-complete shape.
      return { matched: false, isComplete: false, reason: "exit", screen: "", cursor: { x: 0, y: 0 } };
    }

    const params: SettleParams = {
      forIdleMs: typeof frame.params["forIdleMs"] === "number" ? frame.params["forIdleMs"] : undefined,
      forText: typeof frame.params["forText"] === "string" ? frame.params["forText"] : undefined,
      forExit: frame.params["forExit"] === true ? true : undefined,
      timeoutMs: typeof frame.params["timeoutMs"] === "number" ? frame.params["timeoutMs"] : undefined,
    };
    const r = await settleSession(state, params);

    logInteraction(sessionId, "wait", startedAt, { reason: r.reason, isComplete: r.isComplete });
    return {
      matched: r.matched,
      isComplete: r.isComplete, // VERBATIM from runSettle — false on timeout.
      reason: r.reason,
      screen: state.ring,
      cursor: { x: 0, y: 0 },
    };
  }

  /** Dispatch a decoded request frame to its method handler. */
  async function dispatch(frame: TerminalRequestFrame): Promise<TerminalReplyFrame> {
    try {
      let result: unknown;
      switch (frame.method) {
        case "create":
          result = handleCreate(frame);
          break;
        case "read":
          result = handleRead(frame);
          break;
        case "send_key":
          result = handleSendKey(frame);
          break;
        case "send_text":
          // ASYNC: send_text awaits the settle that separates text from submit.
          result = await handleSendText(frame);
          break;
        case "resize":
          result = handleResize(frame);
          break;
        case "wait":
          // ASYNC: wait awaits the bounded settle (idle/text/exit/timeout).
          result = await handleWait(frame);
          break;
        default:
          return {
            sessionId: frame.sessionId,
            requestId: frame.requestId,
            ok: false,
            error: `unknown method: ${frame.method}`,
          };
      }
      return { sessionId: frame.sessionId, requestId: frame.requestId, ok: true, result };
    } catch (err) {
      logger.error(
        { err, hint: "worker frame dispatch failed", errorKind: "internal" as const, method: frame.method },
        "terminal worker frame error",
      );
      return {
        sessionId: frame.sessionId,
        requestId: frame.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Persist durable worker state via write→rename, swallowing ONLY the
   * disabled-fsync refusal under `--permission` (G-4). A genuine I/O error
   * (EIO/ENOSPC/EBADF) is re-thrown so real disk problems are not masked. The
   * fsync is best-effort hardening over an already-completed write+rename —
   * skipping it only widens the power-failure window, never loses data.
   */
  function writeDurable(path: string, data: string): void {
    const tmp = `${path}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, path);
    let fd: number | undefined;
    try {
      fd = fs.openSync(path, "r");
      fs.fsyncSync(fd);
    } catch (err) {
      if (!isFsyncDisabledByPermissionModel(err)) throw err;
      // Refused under --permission — swallow ONLY this; the write+rename is durable.
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // closing a possibly-refused fd is best-effort.
        }
      }
    }
  }

  return {
    async handle(frame: TerminalRequestFrame): Promise<TerminalReplyFrame> {
      // OPS-07: re-establish the originating traceId as the ALS context so the
      // bound logger's mixin carries it through worker handling. (ALS does not
      // cross the process boundary — it is re-established from the frame here.)
      //
      // LR-01: the wire traceId is VALIDATED (a non-UUID is regenerated, never
      // trusted — log-correlation-poisoning defense) and the context runs at the
      // least-privileged trust level (the worker makes no authz decisions).
      const { traceId, regenerated } = sanitizeTraceId(frame.traceId);
      if (regenerated) {
        logger.warn(
          { sessionId: frame.sessionId, method: frame.method, hint: "invalid wire traceId; regenerated", errorKind: "validation" as const },
          "terminal worker traceId sanitized",
        );
      }
      return runWithContext(
        {
          tenantId: "default",
          traceId,
          startedAt: nowMs(),
          trustLevel: WORKER_TRUST_LEVEL,
        },
        () => dispatch(frame),
      );
    },
    writeDurable,
  };
}

/**
 * The production node-pty loader, exported so the daemon (when forking a real
 * worker) can wire it as the `loadPty` dep. Tests inject a stub/thrower instead.
 */
export { defaultLoadPty };
