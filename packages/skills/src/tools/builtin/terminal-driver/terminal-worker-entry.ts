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
import { createRequire } from "node:module";
import {
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  openSync as fsOpenSync,
  fsyncSync as fsFsyncSync,
  closeSync as fsCloseSync,
} from "node:fs";

import { systemNowMs, systemEnvSnapshot, runWithContext } from "@comis/core";
import { isFsyncDisabledByPermissionModel } from "@comis/shared";

import type { TerminalReplyFrame, TerminalRequestFrame } from "./terminal-ipc.js";

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
 * worker wires `onData` into the per-session ring and forwards write/resize/kill.
 */
export interface FakePtyLike {
  pid: number;
  onData(cb: (data: string) => void): void;
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Terminal Worker. The per-session backend + ring map is CLOSURE-local
 * — there is no module-global mutable state. Each `handle(frame)` re-establishes
 * the frame's `traceId` as the ALS context (OPS-07) so worker logs correlate to
 * the originating turn, then dispatches by `frame.method`.
 */
export function createTerminalWorker(deps: TerminalWorkerDeps): TerminalWorker {
  // Closure-local — NOT module scope (no module-global mutable state).
  const sessions = new Map<string, SessionState>();

  const nowMs = deps.nowMs ?? systemNowMs;
  const envSnapshot = deps.envSnapshot ?? systemEnvSnapshot;
  const spawnPipe = deps.spawnPipe ?? defaultSpawnPipe;
  const fs = deps.fs ?? defaultFsPort;
  const { logger } = deps;

  /** Append a chunk to a session's stdout ring. */
  function appendRing(state: SessionState, chunk: string): void {
    state.ring += chunk;
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
    };

    let pty: PtyModuleLike | undefined;
    try {
      pty = deps.loadPty();
    } catch (err) {
      // TR-08: node-pty unavailable → the pipe backend, reported as degraded.
      logger.warn(
        { err, hint: "node-pty unavailable; pipe fallback", errorKind: "dependency" },
        "terminal worker degraded",
      );
      state.backend = "degraded";
    }

    if (pty !== undefined) {
      // PTY backend — spawn from the frame's bin/argv (no re-canonicalization).
      const handle = pty.spawn(bin, argv, { cols, rows, env: envSnapshot() });
      handle.onData((d) => appendRing(state, d));
      state.pty = handle;
    } else {
      // Pipe backend (degraded) — mirror exec-background.ts stdio wiring.
      const child = spawnPipe(bin, argv, { env: envSnapshot() });
      child.stdout?.on("data", (chunk: Buffer) => appendRing(state, chunk.toString("utf8")));
      child.on("close", () => {
        state.alive = false;
      });
      child.on("error", () => {
        state.alive = false;
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

  /** Dispatch a decoded request frame to its method handler. */
  function dispatch(frame: TerminalRequestFrame): TerminalReplyFrame {
    try {
      let result: unknown;
      switch (frame.method) {
        case "create":
          result = handleCreate(frame);
          break;
        case "read":
          result = handleRead(frame);
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
        { err, hint: "worker frame dispatch failed", errorKind: "worker", method: frame.method },
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
      return runWithContext(
        {
          tenantId: "default",
          traceId: frame.traceId,
          startedAt: nowMs(),
          trustLevel: "admin",
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
