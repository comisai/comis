// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-side TerminalSessionRegistry (spec §2.1, OPS-01).
 *
 * Owns the `Map<sessionId,SessionHandle>` + the single supervised worker handle.
 * Spawns the Terminal Worker (119-03 `terminal-worker-entry.ts`) under the
 * 118-proven `--permission` posture and exchanges length-prefixed JSON frames
 * (119-02 `terminal-ipc.ts`) over the worker stdio pipes, correlated by
 * `(sessionId,requestId)`.
 *
 * Crash isolation (OPS-01): the worker is a SEPARATE process. The registry's
 * `child.on("error")`/`"close"` handlers (mirroring exec-background.ts) flip the
 * affected sessions to `lost`/`exited`, CLEAR the worker handle, and the next
 * `create` re-spawns lazily — a crash restarts the WORKER, never the daemon.
 *
 * FACTORY (`createTerminalSessionRegistry(deps)`) closing over a LOCAL session
 * map + worker handle — NO module-global mutable state (the no-module-global
 * architecture rule). `deps` injects `{ spawnWorker, logger, nowMs }`.
 *
 * M-1: `create` forwards buildDirectSpawn's daemon-canonical `{bin,argv}` (119-02,
 * the SOLE canonicalization site) to the worker VERBATIM — no re-canonicalization.
 * No `@comis/infra` value-import (the daemon passes the real logger).
 *
 * @module
 */

import { randomUUID } from "node:crypto";

import {
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
  type SystemTimeoutHandle,
  type EgressControlPort,
} from "@comis/core";

import {
  encodeFrame,
  createFrameDecoder,
  correlate,
  FrameTooLargeError,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
} from "./terminal-ipc.js";
import type { ReadOptions, SnapshotDiff } from "./terminal-render.js";
import type { TerminalScope } from "./allowlist-matcher.js";
import { allocateSessionWorkspace, cleanupSessionWorkspace, resolveCreateWorkspace } from "./terminal-workspace.js";
import { sameOwner, type SessionOwner } from "./terminal-session-owner.js";

export type { SessionOwner } from "./terminal-session-owner.js";

/**
 * The per-session emulator scrollback depth (TR-14) — the SINGLE source the create
 * tool defaults to (121-04). NOT agent-dialable (no `scrollback` create param);
 * bounds per-session emulator memory to `(rows + scrollback) × cols` cells.
 */
export const DEFAULT_SCROLLBACK = 1000;

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
 * Default reply timeout (MR-01): a `request()` (read/kill round-trip) with no
 * correlated reply in this window settles to a typed timeout instead of hanging
 * the caller + leaking the resolver (a wedged-but-alive worker emits no
 * close/error). 30s is generous for a screen read; the daemon overrides via
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
   * `systemSetTimeout` from `@comis/core` (the sanctioned timer indirection — no raw
   * `setTimeout` global); returns an opaque handle for `clearTimer`. The production
   * default `.unref()`s it so a pending timeout never holds the loop open on shutdown.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
  /** Daemon-resolved bwrap path (SEC-16 seam, 122-06): a STRING, forwarded onto the create frame for the worker's fail-closed branch (undefined ⇒ the worker rejects). */
  bwrapPath?: string;
  /** Daemon-injected no-secret egress port (SEC-07, 122-05) — the daemon->worker-main seam for `listed-hosts`; a live `net` server, so (unlike bwrapPath) NOT frame-serialized. Type-only from @comis/core. */
  egressControl?: EgressControlPort;
  /** Allocate a real per-session jail workspace dir (gap 2); default {@link allocateSessionWorkspace} (world-rwx mkdtemp under os.tmpdir()). `create` threads it onto the frame as workspace+cwd so the jail binds RW + --chdirs in (else it defaults to HOME, which uid 65534 cannot use). Injectable for a data-dir-rooted daemon allocator; cleanup is the paired {@link cleanupSessionWorkspace}. */
  allocateWorkspace?: (sessionId: string) => string;
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
  /** The registry-allocated per-session jail workspace dir (gap 2), removed best-effort on kill so the throwaway dir does not leak. Set ONLY when the registry allocated it (a caller-supplied workspace is the caller's to clean). */
  workspace?: string;
  /** The origin that owns this session — `(agentId, sessionKey)` (TR-13/TR-09). Stamped at `create`; `list`/`read`/`get`/`kill`/`send*` filter on it (two subagents are mutually invisible). */
  owner: SessionOwner;
}

