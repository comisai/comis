// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-side TerminalSessionRegistry (spec §2.1, crash isolation).
 *
 * Owns the `Map<sessionId,SessionHandle>` + the single supervised worker handle.
 * Spawns the Terminal Worker (`terminal-worker-entry.ts`) under the proven
 * `--permission` posture and exchanges length-prefixed JSON frames
 * (`terminal-ipc.ts`) over the worker stdio pipes, correlated by
 * `(sessionId,requestId)`.
 *
 * Crash isolation: the worker is a SEPARATE process. The registry's
 * `child.on("error")`/`"close"` handlers (mirroring exec-background.ts) flip the
 * affected sessions to `lost`/`exited`, CLEAR the worker handle, and the next
 * `create` re-spawns lazily — a crash restarts the WORKER, never the daemon.
 *
 * FACTORY (`createTerminalSessionRegistry(deps)`) closing over a LOCAL session map
 * + worker handle — NO module-global mutable state. `create` forwards buildDirectSpawn's
 * daemon-canonical `{bin,argv}` VERBATIM (the SOLE canonicalization site).
 * No `@comis/infra` value-import (the daemon passes the real logger).
 *
 * Reaper composition: when the daemon threads the reaper caps + `TimerPort` + eviction
 * hooks, the registry composes a `terminal-reaper.ts` sweep (idle + wall-clock) + a
 * per-create overflow check; `evict` is the single audited eviction site (drop + cleanup
 * + `onCapForget` + `onEvict` + a WARN) the sweep + the max_interactions path both drive.
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
  type TerminalEventFrame,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
} from "./terminal-ipc.js";
import type { ReadOptions, SnapshotDiff } from "./terminal-render.js";
import {
  notFoundStatus,
  composeStatusView,
  type TerminalStatusView,
  type WorkerStatusPerception,
} from "./terminal-status-view.js";
import type { TerminalScope } from "./allowlist-matcher.js";
import { allocateSessionWorkspace, cleanupSessionWorkspace, resolveCreateWorkspace } from "./terminal-workspace.js";
import { sameOwner, type SessionOwner } from "./terminal-session-owner.js";
import { wireRegistryReaper, type EvictReason, type ReaperCaps } from "./terminal-reaper.js";
import {
  // DUR-01 (165-06): recover-on-boot scan + rehydrate + durable-lost gate (sibling-owned, cap headroom — Pitfall 5).
  applyRecoveredSessions,
  buildSessionDescriptor,
  markRunningSessionsLost as durableMarkLost,
  staysRecoverable as durableStaysRecoverable,
  type TerminalDurabilityDeps,
} from "./terminal-session-reattach.js";
import { waitReplyTimeoutMs } from "./terminal-settle.js";
import { mapWaitReply, degradedWaitResult, type WaitResult } from "./terminal-wait-reply.js";
import { wireWorkerSupervision } from "./terminal-worker-supervisor.js";
// The registry's shared structural contracts the BODY references (deps/handle/worker)
// type-imported from the neutral leaf terminal-session-types.ts (124-01 cycle break).
// SessionStatus is no longer referenced in the body (it rides SessionHandle, which moved
// to the leaf) — it is still re-exported for the public surface below.
import type {
  FakeWorkerChild,
  RegistryLogger,
  SessionHandle,
} from "./terminal-session-types.js";

export type { SessionOwner } from "./terminal-session-owner.js";
// The registry's shared structural contracts moved to the neutral leaf
// terminal-session-types.ts (124-01) to break the worker-supervisor import cycle
// (the registry value-imports wireWorkerSupervision, the supervisor needed these
// types back). RE-EXPORTED here so every existing `from "./terminal-session-registry.js"`
// importer (tool layer, barrel, round-trip tests) keeps working — type-only, no churn.
export type {
  FakeWorkerChild,
  RegistryLogger,
  SessionHandle,
  SessionStatus,
} from "./terminal-session-types.js";

