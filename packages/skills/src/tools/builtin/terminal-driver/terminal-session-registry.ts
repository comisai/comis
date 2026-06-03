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

import {
  systemNowMs,
  systemEnvSnapshot,
  systemSetTimeout,
  systemClearTimeout,
  type SystemTimeoutHandle,
} from "@comis/core";

import {
  encodeFrame,
  createFrameDecoder,
  correlate,
  FrameTooLargeError,
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

/** Details handed to `onSpawnFailed` when the worker reports a failed backend spawn (HR-03). */
export interface SpawnFailureInfo {
  /** The session whose backend spawn failed in the worker. */
  sessionId: string;
  /** The worker-reported error message (e.g. `spawn ENOENT`), if any. */
  error?: string;
}

/**
 * Default reply timeout (MR-01): a `request()` (read/kill round-trip) that gets
 * no correlated reply within this window settles to a typed timeout rather than
 * hanging the caller forever + leaking the pending resolver. A wedged-but-alive
 * worker emits no `close`/`error`, so without this bound nothing ever unparks
 * the waiter. 30s is generous for a screen read; the daemon can override via
 * `requestTimeoutMs` (config-derived, e.g. `worker.stuckMs`).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  /**
   * Reply timeout for `request()` round-trips in ms (MR-01). Default
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}. The daemon threads a config-derived value
   * (e.g. `worker.stuckMs`) so a wedged worker degrades `read` instead of hanging.
   */
  requestTimeoutMs?: number;
  /**
   * Called when the worker reports a failed backend spawn via an `ok:false`
   * create reply (HR-03 / OPS-07). The daemon wiring binds this to emit
   * `terminal:spawn_failed`. The session is already flipped to `lost` by the
   * registry before this fires. Injected (not a value-imported event bus) so the
   * registry stays infra-decoupled.
   */
  onSpawnFailed?: (info: SpawnFailureInfo) => void;
  /**
   * Schedule a one-shot timer for the MR-01 reply timeout. Default:
   * `systemSetTimeout` from `@comis/core` (the sanctioned timer indirection — no
   * raw `setTimeout` global). Returns an opaque handle for `clearTimer`. The
   * production default `.unref()`s the handle so a pending timeout never holds
   * the event loop open on shutdown.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
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

/**
 * The post-action snapshot subset returned by `sendText`/`sendKey` (spec §5) —
 * `{screen,cursor}`, a strict subset of {@link TerminalView}. The full grid +
 * real cursor land in P2/121; P1 forwards whatever the worker renders.
 */
export interface SendResult {
  screen: string;
  cursor: { x: number; y: number };
}

/** The settle snapshot returned by `wait` (spec §5) — `{matched,isComplete,reason}` + the view subset. */
export interface WaitResult {
  matched: boolean;
  isComplete: boolean;
  reason: string;
  screen: string;
  cursor: { x: number; y: number };
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
  /**
   * Forward a `send_text` frame (TR-03) and resolve the post-action
   * `{screen,cursor}` subset. Degrades to `{screen:"",cursor:{0,0}}` for an
   * absent session or a wedged worker (the MR-01 timeout reply) — never hangs.
   */
  sendText(
    sessionId: string,
    args: { text: string; submit?: boolean; bracketedPaste?: boolean },
  ): Promise<SendResult>;
  /**
   * Forward a `send_key` frame (TR-03) and resolve the post-action
   * `{screen,cursor}` subset. Same degrade-on-timeout/absent contract as
   * {@link sendText}.
   */
  sendKey(sessionId: string, args: { keys: string[] }): Promise<SendResult>;
  /**
   * Forward a `resize` frame (TR-03) and resolve `{ok}`. On success also updates
   * the handle's `cols`/`rows` so a subsequent `list()`/`get()` reflects the new
   * geometry (the snapshot stays coherent). Absent session → `{ok:false}`.
   */
  resize(sessionId: string, args: { cols: number; rows: number }): Promise<{ ok: boolean }>;
  /**
   * Forward a `wait` frame (TR-03) and resolve the settle snapshot
   * `{matched,isComplete,reason,screen,cursor}`. The worker's `isComplete:false`
   * survives the forward verbatim; a wedged worker (the MR-01 reply timeout)
   * still yields the honest not-complete shape — never `isComplete:true`, never a hang.
   */
  wait(
    sessionId: string,
    args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number },
  ): Promise<WaitResult>;
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
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // MR-01: the sanctioned timer indirection (no raw setTimeout global). The
  // production default `.unref()`s the handle so a pending reply timeout never
  // holds the event loop open on shutdown.
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
   * Split a `${sessionId}:${requestId}` pending key back into its parts. Both
   * halves are UUIDs (no embedded `:`), so the FIRST `:` is the unambiguous
   * separator — used to reconstruct waiter identity on flush (LR-02).
   */
  function splitPendingKey(key: string): { sessionId: string; requestId: string } {
    const idx = key.indexOf(":");
    return idx === -1
      ? { sessionId: key, requestId: "" }
      : { sessionId: key.slice(0, idx), requestId: key.slice(idx + 1) };
  }

  /**
   * Clear the worker handle and flush its pending waiters (on crash / close).
   *
   * LR-02: each synthetic termination reply carries the waiter's REAL
   * `(sessionId,requestId)` reconstructed from its pending key — NOT blanked
   * empty strings — so an identity-keyed caller cannot mis-handle the reply. A
   * per-waiter DEBUG records the flush (the §2.7-observable state transition).
   */
  function clearWorker(): void {
    worker = undefined;
    for (const [key, resolve] of pending) {
      pending.delete(key);
      const { sessionId, requestId } = splitPendingKey(key);
      logger.debug(
        { sessionId, requestId, hint: "flushing pending waiter; worker terminated", errorKind: "dependency" as const },
        "terminal worker waiter flushed",
      );
      resolve({ sessionId, requestId, ok: false, error: "worker terminated" });
    }
  }

  /** Flip every still-`running` session of the current worker to `lost`. */
  function markRunningSessionsLost(): void {
    for (const handle of sessions.values()) {
      if (handle.status === "running") handle.status = "lost";
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
    //
    // HR-02 (OPS-01 guarantee): the decode/correlate is wrapped in try/catch so a
    // malformed reply frame NEVER throws out of this 'data' listener. A throw on a
    // stream listener becomes an `uncaughtException` that takes the DAEMON down —
    // the precise opposite of "a crash restarts the WORKER, never the daemon".
    // The throw sources are `JSON.parse` on non-JSON body bytes (stray
    // console.log / deprecation warning on fd1, partial write, post-desync
    // garbage) and the HR-01 `FrameTooLargeError` on a corrupt length prefix. On
    // any decode failure we treat the worker as corrupt: WARN errorKind:'protocol',
    // flip its running sessions to `lost`, and clear the handle so the next
    // `create` re-spawns — never reaching `uncaughtException`.
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

  /**
   * Send a request frame to the worker and await its correlated reply, BOUNDED by
   * a reply timeout (MR-01).
   *
   * A worker that is alive but wedged (node-pty read loop stuck, the driven CLI
   * blocking the worker's single-threaded frame loop, a lost reply with no stream
   * close) emits no `close`/`error`, so nothing else ever unparks the waiter —
   * pre-MR-01 the `await` hung the whole turn and the resolver leaked. On timeout
   * we delete the pending key and resolve a typed `ok:false` timeout reply, so
   * `read` degrades to the not-alive minimal view instead of hanging. The timer
   * is the sanctioned `setTimer` indirection (no raw `setTimeout` global) and the
   * production default is `.unref()`d so it never holds the loop open.
   */
  function request(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<TerminalReplyFrame> {
    const child = ensureWorker();
    const frame = buildRequestFrame(sessionId, method, params);
    const key = `${sessionId}:${frame.requestId}`;
    return new Promise<TerminalReplyFrame>((resolve) => {
      const timer = setTimer(() => {
        // Expired with no reply — drop the waiter and settle a typed timeout.
        if (pending.delete(key)) {
          logger.warn(
            { sessionId, method, durationMs: requestTimeoutMs, hint: "worker reply timed out; degrading request", errorKind: "timeout" as const },
            "terminal worker reply timeout",
          );
          resolve({ sessionId, requestId: frame.requestId, ok: false, error: "worker timeout" });
        }
      }, requestTimeoutMs);
      // Wrap the resolver so a correlated reply cancels the pending timeout.
      pending.set(key, (f) => {
        clearTimer(timer);
        resolve(f);
      });
      child.stdin?.write(encodeFrame(frame));
    });
  }

  async function create(req: CreateRequest): Promise<CreateResult> {
    const child = ensureWorker();
    const sessionId = generateSessionId();

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

    // M-1: forward the daemon-canonical {bin,argv} to the worker VERBATIM. The
    // registry does NOT re-canonicalize — buildDirectSpawn (119-02) is the SOLE
    // canonicalization site; argsPrefix is preserved end-to-end.
    //
    // The create frame is fired WITHOUT blocking the turn (the worker spawns the
    // backend asynchronously; the rendered view is fetched later via `read`), but
    // — unlike a bare fire-and-forget — we register an ASYNC create-reply waiter
    // (HR-03). If the worker's backend spawn fails (bad bin ENOENT, forkpty
    // failure, resource limits), `handleCreate` throws and the worker replies
    // `ok:false`; that reply now flips the session to `lost` (so `list`/`read`
    // agree `alive:false`) and fires the OPS-07 `onSpawnFailed` hook. Without this
    // the failure was silently dropped and the handle stayed `running`/`alive:true`
    // forever despite a dead child. The turn is NOT held — the waiter resolves
    // out-of-band; the tool call still returns immediately (non-blocking contract).
    const createFrame = buildRequestFrame(sessionId, "create", {
      sessionId,
      bin: req.bin,
      argv: req.argv,
      cols: req.cols,
      rows: req.rows,
    });
    pending.set(`${sessionId}:${createFrame.requestId}`, (reply) => {
      if (reply.ok) return; // backend spawned — leave the session running.
      const h = sessions.get(sessionId);
      if (h !== undefined && h.status === "running") {
        h.status = "lost";
        h.lastActivity = nowMs();
      }
      logger.warn(
        { sessionId, allowId: req.allowId, command: req.bin, error: reply.error, hint: "worker backend spawn failed; session lost", errorKind: "dependency" as const },
        "terminal worker backend spawn failed",
      );
      deps.onSpawnFailed?.({ sessionId, error: reply.error });
    });
    child.stdin?.write(encodeFrame(createFrame));

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

  /**
   * Defensively extract the `{screen,cursor}` subset from a worker reply.result
   * (T-120-09: read the fields rather than trusting the shape blindly — a
   * corrupt reply degrades to the empty snapshot, never injects an odd structure).
   */
  function toSendResult(result: unknown): SendResult {
    const r = (result ?? {}) as { screen?: unknown; cursor?: { x?: unknown; y?: unknown } };
    const screen = typeof r.screen === "string" ? r.screen : "";
    const x = typeof r.cursor?.x === "number" ? r.cursor.x : 0;
    const y = typeof r.cursor?.y === "number" ? r.cursor.y : 0;
    return { screen, cursor: { x, y } };
  }

  /**
   * Map a forwarded mutating-frame reply to the `{screen,cursor}` subset (TR-03):
   * absent/not-running session OR a wedged worker (`!reply.ok`, the MR-01 reply
   * timeout) → the degraded empty snapshot; otherwise the defensively-extracted
   * subset, advancing `lastActivity`. Each `send*` method calls `request()` with
   * its LITERAL method name so the forwarding seam is explicit at the call site.
   */
  function mapSendReply(handle: SessionHandle, reply: TerminalReplyFrame): SendResult {
    if (!reply.ok || reply.result === undefined) {
      return { screen: "", cursor: { x: 0, y: 0 } };
    }
    handle.lastActivity = nowMs();
    return toSendResult(reply.result);
  }

  async function sendText(
    sessionId: string,
    args: { text: string; submit?: boolean; bracketedPaste?: boolean },
  ): Promise<SendResult> {
    const handle = sessions.get(sessionId);
    if (handle === undefined || handle.status !== "running") {
      return { screen: "", cursor: { x: 0, y: 0 } };
    }
    const reply = await request(sessionId, "send_text", {
      sessionId,
      text: args.text,
      submit: args.submit ?? false,
      bracketedPaste: args.bracketedPaste ?? false,
    });
    return mapSendReply(handle, reply);
  }

  async function sendKey(sessionId: string, args: { keys: string[] }): Promise<SendResult> {
    const handle = sessions.get(sessionId);
    if (handle === undefined || handle.status !== "running") {
      return { screen: "", cursor: { x: 0, y: 0 } };
    }
    const reply = await request(sessionId, "send_key", { sessionId, keys: args.keys });
    return mapSendReply(handle, reply);
  }

  async function resize(
    sessionId: string,
    args: { cols: number; rows: number },
  ): Promise<{ ok: boolean }> {
    const handle = sessions.get(sessionId);
    if (handle === undefined || handle.status !== "running") {
      return { ok: false };
    }
    const reply = await request(sessionId, "resize", {
      sessionId,
      cols: args.cols,
      rows: args.rows,
    });
    if (!reply.ok) return { ok: false };
    // TR-03: keep the handle geometry coherent so list()/get() reflect the resize.
    handle.cols = args.cols;
    handle.rows = args.rows;
    handle.lastActivity = nowMs();
    return { ok: true };
  }

  /**
   * The honest not-complete settle shape for a wedged/absent worker — NEVER
   * `isComplete:true` (a false `true` would strand the agent: the P5 attention
   * model would finalize a live session). Used on the MR-01 `ok:false` path.
   */
  function degradedWait(): WaitResult {
    return { matched: false, isComplete: false, reason: "timeout", screen: "", cursor: { x: 0, y: 0 } };
  }

  async function wait(
    sessionId: string,
    args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number },
  ): Promise<WaitResult> {
    const handle = sessions.get(sessionId);
    if (handle === undefined || handle.status !== "running") {
      return degradedWait();
    }
    const reply = await request(sessionId, "wait", { sessionId, ...args });
    if (!reply.ok || reply.result === undefined) {
      // A wedged worker (the MR-01 reply timeout) → the honest not-complete shape.
      return degradedWait();
    }
    // Defensively map the worker's settle result (T-120-08/09): preserve
    // isComplete VERBATIM, but DEFAULT a missing/odd value to false — never true.
    const r = reply.result as {
      matched?: unknown;
      isComplete?: unknown;
      reason?: unknown;
      screen?: unknown;
      cursor?: { x?: unknown; y?: unknown };
    };
    handle.lastActivity = nowMs();
    return {
      matched: r.matched === true,
      isComplete: r.isComplete === true,
      reason: typeof r.reason === "string" ? r.reason : "timeout",
      screen: typeof r.screen === "string" ? r.screen : "",
      cursor: {
        x: typeof r.cursor?.x === "number" ? r.cursor.x : 0,
        y: typeof r.cursor?.y === "number" ? r.cursor.y : 0,
      },
    };
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

  return { create, read, sendText, sendKey, resize, wait, get, list, kill, size, cleanup };
}
