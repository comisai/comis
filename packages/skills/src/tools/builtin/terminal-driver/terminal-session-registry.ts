// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-side TerminalSessionRegistry (spec §2.1, OPS-01).
 *
 * Owns the `Map<sessionId,SessionHandle>` and the single supervised worker
 * handle. Spawns the Terminal Worker (119-03 `terminal-worker-entry.ts`) under
 * the 118-proven `--permission` posture via the daemon's existing
 * `--allow-child-process`, and exchanges length-prefixed JSON frames (119-02
 * `terminal-ipc.ts`) over the worker's stdio pipes: requests/replies on the
 * stdin/stdout pair, correlated by `(sessionId,requestId)`.
 *
 * Crash isolation (OPS-01): the worker is a SEPARATE process, so a node-pty /
 * PTY / emulator crash there is isolated by construction. The registry attaches
 * `child.on("error")` / `child.on("close")` handlers (mirroring
 * exec-background.ts) that flip the affected sessions to `lost`/`exited` and
 * CLEAR the worker handle — the daemon stays up, and the next `create`
 * re-spawns the worker lazily. A crash restarts the WORKER, never the daemon.
 *
 * This module is a FACTORY (`createTerminalSessionRegistry(deps)`) closing over
 * a LOCAL session map + worker handle — there is NO module-global mutable state
 * (the `globals.test.ts` / no-module-global architecture rule). `deps` injects
 * `{ spawnWorker, logger, nowMs }` so tests substitute a fake child.
 *
 * M-1: `create` forwards the daemon-canonical `{bin,argv}` (buildDirectSpawn's
 * output, 119-02 — the SOLE canonicalization site) to the worker VERBATIM. The
 * registry does NOT re-canonicalize; argsPrefix is preserved end-to-end.
 *
 * No `@comis/infra` value-import — the registry takes an injected structural
 * logger; the daemon (composition root, 119-04 wiring) passes the real logger.
 *
 * @module
 */