/**
 * The per-session emulator scrollback depth — the SINGLE source the create tool defaults
 * to. NOT agent-dialable; bounds per-session emulator memory to `(rows + scrollback) x cols`.
 */
export const DEFAULT_SCROLLBACK = 1000;

// ---------------------------------------------------------------------------
// Injected dependency contracts
// ---------------------------------------------------------------------------
//
// RegistryLogger + FakeWorkerChild moved to the neutral leaf terminal-session-types.ts
// (124-01) to break the worker-supervisor import cycle; type-imported above and
// re-exported so the public surface is unchanged.

/** Details handed to `onSpawnFailed` when the worker reports a failed backend spawn. */
export interface SpawnFailureInfo {
  /** The session whose backend spawn failed in the worker. */
  sessionId: string;
  /** The worker-reported error message (e.g. `spawn ENOENT`), if any. */
  error?: string;
}

/**
 * Default reply timeout: a `request()` with no correlated reply in this window
 * settles to a typed timeout instead of hanging + leaking the resolver (a
 * wedged-but-alive worker emits no close/error). The daemon overrides via
 * `requestTimeoutMs` (config-derived, e.g. `worker.stuckMs`).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Registry dependencies — all injectable for unit tests; production defaults provided. Extends {@link ReaperCaps}: the daemon threads the reaper caps + eviction hooks flat (see `wireRegistryReaper`). */