/** A `create` request — the daemon passes buildDirectSpawn's `{bin,argv}` (M-1). */
export interface CreateRequest {
  allowId: string;
  bin: string;
  argv: string[];
  cols: number;
  rows: number;
  /**
   * The per-session emulator scrollback depth (TR-14) carried into the create
   * frame so the worker's `handleCreate` builds `Terminal({cols,rows,scrollback})`.
   * The create tool always supplies {@link DEFAULT_SCROLLBACK}; an omitted value
   * falls back to it in `create`. NOT agent-dialable — const/config-sourced.
   */
  scrollback?: number;
  /** Operator-declared sandbox scope (SEC-02), from the allow entry not agent params (SEC-03); rides the frame for the 122-06 jail composer, inert until then. */
  scope?: TerminalScope;
  /** Session workspace root — `scope`'s companion for the 122-06 jail binds. */
  workspace?: string;
  /** Session working directory — `scope`'s companion for the 122-06 jail `--chdir`. */
  cwd?: string;
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
  /**
   * The per-read screen-diff vs the prior read (TR-14, Plan 03). ADDITIVE: the
   * worker includes it when an emulator snapshot exists; the not-found / degraded
   * early returns omit it. Rides `reply.result` through `read` to the tool layer.
   */
  diff?: SnapshotDiff;
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

/**
 * The registry's public surface. Every session-scoped method takes a REQUIRED
 * `owner` `(agentId, sessionKey)` — NO return-all-when-omitted fallback
 * (no-backward-compat; AGENTS.md §2.9). An owner mismatch is treated EXACTLY as
 * not-found (TR-13/TR-09): the caller sees the empty/degraded view, never another
 * owner's session. `size`/`cleanup` are owner-agnostic (lifecycle, not visibility).
 */
export interface TerminalSessionRegistry {
  create(req: CreateRequest, owner: SessionOwner): Promise<CreateResult>;
  /** Round-trip a `read` (TR-02/14 opts + Plan-03 diff). Owner-scoped: absent/cross-owner → not-found view (alive false), never the other owner's bytes. */
  read(sessionId: string, owner: SessionOwner, opts?: ReadOptions): Promise<TerminalView>;
  /** Forward `send_text` (TR-03) → `{screen,cursor}`. Owner-scoped (defense-in-depth): absent/cross-owner/not-running/wedged → `{screen:"",cursor:{0,0}}`; never hangs. */
  sendText(
    sessionId: string,
    owner: SessionOwner,
    args: { text: string; submit?: boolean; bracketedPaste?: boolean },
  ): Promise<SendResult>;
  /** Forward `send_key` (TR-03) → `{screen,cursor}`. Same owner-scoped degrade contract as {@link sendText}. */
  sendKey(sessionId: string, owner: SessionOwner, args: { keys: string[] }): Promise<SendResult>;
  /** Forward `resize` (TR-03) → `{ok}` (also updates handle geometry on success). Owner-scoped: absent/cross-owner → `{ok:false}`. */
  resize(sessionId: string, owner: SessionOwner, args: { cols: number; rows: number }): Promise<{ ok: boolean }>;
  /** Forward `wait` (TR-03) → settle snapshot. Owner-scoped: absent/cross-owner/wedged → honest not-complete (never `isComplete:true`); worker `isComplete:false` survives verbatim; never hangs. */
  wait(
    sessionId: string,
    owner: SessionOwner,
    args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number },
  ): Promise<WaitResult>;
  /** The handle iff it exists AND is owned by `owner`; else `undefined` (TR-13). */
  get(sessionId: string, owner: SessionOwner): SessionHandle | undefined;
  /** Only the sessions owned by `owner` (TR-13 owner-scoped visibility). */
  list(owner: SessionOwner): SessionListing[];
  /** Terminate a session — a no-op if it is absent OR not owned by `owner` (TR-13). */
  kill(sessionId: string, owner: SessionOwner): Promise<void>;
  size(): number;
  cleanup(): Promise<void>;
}