import { spawn as childSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { systemNowMs, systemEnvSnapshot } from "@comis/core";

import {
  encodeFrame,
  createFrameDecoder,
  correlate,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
} from "./terminal-ipc.js";

// ---------------------------------------------------------------------------
// Injected dependency contracts
// ---------------------------------------------------------------------------

/**
 * A structural logger — the minimal `{ info, debug, warn, error }` surface. NOT
 * `getLogger` from `@comis/infra` (the registry must never value-import infra).
 */
export interface RegistryLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The structural shape of the spawned worker child — a subset of
 * `ChildProcess`. The registry writes request frames to `stdin`, reads reply
 * frames off `stdout`, and supervises via `on("error"/"close")`.
 */
export interface FakeWorkerChild {
  pid?: number;
  stdin: { write(chunk: Buffer): boolean } | null;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  on(event: string, cb: (arg?: unknown) => void): FakeWorkerChild;
  kill(signal?: string): void;
}

/** Registry dependencies — all injectable for unit tests; production defaults provided. */
export interface TerminalSessionRegistryDeps {
  /**
   * Spawn the supervised worker child. Default (production):
   * `child_process.spawn(process.execPath, [...workerPermissionArgs, workerJs],
   * { stdio: ["pipe","pipe","pipe","pipe"], env: systemEnvSnapshot() })`.
   */
  spawnWorker: () => FakeWorkerChild;
  /** Structural logger (daemon injects the real one). */
  logger: RegistryLogger;
  /** Clock port. Default: `systemNowMs` from `@comis/core`. */
  nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The lifecycle status of a terminal session. */
export type SessionStatus = "running" | "exited" | "lost";

/** A daemon-side session record. */
export interface SessionHandle {
  sessionId: string;
  allowId: string;
  /** The canonical command (bin) the session drives — for `list`/audit display. */
  command: string;
  status: SessionStatus;
  cols: number;
  rows: number;
  lastActivity: number;
  exitCode?: number;
}

/** A `create` request — the daemon passes buildDirectSpawn's `{bin,argv}` (M-1). */
export interface CreateRequest {
  allowId: string;
  bin: string;
  argv: string[];
  cols: number;
  rows: number;
}

/** The `create` result handed back to the tool layer. */
export interface CreateResult {
  sessionId: string;
  allowId: string;
  cols: number;
  rows: number;
}

/** The terminal view returned by `read` (H-1) — the 119-04 round-trip shape. */
export interface TerminalView {
  screen: string;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  alt: boolean;
  alive: boolean;
}

/** A `list` row — the create-time + liveness summary. */
export interface SessionListing {
  sessionId: string;
  allowId: string;
  command: string;
  alive: boolean;
  lastActivity: number;
}

/** The registry's public surface. */
export interface TerminalSessionRegistry {
  create(req: CreateRequest): Promise<CreateResult>;
  read(sessionId: string): Promise<TerminalView>;
  get(sessionId: string): SessionHandle | undefined;
  list(): SessionListing[];
  kill(sessionId: string): Promise<void>;
  size(): number;
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Production worker-launch posture (118-SPIKE-GO.md)
// ---------------------------------------------------------------------------

/**
 * The 118-proven worker-launch permission posture (the daemon spawns the worker
 * under this via its existing `--allow-child-process`). node-pty `forkpty` was
 * proven to allocate a controlling pty under EXACTLY this posture on the VPS.
 * `--allow-fs-write` scopes are supplied by the production `spawnWorker` (the
 * worker's durable-state dir + /tmp), keyed to the data dir at wiring time.
 */
export const WORKER_PERMISSION_ARGS: readonly string[] = [
  "--permission",
  "--allow-addons",
  "--allow-worker",
  "--allow-fs-read=*",
  "--allow-child-process",
];

/**
 * Build the production `spawnWorker` default: forks `node <permission-args>
 * <workerJsPath>` with a 4-fd stdio (fd3 is the events push channel per spec
 * §2.3), scoping fs-writes to the worker's durable-state dir + /tmp. The daemon
 * (119-04 wiring) constructs this with the resolved `workerJsPath` + `dataDir`.
 */
export function buildProductionSpawnWorker(
  workerJsPath: string,
  dataDir: string,
): () => FakeWorkerChild {
  const args = [
    ...WORKER_PERMISSION_ARGS,
    `--allow-fs-write=${dataDir}/terminal-worker`,
    "--allow-fs-write=/tmp",
    workerJsPath,
  ];
  return () =>
    childSpawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: systemEnvSnapshot(),
    }) as unknown as FakeWorkerChild;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Generate a unique session id (mirrors process-registry's `generateSessionId`). */
function generateSessionId(): string {
  return randomUUID();
}

/**
 * Create a TerminalSessionRegistry. The session map + the worker handle + the
 * pending-reply map are all CLOSURE-local — there is no module-global mutable
 * state. The worker is spawned lazily and re-spawned after a crash clears the
 * handle (OPS-01).
 */
export function createTerminalSessionRegistry(
  deps: TerminalSessionRegistryDeps,
): TerminalSessionRegistry {
  // Closure-local — NOT module scope (no module-global mutable state).
  const sessions = new Map<string, SessionHandle>();
  const pending = new Map<string, (f: TerminalReplyFrame) => void>();
  let worker: FakeWorkerChild | undefined;

  const nowMs = deps.nowMs ?? systemNowMs;
  const { logger } = deps;

  /** Clear the worker handle and flush its pending waiters (on crash / close). */
  function clearWorker(): void {
    worker = undefined;
    // Reject every in-flight reply waiter — the worker is gone.
    for (const [key, resolve] of pending) {
      pending.delete(key);
      resolve({
        sessionId: "",
        requestId: "",
        ok: false,
        error: "worker terminated",
      });
    }
  }

  /**
   * Ensure a live worker handle, spawning + supervising one if absent. The
   * crash handlers flip this worker's sessions to `lost`/`exited` and clear the
   * handle, so the next `ensureWorker()` re-spawns — the daemon stays up across
   * a worker crash (OPS-01). Mirrors exec-background.ts's close/error handlers.
   */
  function ensureWorker(): FakeWorkerChild {
    if (worker !== undefined) return worker;

    const child = deps.spawnWorker();
    worker = child;

    // Decode reply frames off the worker's stdout and correlate them to waiters.
    const decoder = createFrameDecoder();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        correlate(pending, frame as TerminalReplyFrame);
      }
    });

    // OPS-01: a worker error flips its sessions to `lost` and clears the handle.
    child.on("error", (err) => {
      logger.warn(
        { err, hint: "terminal worker error; sessions lost, worker will re-spawn", errorKind: "dependency" },
        "terminal worker error",
      );
      for (const handle of sessions.values()) {
        if (handle.status === "running") handle.status = "lost";
      }
      clearWorker();
    });

    // OPS-01: a worker close flips its sessions to `exited(code)` and clears.
    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : null;
      logger.info(
        { exitCode, hint: "terminal worker closed; sessions exited, worker will re-spawn", errorKind: "dependency" },
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

    return child;
  }

  /** Build a request frame with a fresh requestId + trace id. */
  function buildRequestFrame(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): TerminalRequestFrame {
    return {
      sessionId,
      requestId: randomUUID(),
      // P0: a fresh trace id per frame (the tool layer threads the real ALS
      // traceId in 119-04). The worker re-establishes whatever traceId arrives.
      traceId: randomUUID(),
      method,
      params,
    };
  }

  /**
   * Fire a request frame to the worker WITHOUT awaiting a reply (fire-and-
   * register). Used for `create`: the worker spawns the backend asynchronously;
   * the daemon registers the handle immediately and fetches the rendered view
   * later via `read`. Returns the requestId for optional later correlation.
   */
  function send(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const child = ensureWorker();
    child.stdin?.write(encodeFrame(buildRequestFrame(sessionId, method, params)));
  }

  /** Send a request frame to the worker and await its correlated reply. */
  function request(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<TerminalReplyFrame> {
    const child = ensureWorker();
    const frame = buildRequestFrame(sessionId, method, params);
    return new Promise<TerminalReplyFrame>((resolve) => {
      pending.set(`${sessionId}:${frame.requestId}`, resolve);
      child.stdin?.write(encodeFrame(frame));
    });
  }

  async function create(req: CreateRequest): Promise<CreateResult> {
    ensureWorker();
    const sessionId = generateSessionId();

    // M-1: forward the daemon-canonical {bin,argv} to the worker VERBATIM. The
    // registry does NOT re-canonicalize — buildDirectSpawn (119-02) is the SOLE
    // canonicalization site; argsPrefix is preserved end-to-end. The create
    // frame is FIRED (fire-and-register): the worker spawns the backend
    // asynchronously; the rendered view is fetched later via `read`.
    send(sessionId, "create", {
      sessionId,
      bin: req.bin,
      argv: req.argv,
      cols: req.cols,
      rows: req.rows,
    });

    const handle: SessionHandle = {
      sessionId,
      allowId: req.allowId,
      command: req.bin,
      status: "running",
      cols: req.cols,
      rows: req.rows,
      lastActivity: nowMs(),
    };
    sessions.set(sessionId, handle);
    logger.info(
      { sessionId, allowId: req.allowId, command: req.bin },
      "terminal session registered",
    );
    return { sessionId, allowId: req.allowId, cols: req.cols, rows: req.rows };
  }

  async function read(sessionId: string): Promise<TerminalView> {
    const handle = sessions.get(sessionId);
    if (handle === undefined || handle.status !== "running") {
      // Not found / not alive — a minimal view the 119-04 tool layer maps.
      return {
        screen: "",
        cursor: { x: 0, y: 0 },
        cols: handle?.cols ?? 0,
        rows: handle?.rows ?? 0,
        alt: false,
        alive: false,
      };
    }
    const reply = await request(sessionId, "read", { sessionId });
    handle.lastActivity = nowMs();
    if (!reply.ok || reply.result === undefined) {
      return { screen: "", cursor: { x: 0, y: 0 }, cols: handle.cols, rows: handle.rows, alt: false, alive: false };
    }
    return reply.result as TerminalView;
  }

  function get(sessionId: string): SessionHandle | undefined {
    return sessions.get(sessionId);
  }

  function list(): SessionListing[] {
    return Array.from(sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      allowId: s.allowId,
      command: s.command,
      alive: s.status === "running",
      lastActivity: s.lastActivity,
    }));
  }

  async function kill(sessionId: string): Promise<void> {
    const handle = sessions.get(sessionId);
    if (handle === undefined) return;
    if (worker !== undefined && handle.status === "running") {
      // Fire the kill frame (fire-and-forget): the session is dropped locally
      // regardless of the worker's reply, so `list()` no longer contains it.
      send(sessionId, "kill", { sessionId });
    }
    // Drop the killed session so `list()` no longer contains it (supports TR-01).
    sessions.delete(sessionId);
    logger.info({ sessionId }, "terminal session killed");
  }

  function size(): number {
    return sessions.size;
  }

  async function cleanup(): Promise<void> {
    for (const sessionId of Array.from(sessions.keys())) {
      await kill(sessionId);
    }
    if (worker !== undefined) {
      worker.kill("SIGTERM");
      clearWorker();
    }
  }

  return { create, read, get, list, kill, size, cleanup };
}