export interface TerminalSessionRegistryDeps extends ReaperCaps {
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
  /** Reply timeout for `request()` round-trips in ms. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}; the daemon threads a config-derived value (e.g. `worker.stuckMs`) so a wedged worker degrades `read` instead of hanging. */
  requestTimeoutMs?: number;
  /** Called when the worker reports a failed backend spawn via an `ok:false` create reply; the daemon binds this to emit `terminal:spawn_failed`. The session is already `lost` before this fires. Injected (not a value-imported bus) so the registry stays infra-decoupled. */
  onSpawnFailed?: (info: SpawnFailureInfo) => void;
  /**
   * Called for each decoded {@link TerminalEventFrame} the worker pushes on fd3 (the
   * no-poll attention channel, 124-05/TR-11) — the seam the daemon (124-09) binds to
   * RE-PUBLISH onto its TypedEventBus (adding `agentId`/`timestamp` the worker is
   * agnostic to). Mirrors {@link onSpawnFailed}: daemon-bound, injected (NOT a
   * value-imported bus) so the registry stays infra-decoupled. The fd3 reader's HR-02
   * guard runs BEFORE this — a corrupt frame drops the worker and never reaches the hook.
   */
  onTerminalEvent?: (frame: TerminalEventFrame) => void;
  /** Schedule a one-shot timer for the MR-01 reply timeout. Default `systemSetTimeout` from `@comis/core` (the sanctioned indirection — no raw `setTimeout` global); the production default `.unref()`s it so a pending timeout never holds the loop open. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
  /** Daemon-resolved bwrap path (the jail seam): a STRING, forwarded onto the create frame for the worker's fail-closed branch (undefined ⇒ the worker rejects). */
  bwrapPath?: string;
  /** Daemon-injected no-secret egress port — the daemon->worker-main seam for `listed-hosts`; a live `net` server, so (unlike bwrapPath) NOT frame-serialized. Type-only from @comis/core. */
  egressControl?: EgressControlPort;
  /** Allocate a real per-session jail workspace dir (gap 2); default {@link allocateSessionWorkspace} (world-rwx mkdtemp under os.tmpdir()). `create` threads it onto the frame as workspace+cwd so the jail binds RW + --chdirs in (else it defaults to HOME, which uid 65534 cannot use). Injectable for a data-dir-rooted daemon allocator; cleanup is the paired {@link cleanupWorkspace}. */
  allocateWorkspace?: (sessionId: string) => string;
  /** Teardown paired with {@link allocateWorkspace}; default {@link cleanupSessionWorkspace} (`rm -rf` the throwaway mkdtemp dir on kill/evict/reap). A daemon rooting the workspace in the agent's OWN persistent workspace MUST inject a NO-OP so the agent's workspace (skills/memory/milestone work) is NOT deleted on session end. */
  cleanupWorkspace?: (workspace: string) => void;
  /**
   * DUR-01 (165-06): the durability seams (descriptor store + `has-session` probe + the two
   * content-free obs hooks), bundled as ONE nested object so the registry deps stay under the
   * optional-field-bloat cap + the DUR-01 wiring is cohesive. ABSENT (or absent `descriptorStore`)
   * ⇒ today's wiring (no recover/persist — byte-identical, I1). See {@link TerminalDurabilityDeps}.
   */
  durability?: TerminalDurabilityDeps;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
//
// SessionStatus + SessionHandle moved to the neutral leaf terminal-session-types.ts
// (124-01, closure of the worker-supervisor cycle break); type-imported above and
// re-exported so the public surface is unchanged.

/** A `create` request — the daemon passes buildDirectSpawn's `{bin,argv}`. */
export interface CreateRequest {
  allowId: string;
  bin: string;
  argv: string[];
  cols: number;
  rows: number;
  /**
   * The per-session emulator scrollback depth carried into the create frame so
   * the worker's `handleCreate` builds `Terminal({cols,rows,scrollback})`. The
   * create tool always supplies {@link DEFAULT_SCROLLBACK}; an omitted value
   * falls back to it in `create`. NOT agent-dialable — const/config-sourced.
   */
  scrollback?: number;
  /** Operator-declared sandbox scope, from the allow entry not agent params; rides the frame for the jail composer. */
  scope?: TerminalScope;
  /** Session workspace root — `scope`'s companion for the jail binds. */
  workspace?: string;
  /** Session working directory — `scope`'s companion for the jail `--chdir`. */
  cwd?: string;
  /** DUR-01 (165-06): `true` for a `drive.durable:true` session — persist a descriptor at create-time (Pitfall 6) + stamp the handle `durable` so the durable-aware {@link markRunningSessionsLost} keeps it recoverable while its tmux is alive (Q4). Absent ⇒ today's spawn session (I1). */
  durable?: boolean;
  /** DUR-01 (165-06): the deterministic `comis-<sessionId>` tmux name — the re-attach key persisted in the descriptor + stamped on the handle for the liveness probe (the daemon supplies it with `durable:true`). */
  tmuxName?: string;
}

/** The `create` result handed back to the tool layer. */
export interface CreateResult {
  sessionId: string;
  allowId: string;
  cols: number;
  rows: number;
}

/** The terminal view returned by `read` — the round-trip shape. */
export interface TerminalView {
  screen: string;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  alt: boolean;
  alive: boolean;
  /** The per-read screen-diff vs the prior read. ADDITIVE: present when an emulator snapshot exists; the not-found/degraded early returns omit it. */
  diff?: SnapshotDiff;
}

/** The post-action snapshot subset returned by `sendText`/`sendKey` (spec §5) — `{screen,cursor}`, a strict subset of {@link TerminalView}. */
export interface SendResult {
  screen: string;
  cursor: { x: number; y: number };
  /**
   * Whether the send was actually FORWARDED to a live worker (WR-05). `true` only
   * when the owned, running session round-tripped an `ok` reply; absent/falsy on the
   * degraded path (absent/cross-owner/not-running session OR a wedged worker — the
   * `{screen:"",cursor:{0,0}}` not-delivered shape). The woken-turn audit reads this
   * so a keystroke that reached nothing is recorded `outcome:"rejected"`, never
   * `attempted` — keeping the §2.7 audit trail honest about delivery.
   */
  delivered?: boolean;
}

// The §5 `status` view + its pure composition live in the leaf `terminal-status-view.ts`
// (extracted to keep this file under the 800-line cap). Re-export the view type (imported
// above) so the registry's public surface is unchanged.
export type { TerminalStatusView };

// The wait reply shape + its defensive worker→daemon mapping live in terminal-wait-reply
// (extracted to keep this file under the 800-line cap + make the mapping a tested unit).
export type { WaitResult };

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
 * `owner` `(agentId, sessionKey)` — there is NO return-all-when-owner-omitted path
 * (AGENTS.md §2.9). An owner mismatch is treated EXACTLY as not-found: the caller
 * sees the empty/degraded view, never another owner's session. `size`/`cleanup`
 * are owner-agnostic (lifecycle, not visibility).
 */
export interface TerminalSessionRegistry {
  create(req: CreateRequest, owner: SessionOwner): Promise<CreateResult>;
  /** Round-trip a `read` (render opts + screen diff). Owner-scoped: absent/cross-owner → not-found view (alive false), never the other owner's bytes. */
  read(sessionId: string, owner: SessionOwner, opts?: ReadOptions): Promise<TerminalView>;
  /** Round-trip a `status` (124-06, spec §5) — the worker's classifier perception composed with `handle.lastActivity`. Owner-scoped (T-124-15): absent/cross-owner/killed → the not-found minimal view (`exited`, not parked) WITHOUT a round-trip, never the other owner's state. The classifier stays single-homed in the worker. */
  status(sessionId: string, owner: SessionOwner): Promise<TerminalStatusView>;
  /** Forward `send_text` (TR-03) → `{screen,cursor}`. Owner-scoped (defense-in-depth): absent/cross-owner/not-running/wedged → `{screen:"",cursor:{0,0}}`; never hangs. */
  sendText(
    sessionId: string,
    owner: SessionOwner,
    args: { text: string; submit?: boolean; bracketedPaste?: boolean },
  ): Promise<SendResult>;
  /** Forward `send_key` → `{screen,cursor}`. Same owner-scoped degrade contract as {@link sendText}. */
  sendKey(sessionId: string, owner: SessionOwner, args: { keys: string[] }): Promise<SendResult>;
  /** Forward `resize` → `{ok}` (also updates handle geometry on success). Owner-scoped: absent/cross-owner → `{ok:false}`. */
  resize(sessionId: string, owner: SessionOwner, args: { cols: number; rows: number }): Promise<{ ok: boolean }>;
  /** Forward `wait` → settle snapshot. Owner-scoped: absent/cross-owner/wedged → honest not-complete (never `isComplete:true`); worker `isComplete:false` survives verbatim; never hangs. */
  wait(
    sessionId: string,
    owner: SessionOwner,
    args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number },
  ): Promise<WaitResult>;
  /** The handle iff it exists AND is owned by `owner`; else `undefined`. */
  get(sessionId: string, owner: SessionOwner): SessionHandle | undefined;
  /** Only the sessions owned by `owner` (owner-scoped visibility). */
  list(owner: SessionOwner): SessionListing[];
  /** Terminate a session — a no-op if it is absent OR not owned by `owner`. */
  kill(sessionId: string, owner: SessionOwner): Promise<void>;
  /** Evict with an audited reason — owner-checked, then the single drop + cleanup + onCapForget + onEvict + WARN site that the reaper sweep and the max_interactions path both drive. */
  evict(sessionId: string, owner: SessionOwner, reason: EvictReason): Promise<void>;
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
 * handle.
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
  // The sanctioned timer indirection (no raw setTimeout global). The production
  // default `.unref()`s the handle so a pending reply timeout never holds the
  // event loop open on shutdown.
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
  // The paired teardown for `allocateWorkspace` (default = `rm -rf` the throwaway mkdtemp).
  // A daemon rooting the workspace in the agent's OWN persistent dir MUST inject a no-op here.
  const cleanupWorkspace = deps.cleanupWorkspace ?? ((workspace: string) => cleanupSessionWorkspace(workspace));