// The production worker-launch posture (WORKER_PERMISSION_ARGS +
// buildProductionSpawnWorker) is in ./terminal-worker-launch.ts — extracted so this
// file stays under the 800-line cap; the barrel re-exports it from there.

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
  // gap 2: per-session jail workspace allocator (default = the real mkdtemp helper).
  const allocateWorkspace = deps.allocateWorkspace ?? ((id: string) => allocateSessionWorkspace(id).workspace);

  /**
   * Split a `${sessionId}:${requestId}` pending key into its parts. Both halves are
   * UUIDs (no embedded `:`), so the FIRST `:` is the unambiguous separator — used to
   * reconstruct waiter identity on flush (LR-02).
   */
  function splitPendingKey(key: string): { sessionId: string; requestId: string } {
    const idx = key.indexOf(":");
    return idx === -1
      ? { sessionId: key, requestId: "" }
      : { sessionId: key.slice(0, idx), requestId: key.slice(idx + 1) };
  }

  /**
   * Clear the worker handle and flush its pending waiters (on crash / close).
   * LR-02: each synthetic termination reply carries the waiter's REAL
   * `(sessionId,requestId)` reconstructed from its pending key (NOT blanked empty
   * strings) so an identity-keyed caller cannot mis-handle it; a per-waiter DEBUG
   * records the flush (the §2.7-observable state transition).
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

  async function create(req: CreateRequest, owner: SessionOwner): Promise<CreateResult> {
    const child = ensureWorker();
    const sessionId = generateSessionId();

    // gap 2: a REAL per-session jail workspace threaded onto the frame as workspace+cwd
    // (see terminal-workspace.ts); ownedWorkspace is set only when WE allocated it (a
    // caller override is theirs) so kill rm's exactly what the registry owns.
    const { workspace, cwd, ownedWorkspace } = resolveCreateWorkspace(req, allocateWorkspace, sessionId);

    const handle: SessionHandle = {
      sessionId,
      allowId: req.allowId,
      command: req.bin,
      status: "running",
      cols: req.cols,
      rows: req.rows,
      lastActivity: nowMs(),
      workspace: ownedWorkspace,
      // TR-13: stamp the origin so list/read/get/kill/send* are owner-scoped. The
      // owner rides the HANDLE only — NEVER the worker frame (the worker is
      // owner-agnostic; ownership is a daemon-side authorization concern).
      owner,
    };
    sessions.set(sessionId, handle);

    // M-1: forward the daemon-canonical {bin,argv} VERBATIM (buildDirectSpawn,
    // 119-02, the SOLE canonicalization site; argsPrefix preserved end-to-end). The
    // create frame is fired WITHOUT blocking the turn, but we register an ASYNC
    // create-reply waiter (HR-03): a failed worker backend spawn replies `ok:false`,
    // flipping the session to `lost` (so list/read agree `alive:false`) + firing the
    // OPS-07 `onSpawnFailed` hook (else the failure is silently dropped, the handle
    // stuck `running`). The turn is NOT held — the waiter resolves out-of-band.
    const createFrame = buildRequestFrame(sessionId, "create", {
      sessionId,
      bin: req.bin,
      argv: req.argv,
      cols: req.cols,
      rows: req.rows,
      // TR-14: thread the per-session scrollback ceiling so handleCreate builds
      // Terminal({cols,rows,scrollback}). Defaults to DEFAULT_SCROLLBACK when the
      // caller omits one (the create tool always supplies it; this is the safety net).
      scrollback: req.scrollback ?? DEFAULT_SCROLLBACK,
      // SEC-02: scope (+ workspace/cwd) rides the frame for the 122-06 jail composer.
      scope: req.scope,
      workspace, // gap 2: the registry-allocated per-session jail dir (or caller override)
      cwd,
      // SEC-16 (122-06): the daemon-resolved bwrap path rides the frame so the
      // worker's fail-closed branch reads it (undefined ⇒ no spawn, session lost).
      bwrapPath: deps.bwrapPath,
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

  /**
   * The handle ONLY when it exists AND is owned by `owner` (TR-13). An owner
   * mismatch returns `undefined` — the SAME as a missing session — so every
   * owner-scoped method treats a cross-owner ref EXACTLY as not-found (no leak).
   */
  function ownedHandle(sessionId: string, owner: SessionOwner): SessionHandle | undefined {
    const handle = sessions.get(sessionId);
    return handle !== undefined && sameOwner(handle.owner, owner) ? handle : undefined;
  }

  async function read(sessionId: string, owner: SessionOwner, opts?: ReadOptions): Promise<TerminalView> {
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined || handle.status !== "running") {
      // Not found / not alive — a minimal view the 119-04 tool layer maps (no diff).
      return {
        screen: "",
        cursor: { x: 0, y: 0 },
        cols: handle?.cols ?? 0,
        rows: handle?.rows ?? 0,
        alt: false,
        alive: false,
      };
    }
    // TR-02/14: forward the render opts into the read frame (handleRead reads
    // format/scrollback, Plan 02). A bare read (opts undefined) spreads nothing.
    const reply = await request(sessionId, "read", { sessionId, ...(opts ?? {}) });
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
    owner: SessionOwner,
    args: { text: string; submit?: boolean; bracketedPaste?: boolean },
  ): Promise<SendResult> {
    const handle = ownedHandle(sessionId, owner);
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

  async function sendKey(sessionId: string, owner: SessionOwner, args: { keys: string[] }): Promise<SendResult> {
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined || handle.status !== "running") {
      return { screen: "", cursor: { x: 0, y: 0 } };
    }
    const reply = await request(sessionId, "send_key", { sessionId, keys: args.keys });
    return mapSendReply(handle, reply);
  }

  async function resize(
    sessionId: string,
    owner: SessionOwner,
    args: { cols: number; rows: number },
  ): Promise<{ ok: boolean }> {
    const handle = ownedHandle(sessionId, owner);
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
    owner: SessionOwner,
    args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number },
  ): Promise<WaitResult> {
    const handle = ownedHandle(sessionId, owner);
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

  function get(sessionId: string, owner: SessionOwner): SessionHandle | undefined {
    return ownedHandle(sessionId, owner);
  }

  function list(owner: SessionOwner): SessionListing[] {
    return Array.from(sessions.values())
      .filter((s) => sameOwner(s.owner, owner)) // TR-13: owner-scoped visibility
      .map((s) => ({
        sessionId: s.sessionId,
        allowId: s.allowId,
        command: s.command,
        alive: s.status === "running",
        lastActivity: s.lastActivity,
      }));
  }

  /**
   * Drop a session WITHOUT an owner check — the shared end-of-life path: fire the
   * kill frame (if running), delete the handle (TR-01), and best-effort rm the
   * registry-allocated workspace (gap 2; the single workspace-removal site, never
   * throws). `kill` gates this on ownership; `cleanup` calls it for every session.
   */
  function evictInternal(handle: SessionHandle): void {
    const { sessionId } = handle;
    if (worker !== undefined && handle.status === "running") {
      // Fire-and-forget: the session is dropped locally regardless of the reply.
      send(sessionId, "kill", { sessionId });
    }
    sessions.delete(sessionId);
    if (handle.workspace !== undefined) cleanupSessionWorkspace(handle.workspace);
    logger.info({ sessionId }, "terminal session killed");
  }

  async function kill(sessionId: string, owner: SessionOwner): Promise<void> {
    // TR-13: a no-op if absent OR not owned by the caller (a subagent cannot
    // terminate a sibling subagent's session). Owner mismatch == not-found.
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined) return;
    evictInternal(handle);
  }

  function size(): number {
    return sessions.size;
  }

  async function cleanup(): Promise<void> {
    // Owner-AGNOSTIC: tears down the WHOLE per-agent registry, dropping every
    // session regardless of owner (the per-agent worker is shared across owners).
    for (const handle of Array.from(sessions.values())) {
      evictInternal(handle);
    }
    if (worker !== undefined) {
      worker.kill("SIGTERM");
      clearWorker();
    }
  }

  return { create, read, sendText, sendKey, resize, wait, get, list, kill, size, cleanup };
}