  /**
   * Split a `${sessionId}:${requestId}` pending key. Both halves are UUIDs (no
   * embedded `:`), so the FIRST `:` is the separator — reconstructs waiter identity
   * on flush.
   */
  function splitPendingKey(key: string): { sessionId: string; requestId: string } {
    const idx = key.indexOf(":");
    return idx === -1
      ? { sessionId: key, requestId: "" }
      : { sessionId: key.slice(0, idx), requestId: key.slice(idx + 1) };
  }

  /**
   * Clear the worker handle and flush its pending waiters (on crash / close). Each
   * synthetic termination reply carries the waiter's REAL `(sessionId,requestId)`
   * from its pending key (not blanked) so an identity-keyed caller cannot mis-handle
   * it; a per-waiter DEBUG records the flush (the §2.7-observable transition).
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

  // DUR-01 / Q4 — bind the sibling's durable-lost gate (BOTH lost sites: the worker-close flip + the crash-flushed create waiter) to the probe (SAFE default "lost" if unconfirmable, I1).
  const isTmuxAliveOrDead = deps.durability?.isTmuxAlive ?? ((): boolean => false);
  const staysRecoverable = (handle: SessionHandle): boolean => durableStaysRecoverable(handle, isTmuxAliveOrDead);
  const markRunningSessionsLost = (): void => durableMarkLost(sessions, isTmuxAliveOrDead);

  /**
   * Ensure a live worker handle, spawning + supervising one if absent. The
   * crash handlers flip this worker's sessions to `lost`/`exited` and clear the
   * handle, so the next `ensureWorker()` re-spawns — the daemon stays up across
   * a worker crash. Mirrors exec-background.ts's close/error handlers.
   */
  function ensureWorker(): FakeWorkerChild {
    if (worker !== undefined) return worker;

    const child = deps.spawnWorker();
    worker = child;

    // OPS-01 crash-isolation listeners (HR-02-guarded stdout decoder + error + close) + the
    // 124-05/TR-11 guarded fd3 events-push reader live in terminal-worker-supervisor.ts (cap
    // headroom); the closure locals + the onTerminalEvent hook ride in as explicit params.
    wireWorkerSupervision({
      child,
      pending,
      sessions,
      logger,
      markRunningSessionsLost,
      clearWorker,
      onTerminalEvent: deps.onTerminalEvent,
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
      // A fresh trace id per frame (the tool layer threads the real ALS traceId).
      // The worker re-establishes whatever traceId arrives.
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
   * a reply timeout. A wedged-but-alive worker (node-pty read loop stuck, driven
   * CLI blocking the frame loop, a lost reply with no stream close) emits no
   * `close`/`error` — without the timeout the `await` would hang the whole turn +
   * leak the resolver. On timeout we delete the pending key and resolve a typed
   * `ok:false` reply so `read` degrades to the not-alive view instead of hanging.
   * The timer is the sanctioned `setTimer` indirection (no raw global), `.unref()`d
   * in production.
   */
  function request(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    replyTimeoutMs?: number,
  ): Promise<TerminalReplyFrame> {
    const child = ensureWorker();
    const frame = buildRequestFrame(sessionId, method, params);
    const key = `${sessionId}:${frame.requestId}`;
    // `wait` overrides this — its reply lands only when the in-worker settle resolves (60-90s+ for an AI CLI); the generic short timeout would pre-empt it.
    const effectiveTimeoutMs = replyTimeoutMs ?? requestTimeoutMs;
    return new Promise<TerminalReplyFrame>((resolve) => {
      const timer = setTimer(() => {
        // Expired with no reply — drop the waiter and settle a typed timeout.
        if (pending.delete(key)) {
          logger.warn(
            { sessionId, method, durationMs: effectiveTimeoutMs, hint: "worker reply timed out; degrading request", errorKind: "timeout" as const },
            "terminal worker reply timeout",
          );
          resolve({ sessionId, requestId: frame.requestId, ok: false, error: "worker timeout" });
        }
      }, effectiveTimeoutMs);
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

    const createdAt = nowMs(); // single clock read — lastActivity + startedAt (the reaper's wall-clock signal).
    const handle: SessionHandle = {
      sessionId,
      allowId: req.allowId,
      command: req.bin,
      status: "running",
      cols: req.cols,
      rows: req.rows,
      lastActivity: createdAt,
      startedAt: createdAt,
      workspace: ownedWorkspace,
      // Stamp the origin (owner-scoped list/read/get/kill/send*). The owner rides
      // the HANDLE only — NEVER the worker frame (the worker is owner-agnostic).
      owner,
      // DUR-01: stamp the durable marker + re-attach key (the durable-aware lost gate, Q4); absent for a spawn session (I1).
      ...(req.durable ? { durable: true, tmuxName: req.tmuxName } : {}),
    };
    sessions.set(sessionId, handle);

    // DUR-01: persist the durable descriptor at CREATE-time, BEFORE the create frame (Pitfall 6 — no orphan window); non-durable persists nothing (I1).
    if (req.durable && deps.durability?.descriptorStore !== undefined) {
      deps.durability.descriptorStore.persist(
        buildSessionDescriptor({ sessionId, tmuxName: req.tmuxName, allowId: req.allowId, owner, cols: req.cols, rows: req.rows, createdAt, scope: req.scope }),
      );
    }

    // Forward the daemon-canonical {bin,argv} VERBATIM (buildDirectSpawn, the SOLE
    // canonicalization site; argsPrefix preserved end-to-end). Fired WITHOUT
    // blocking the turn, but we register an ASYNC create-reply waiter: a failed
    // backend spawn replies `ok:false` → flip the session to `lost` (list/read agree
    // alive:false) + fire the `onSpawnFailed` hook. The waiter resolves out-of-band.
    const createFrame = buildRequestFrame(sessionId, "create", {
      sessionId,
      bin: req.bin,
      argv: req.argv,
      cols: req.cols,
      rows: req.rows,
      // Thread the per-session scrollback ceiling so handleCreate builds
      // Terminal({cols,rows,scrollback}). Defaults to DEFAULT_SCROLLBACK when the
      // caller omits one (the create tool always supplies it; this is the safety net).
      scrollback: req.scrollback ?? DEFAULT_SCROLLBACK,
      // scope (+ workspace/cwd) rides the frame for the jail composer.
      scope: req.scope,
      workspace, // the registry-allocated per-session jail dir (or caller override)
      cwd,
      // The daemon-resolved bwrap path rides the frame so the worker's fail-closed
      // branch reads it (undefined ⇒ no spawn, session lost).
      bwrapPath: deps.bwrapPath,
    });
    pending.set(`${sessionId}:${createFrame.requestId}`, (reply) => {
      if (reply.ok) return; // backend spawned — leave the session running.
      const h = sessions.get(sessionId);
      // DUR-01 / Q4: a worker CRASH flushes this waiter with a synthetic `ok:false`; a durable session
      // whose tmux is STILL alive is NOT a spawn failure → stays recoverable (I10). A real spawn
      // failure leaves tmux dead ⇒ probe false ⇒ DO flip + fire onSpawnFailed.
      if (h !== undefined && h.status === "running" && staysRecoverable(h)) return;
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
    // An over-cap create evicts the idlest down to maxSessions (reason
    // max_sessions). Runs AFTER sessions.set so the new session is in the snapshot.
    reaper?.checkOverflow();
    return { sessionId, allowId: req.allowId, cols: req.cols, rows: req.rows };
  }

  /**
   * The handle ONLY when it exists AND is owned by `owner`. An owner mismatch
   * returns `undefined` — the SAME as a missing session — so every owner-scoped
   * method treats a cross-owner ref EXACTLY as not-found (no leak).
   */
  function ownedHandle(sessionId: string, owner: SessionOwner): SessionHandle | undefined {
    const handle = sessions.get(sessionId);
    return handle !== undefined && sameOwner(handle.owner, owner) ? handle : undefined;
  }

  async function read(sessionId: string, owner: SessionOwner, opts?: ReadOptions): Promise<TerminalView> {
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined || handle.status !== "running") {
      // Not found / not alive — a minimal view the tool layer maps (no diff).
      return {
        screen: "",
        cursor: { x: 0, y: 0 },
        cols: handle?.cols ?? 0,
        rows: handle?.rows ?? 0,
        alt: false,
        alive: false,
      };
    }
    // Forward the render opts into the read frame (handleRead reads
    // format/scrollback). A bare read (opts undefined) spreads nothing.
    const reply = await request(sessionId, "read", { sessionId, ...(opts ?? {}) });
    handle.lastActivity = nowMs();
    if (!reply.ok || reply.result === undefined) {
      return { screen: "", cursor: { x: 0, y: 0 }, cols: handle.cols, rows: handle.rows, alt: false, alive: false };
    }
    return reply.result as TerminalView;
  }

  async function status(sessionId: string, owner: SessionOwner): Promise<TerminalStatusView> {
    const handle = ownedHandle(sessionId, owner);
    // Owner-scoped (T-124-15): a cross-owner / absent / not-running session degrades
    // to the not-found view WITHOUT round-tripping a `status` frame — a probe with a
    // guessed sessionId never reaches the worker and never sees another owner's state.
    if (handle === undefined || handle.status !== "running") {
      return notFoundStatus(handle);
    }
    const reply = await request(sessionId, "status", { sessionId });
    handle.lastActivity = nowMs();
    // A wedged worker (MR-01 reply timeout) degrades to the not-found view, never hangs.
    if (!reply.ok || reply.result === undefined) {
      return notFoundStatus(handle);
    }
    // The classifier state stays single-homed in the worker; compose it with the
    // daemon-side lastActivity (the leaf helper folds the two — keeps this file lean).
    // The `as WorkerStatusPerception` cast is of an UNTRUSTED cross-process reply, so
    // composeStatusView DEFENSIVELY narrows confidence/reason against a malformed /
    // version-skewed worker before they reach the status surface (LR-03) — the cast is
    // the happy-path type, the fold is the runtime safety net.
    return composeStatusView(reply.result as WorkerStatusPerception, handle);
  }

  /**
   * Defensively extract the `{screen,cursor}` subset from a worker reply.result
   * (read the fields rather than trusting the shape blindly — a corrupt reply
   * degrades to the empty snapshot, never injects an odd structure).
   */
  function toSendResult(result: unknown): SendResult {
    const r = (result ?? {}) as { screen?: unknown; cursor?: { x?: unknown; y?: unknown } };
    const screen = typeof r.screen === "string" ? r.screen : "";
    const x = typeof r.cursor?.x === "number" ? r.cursor.x : 0;
    const y = typeof r.cursor?.y === "number" ? r.cursor.y : 0;
    return { screen, cursor: { x, y } };
  }

  /**
   * Map a forwarded mutating-frame reply to the `{screen,cursor}` subset:
   * absent/not-running session OR a wedged worker (`!reply.ok`, the reply
   * timeout) → the degraded empty snapshot; otherwise the defensively-extracted
   * subset, advancing `lastActivity`. Each `send*` method calls `request()` with
   * its LITERAL method name so the forwarding seam is explicit at the call site.
   */
  function mapSendReply(handle: SessionHandle, reply: TerminalReplyFrame): SendResult {
    if (!reply.ok || reply.result === undefined) {
      // Not-delivered (WR-05): a wedged worker (the MR-01 reply timeout) — the send
      // reached no live pane. delivered is left falsy so the audit records "rejected".
      return { screen: "", cursor: { x: 0, y: 0 } };
    }
    handle.lastActivity = nowMs();
    // The worker round-tripped an ok reply ⇒ the keystroke WAS forwarded (WR-05).
    return { ...toSendResult(reply.result), delivered: true };
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
    // Keep the handle geometry coherent so list()/get() reflect the resize.
    handle.cols = args.cols;
    handle.rows = args.rows;
    handle.lastActivity = nowMs();
    return { ok: true };
  }

  async function wait(
    sessionId: string,
    owner: SessionOwner,
    args: { forIdleMs?: number; forText?: string; forExit?: boolean; timeoutMs?: number },
  ): Promise<WaitResult> {
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined || handle.status !== "running") {
      return degradedWaitResult();
    }
    const reply = await request(sessionId, "wait", { sessionId, ...args }, waitReplyTimeoutMs(args.timeoutMs));
    if (!reply.ok || reply.result === undefined) {
      // A wedged worker (the reply timeout) → the honest not-complete shape (with hint).
      return degradedWaitResult();
    }
    handle.lastActivity = nowMs();
    // Defensive worker→daemon map (preserves isComplete verbatim; passes T1.1 producing/hint).
    return mapWaitReply(reply.result);
  }

  function get(sessionId: string, owner: SessionOwner): SessionHandle | undefined {
    return ownedHandle(sessionId, owner);
  }

  function list(owner: SessionOwner): SessionListing[] {
    return Array.from(sessions.values())
      .filter((s) => sameOwner(s.owner, owner)) // owner-scoped visibility
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
   * kill frame (if running), delete the handle, and best-effort rm the
   * registry-allocated workspace (the single workspace-removal site, never
   * throws). `kill` gates this on ownership; `cleanup` calls it for every session.
   */
  function evictInternal(handle: SessionHandle): void {
    const { sessionId } = handle;
    if (worker !== undefined && handle.status === "running") {
      // Fire-and-forget: the session is dropped locally regardless of the reply.
      send(sessionId, "kill", { sessionId });
    }
    sessions.delete(sessionId);
    if (handle.workspace !== undefined) cleanupWorkspace(handle.workspace);
    logger.info({ sessionId }, "terminal session killed");
  }

  async function kill(sessionId: string, owner: SessionOwner): Promise<void> {
    // A no-op if absent OR not owned by the caller (a subagent cannot terminate a
    // sibling subagent's session). Owner mismatch == not-found.
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined) return;
    evictInternal(handle);
  }

  // Compose the reaper + its single audited eviction site (the wiring closes over
  // `sessions` + `evictInternal` — the reused drop+cleanup site).
  const { reaper, evict: evictForReaper } = wireRegistryReaper({ sessions, nowMs, evictInternal, logger, caps: deps });
  reaper?.start(); // arm the periodic sweep iff the reaper is composed.

  async function evict(sessionId: string, owner: SessionOwner, reason: EvictReason): Promise<void> {
    // Owner-scoped like kill (no-op on absent/cross-owner); the single eviction
    // entry reused for max_interactions (cap-forget runs on that path too).
    if (ownedHandle(sessionId, owner) === undefined) return;
    evictForReaper(sessionId, reason);
  }

  function size(): number {
    return sessions.size;
  }

  async function cleanup(): Promise<void> {
    // Stop the reaper FIRST so the sweep interval never outlives the registry
    // (no leaked interval firing post-teardown).
    reaper?.stop();
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

  // DUR-01 recover-on-boot (sibling-owned; no-op without a store, I1). BL-01 (165-REVIEW):
  // the 4th arg is the worker `reattach` round-trip the sibling drives (worker re-attaches
  // the surviving pane, NEVER a create; running status + obs hooks gated on its ok).
  if (deps.durability !== undefined)
    applyRecoveredSessions(deps.durability, sessions, nowMs, (id, cols, rows) => request(id, "reattach", { sessionId: id, cols, rows }));

  return { create, read, status, sendText, sendKey, resize, wait, get, list, kill, evict, size, cleanup };
}
