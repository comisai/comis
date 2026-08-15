// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-side TerminalSessionRegistry (crash isolation).
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
import { err, fromPromise, ok, type Result } from "@comis/shared";

import {
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
  type SystemTimeoutHandle,
  type EgressControlPort,
  type ChannelEndpoint,
} from "@comis/core";

import {
  encodeFrame,
  type TerminalEventFrame,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
} from "./terminal-ipc.js";
import type { ReadOptions } from "./terminal-render.js";
import {
  notFoundStatus,
  composeStatusView,
  type TerminalStatusView,
  type WorkerStatusPerception,
} from "./terminal-status-view.js";
import type { TerminalScope } from "./allowlist-matcher.js";
import type { ManagedTerminalBinding, ManagedTerminalExecutionAttachment, TerminalRootProcessIdentity } from "./terminal-managed-binding.js";
import { allocateSessionWorkspace, cleanupSessionWorkspace, resolveCreateWorkspace } from "./terminal-workspace.js";
import { sameOwner, type SessionOwner } from "./terminal-session-owner.js";
import { wireRegistryReaper, type EvictReason, type ReaperCaps } from "./terminal-reaper.js";
import { tmuxSessionName } from "./terminal-tmux-backend.js";
import {
  // Recover-on-boot scan + rehydrate + durable-lost gate (sibling-owned, cap headroom).
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
// type-imported from the neutral leaf terminal-session-types.ts (cycle break).
// SessionStatus is no longer referenced in the body (it rides SessionHandle, which moved
// to the leaf) — it is still re-exported for the public surface below.
import type {
  FakeWorkerChild,
  RegistryLogger,
  SessionHandle,
  SpawnFailureInfo,
  CreateResult,
  TerminalView,
  SendResult,
  SessionListing,
} from "./terminal-session-types.js";

export type { SessionOwner } from "./terminal-session-owner.js";
// The registry's shared structural contracts moved to the neutral leaf
// terminal-session-types.ts to break the worker-supervisor import cycle
// (the registry value-imports wireWorkerSupervision, the supervisor needed these
// types back). RE-EXPORTED here so every existing `from "./terminal-session-registry.js"`
// importer (tool layer, barrel, round-trip tests) keeps working — type-only, no churn.
export type {
  FakeWorkerChild,
  RegistryLogger,
  SessionHandle,
  SessionStatus,
  SpawnFailureInfo,
  CreateResult,
  TerminalView,
  SendResult,
  SessionListing,
} from "./terminal-session-types.js";

/**
 * The per-session emulator scrollback depth — the SINGLE source the create tool defaults
 * to. NOT agent-dialable; bounds per-session emulator memory to `(rows + scrollback) x cols`.
 */
export const DEFAULT_SCROLLBACK = 1000;

// Injected dependency contracts
//
// RegistryLogger + FakeWorkerChild moved to the neutral leaf terminal-session-types.ts
// to break the worker-supervisor import cycle; type-imported above and
// re-exported so the public surface is unchanged.

/**
 * Default reply timeout: a `request()` with no correlated reply in this window
 * settles to a typed timeout instead of hanging + leaking the resolver (a
 * wedged-but-alive worker emits no close/error). The daemon overrides via
 * `requestTimeoutMs` (config-derived, e.g. `worker.stuckMs`).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Registry dependencies — all injectable for unit tests; production defaults provided. Extends {@link ReaperCaps}: the daemon threads the reaper caps + eviction hooks flat (see `wireRegistryReaper`). */
// @optional-field-count: 13 — composition-root deps bag with a single daemon
// construction site; every `?` seam is injectable-for-tests with a production
// default (clock/timers), a daemon-bound obs hook (onSpawnFailed/onTerminalEvent),
// or genuinely config-conditional (bwrapPath, unsafeDisableSandbox — the jail
// seam pair forwarded onto the create frame; tmuxSocketForSession; egressControl).
// The durability seams are already bundled into ONE nested object
// ({@link TerminalDurabilityDeps}) — the remaining fields describe distinct
// wiring chokepoints and are not a further cluster-split candidate.
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
   * no-poll attention channel) — the seam the daemon binds to
   * RE-PUBLISH onto its TypedEventBus (adding `agentId`/`timestamp` the worker is
   * agnostic to). Mirrors {@link onSpawnFailed}: daemon-bound, injected (NOT a
   * value-imported bus) so the registry stays infra-decoupled. The fd3 reader's crash
   * guard runs BEFORE this — a corrupt frame drops the worker and never reaches the hook.
   */
  onTerminalEvent?: (frame: TerminalEventFrame) => void;
  /** Schedule a one-shot timer for the reply timeout. Default `systemSetTimeout` from `@comis/core` (the sanctioned indirection — no raw `setTimeout` global); the production default `.unref()`s it so a pending timeout never holds the loop open. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
  /** Daemon-resolved bwrap path (the jail seam): a STRING, forwarded onto the create frame for the worker's fail-closed branch (undefined ⇒ the worker rejects). */
  bwrapPath?: string;
  /** Operator jail opt-out (`skills.terminal.unsafeDisableSandbox`) — forwarded onto the create frame. `true` ⇒ the worker spawns the CLI DIRECTLY (no bwrap), env-scrub preserved, forced non-durable PTY. A security downgrade for bwrap-less hosts, surfaced in config_posture; default/absent ⇒ the fail-closed jail. */
  unsafeDisableSandbox?: boolean;
  /**
   * Resolve the tmux `-S` socket for ONE session — i.e. that session's OWN tmux server (a
   * server is identified by its socket). Stamped on a durable session's handle + descriptor at
   * create, so the daemon probe / reaper and a later recover-on-boot all address the socket the
   * session ACTUALLY runs on.
   *
   * It is a FUNCTION of the session id, not a daemon-wide constant, and that is load-bearing:
   * one server per session is what lets the server be started with the drive's scrubbed env in
   * its own PROCESS environment (owner-only) instead of restated as `-e KEY=VALUE` on the
   * world-readable command line. Stamping a single boot-wide socket here would record a server
   * the session never ran on — recover-on-boot would probe an empty socket and the durable
   * drive would silently fail to re-attach, while the reaper killed the wrong target. Both are
   * `string`, so only a test can catch that mismatch.
   *
   * MUST agree with the worker's own derivation (`tmuxSocketPathForSession`) — same dir, same
   * session id. Absent ⇒ no socket is stamped and the worker derives it.
   */
  tmuxSocketForSession?: (sessionId: string) => string;
  /** Daemon-injected no-secret egress port — the daemon->worker-main seam for `listed-hosts`; a live `net` server, so (unlike bwrapPath) NOT frame-serialized. Type-only from @comis/core. */
  egressControl?: EgressControlPort;
  /** Allocate a real per-session jail workspace dir; default {@link allocateSessionWorkspace} (world-rwx mkdtemp under os.tmpdir()). `create` threads it onto the frame as workspace+cwd so the jail binds RW + --chdirs in (else it defaults to HOME, which uid 65534 cannot use). Injectable for a data-dir-rooted daemon allocator; cleanup is the paired {@link cleanupWorkspace}. */
  allocateWorkspace?: (sessionId: string) => string;
  /** Teardown paired with {@link allocateWorkspace}; default {@link cleanupSessionWorkspace} (`rm -rf` the throwaway mkdtemp dir on kill/evict/reap). A daemon rooting the workspace in the agent's OWN persistent workspace MUST inject a NO-OP so the agent's workspace (skills/memory/milestone work) is NOT deleted on session end. */
  cleanupWorkspace?: (workspace: string) => void;
  /**
   * The durability seams (descriptor store + `has-session` probe + the two
   * content-free obs hooks), bundled as ONE nested object so the registry deps stay under the
   * optional-field-bloat cap + the durability wiring is cohesive. ABSENT (or absent `descriptorStore`)
   * ⇒ today's wiring (no recover/persist — byte-identical). See {@link TerminalDurabilityDeps}.
   */
  durability?: TerminalDurabilityDeps;
  /** Daemon trust-boundary resolver for a host PID plus non-reusable start identity. */
  resolveRootProcessIdentity?: (pid: number) => Promise<TerminalRootProcessIdentity | undefined>;
}

// Public types
//
// SessionStatus + SessionHandle moved to the neutral leaf terminal-session-types.ts
// (closure of the worker-supervisor cycle break); type-imported above and
// re-exported so the public surface is unchanged.

/** A `create` request — the daemon passes buildDirectSpawn's `{bin,argv}`. */
export interface CreateRequest {
  sessionId?: string;
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
  /** Session working directory — `scope`'s companion for the jail `--chdir`. Honored only if it
   *  resolves WITHIN the session workspace (else clamped to it — the jail-escape guard). */
  cwd?: string;
  /** Project name → the session opens in its own auto-created folder `<agent-workspace>/projects/
   *  <sanitized-slug>` (the session workspace IS the agent's projects root). Takes precedence over `cwd`. */
  project?: string;
  /** `true` for a `drive.durable:true` session — persist a descriptor at create-time + stamp the handle `durable` so the durable-aware {@link markRunningSessionsLost} keeps it recoverable while its tmux is alive. Absent ⇒ today's spawn session. */
  durable?: boolean;
  /** The deterministic `comis-<sessionId>` tmux name — the re-attach key persisted in the descriptor + stamped on the handle for the liveness probe (the daemon supplies it with `durable:true`). */
  tmuxName?: string;
  /**
   * The conversation this drive is created FROM (the resolved turn scope's endpoint),
   * captured by the tool from the request context — NEVER an agent-facing create param,
   * exactly like `scope`. It rides the HANDLE + the durable descriptor, never the worker
   * frame (the worker is origin-agnostic). Absent ⇒ the drive's notifications resolve
   * through the shipped primaryChannel→recent-session chain, unchanged.
   */
  originEndpoint?: ChannelEndpoint;
  /** Server-resolved managed authority. Never sourced directly from model parameters. */
  managedBinding?: Omit<ManagedTerminalBinding, "canonicalRoot">;
  /** Server-resolved exact socket mounts for this managed terminal's jail. */
  executionAttachments?: readonly ManagedTerminalExecutionAttachment[];
}

// The `status` view + its pure composition live in the leaf `terminal-status-view.ts`
// (extracted to keep this file under the 800-line cap). Re-export the view type (imported
// above) so the registry's public surface is unchanged.
export type { TerminalStatusView };

// The wait reply shape + its defensive worker→daemon mapping live in terminal-wait-reply
// (extracted to keep this file under the 800-line cap + make the mapping a tested unit).
export type { WaitResult };

/**
 * The registry's public surface. Every session-scoped method takes a REQUIRED
 * `owner` `(agentId, sessionKey)` — there is NO return-all-when-owner-omitted path
 * (AGENTS.md §2.9). An owner mismatch is treated EXACTLY as not-found: the caller
 * sees the empty/degraded view, never another owner's session. `size`/`cleanup`
 * are owner-agnostic (lifecycle, not visibility).
 */
export interface TerminalSessionRegistry {
  create(req: CreateRequest, owner: SessionOwner): Promise<CreateResult>;
  /** Round-trip a `read` (render opts + screen diff), including the retained final screen after a clean process exit. Owner-scoped: absent/cross-owner/lost → not-found view (alive false), never the other owner's bytes. */
  read(sessionId: string, owner: SessionOwner, opts?: ReadOptions): Promise<TerminalView>;
  /** Round-trip a `status` — the worker's classifier perception composed with `handle.lastActivity`. Owner-scoped: absent/cross-owner/killed → the not-found minimal view (`exited`, not parked) WITHOUT a round-trip, never the other owner's state. The classifier stays single-homed in the worker. */
  status(sessionId: string, owner: SessionOwner): Promise<TerminalStatusView>;
  /** Forward `send_text` → `{screen,cursor}`. Owner-scoped (defense-in-depth): absent/cross-owner/not-running/wedged → `{screen:"",cursor:{0,0}}`; never hangs. */
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
  /** Trusted daemon-only content-free identity lookup for lifecycle routing. */
  getManagedBinding?(sessionId: string): Omit<ManagedTerminalBinding, "canonicalRoot"> | undefined;
  /** Only the sessions owned by `owner` (owner-scoped visibility). */
  list(owner: SessionOwner): SessionListing[];
  /** Terminate a session — a no-op if it is absent OR not owned by `owner`. */
  kill(sessionId: string, owner: SessionOwner): Promise<void>;
  /** Trusted teardown barrier: retain authority unless the worker confirms backend exit. */
  terminateAndConfirm(sessionId: string, owner: SessionOwner): Promise<Result<void, Error>>;
  /** Evict with an audited reason — owner-checked, then the single drop + cleanup + onCapForget + onEvict + WARN site that the reaper sweep and the max_interactions path both drive. */
  evict(sessionId: string, owner: SessionOwner, reason: EvictReason): Promise<void>;
  getOwner?(sessionId: string): SessionOwner | undefined; // Recovery seam (daemon-trusted, owner-agnostic): stamped owner by id — recovers the (userId,sessionKey) the worker→event re-publish drops so a detached drive's woken turns resolve the LIVE session, not drop cross-owner. Identity only; undefined iff absent.
  getOriginEndpoint?(sessionId: string): ChannelEndpoint | undefined; // Origin seam beside getOwner (daemon-trusted, owner-agnostic): the conversation the drive was created from, so its outcome/escalation notifications resolve back to THAT thread instead of the most recent one. Delivery hint only — never consulted by the owner gate; undefined iff absent (routes as today).
  size(): number;
  cleanup(): Promise<void>;
}

// The production worker-launch posture (WORKER_PERMISSION_ARGS +
// buildProductionSpawnWorker) is in ./terminal-worker-launch.ts — extracted so this
// file stays under the 800-line cap; the barrel re-exports it from there.

// Factory

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
  // Per-session jail workspace allocator (default = the real mkdtemp helper).
  const allocateWorkspace = deps.allocateWorkspace ?? ((id: string) => allocateSessionWorkspace(id).workspace);
  // The paired teardown for `allocateWorkspace` (default = `rm -rf` the throwaway mkdtemp).
  // A daemon rooting the workspace in the agent's OWN persistent dir MUST inject a no-op here.
  const cleanupWorkspace = deps.cleanupWorkspace ?? ((workspace: string) => cleanupSessionWorkspace(workspace));

  /**
   * Split a `${sessionId}:${requestId}` pending key. Both halves are UUIDs (no embedded
   * `:`), so the FIRST `:` is the separator — reconstructs waiter identity on flush.
   */
  function splitPendingKey(key: string): { sessionId: string; requestId: string } {
    const idx = key.indexOf(":");
    return idx === -1
      ? { sessionId: key, requestId: "" }
      : { sessionId: key.slice(0, idx), requestId: key.slice(idx + 1) };
  }

  /**
   * Clear the worker handle and flush its pending waiters (on crash / close). Each synthetic
   * termination reply carries the waiter's REAL `(sessionId,requestId)` from its pending key
   * (not blanked) so an identity-keyed caller cannot mis-handle it; a per-waiter DEBUG records
   * the flush (the observable transition).
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

  // Bind the sibling's durable-lost gate (BOTH lost sites: the worker-close flip + the crash-flushed create waiter) to the probe (SAFE default "lost" if unconfirmable).
  const isTmuxAliveOrDead = deps.durability?.isTmuxAlive ?? ((): boolean => false);
  const staysRecoverable = (handle: SessionHandle): boolean => durableStaysRecoverable(handle, isTmuxAliveOrDead);
  const markRunningSessionsLost = (): void => durableMarkLost(sessions, isTmuxAliveOrDead);

  const handleTerminalEvent = (frame: TerminalEventFrame): void => {
    const payload = frame.payload as { state?: unknown } | undefined;
    if (frame.event === "terminal:session_state" && payload?.state === "exited") {
      const handle = sessions.get(frame.sessionId);
      // A real per-session fd3 exit arrives while this handle is still running. A
      // worker-process close first flips every handle to exited, then sends the same
      // content-free lifecycle shape; preserve durable descriptors in that case so a
      // graceful daemon restart can reattach the surviving tmux session.
      if (handle?.status === "running") {
        handle.status = "exited";
        handle.lastActivity = nowMs();
        if (handle.durable === true) {
          if (isManagedHandle(handle)) void retireManagedExit(handle);
          else deps.durability?.descriptorStore?.remove(frame.sessionId);
        }
      }
    }
    deps.onTerminalEvent?.(frame);
  };

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

    // The crash-isolation listeners (guarded stdout decoder + error + close) + the
    // guarded fd3 events-push reader live in terminal-worker-supervisor.ts (cap
    // headroom); the closure locals + the onTerminalEvent hook ride in as explicit params.
    wireWorkerSupervision({
      child,
      pending,
      sessions,
      logger,
      markRunningSessionsLost,
      clearWorker,
      onTerminalEvent: handleTerminalEvent,
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
   * Send a request frame to the worker and await its correlated reply, BOUNDED by a reply
   * timeout. A wedged-but-alive worker (node-pty read loop stuck, driven CLI blocking the frame
   * loop, a lost reply with no stream close) emits no `close`/`error` — without the timeout the
   * `await` would hang the whole turn + leak the resolver. On timeout we delete the pending key
   * and resolve a typed `ok:false` reply so `read` degrades to the not-alive view instead of
   * hanging. The timer is the sanctioned `setTimer` indirection (no raw global), `.unref()`d in production.
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
    const sessionId = req.sessionId ?? generateSessionId();
    if (sessions.has(sessionId)) {
      return Promise.reject(new Error("terminal session identity is already registered"));
    }
    if (req.managedBinding !== undefined && req.durable !== true) {
      return Promise.reject(new Error("managed terminal launches require durable descriptor authority"));
    }
    const capacity = await reaper?.checkOverflow(1);
    if (capacity !== undefined && !capacity.ok) return Promise.reject(capacity.error);
    // A REAL per-session jail workspace threaded onto the frame as workspace+cwd
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
      ...(req.managedBinding === undefined ? {} : {
        managedRunId: req.managedBinding.managedRunId,
        workspaceLeaseId: req.managedBinding.workspaceLeaseId,
        serviceInstanceId: req.managedBinding.serviceInstanceId,
      }),
      // Stamp the origin CONVERSATION beside the owner — same handle-only rule, same
      // verbatim re-stamp on re-attach. It is what makes a backgrounded drive's outcome
      // reach the thread that started it instead of the most recent one. Delivery only:
      // it never enters the owner gate.
      ...(req.originEndpoint !== undefined ? { originEndpoint: req.originEndpoint } : {}),
      // Stamp the durable marker + re-attach key (the durable-aware lost gate); absent for a spawn session. The registry DERIVES the deterministic comis-<sessionId> name (the tool cannot — sessionId is generated HERE), so durable engages without the caller supplying tmuxName.
      ...(req.durable
        ? {
            durable: true,
            tmuxName: req.tmuxName ?? tmuxSessionName(sessionId),
            // Stamp THIS SESSION's own socket so the daemon probe / reaper target the server it
            // actually runs on, and a future restart re-attaches from that same socket.
            ...(deps.tmuxSocketForSession !== undefined
              ? { tmuxSocket: deps.tmuxSocketForSession(sessionId) }
              : {}),
          }
        : {}),
    };
    sessions.set(sessionId, handle);

    const initialDescriptor = persistDurableDescriptor(req, owner, sessionId, createdAt);
    if (!initialDescriptor.ok) {
      handle.status = "lost";
      if (isManagedHandle(handle)) {
        const retired = await terminateRetireAndDropManaged(handle);
        if (!retired.ok) {
          logger.warn(
            { sessionId, hint: "retry managed terminal retirement before releasing its reserved authority", errorKind: "resource" as const },
            "managed terminal descriptor persistence and retirement failed",
          );
        }
      } else {
        dropSession(handle, "terminal session registration rejected");
      }
      return Promise.reject(initialDescriptor.error);
    }

    // Forward the daemon-canonical {bin,argv} VERBATIM (buildDirectSpawn, the SOLE canonicalization site; argsPrefix preserved end-to-end). Fired WITHOUT
    // blocking the turn, but we register an ASYNC create-reply waiter: a failed
    // backend spawn replies `ok:false` → flip the session to `lost` (list/read agree
    // alive:false) + fire the `onSpawnFailed` hook. The waiter resolves out-of-band.
    const createParams = {
      sessionId,
      bin: req.bin,
      argv: req.argv,
      // The operator-declared allowId — selects the read-side platform profile in the worker
      // (by allowId only). Already on the descriptor; threaded to the worker
      // so the emulator's render transform + the classifier's perception pick the right profile.
      allowId: req.allowId,
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
      ...(req.managedBinding === undefined ? {} : { managedWorkspace: true }),
      // The daemon-resolved bwrap path rides the frame for the worker's fail-closed branch (undefined ⇒ no spawn, lost).
      bwrapPath: deps.bwrapPath,
      // The operator jail opt-out rides the frame like bwrapPath (true ⇒ the worker spawns the CLI
      // directly, env-scrub preserved; a durable tmux drive is preserved via a scrubbed server env +
      // per-session `new-session -e` — see terminal-worker-backend-attach).
      ...(deps.unsafeDisableSandbox ? { unsafeDisableSandbox: true } : {}),
      ...(req.durable ? { backend: "tmux" } : {}), // A durable drive selects the tmux backend (terminal-worker-entry.ts reads p["backend"]).
      ...(req.executionAttachments === undefined ? {} : { executionAttachments: req.executionAttachments }),
    };
    const markSpawnFailure = (reply: TerminalReplyFrame): void => {
      if (reply.ok) return; // backend spawned — leave the session running.
      const h = sessions.get(sessionId);
      // A worker CRASH flushes this waiter with a synthetic `ok:false`; a durable session
      // whose tmux is STILL alive is NOT a spawn failure → stays recoverable. A real spawn
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
    };

    let rootProcessIdentity: TerminalRootProcessIdentity | undefined;
    if (req.managedBinding !== undefined) {
      const reply = await request(sessionId, "create", createParams);
      markSpawnFailure(reply);
      const result = reply.result as { rootPid?: unknown } | undefined;
      const rootPid = result?.rootPid;
      if (!reply.ok) {
        const terminated = await terminateAndConfirm(sessionId, owner);
        if (!terminated.ok) return Promise.reject(terminated.error);
        return Promise.reject(new Error("managed terminal backend create failed before root process identity was available"));
      }
      if (!Number.isSafeInteger(rootPid) || (rootPid as number) <= 0) {
        const terminated = await terminateAndConfirm(sessionId, owner);
        if (!terminated.ok) return Promise.reject(terminated.error);
        return Promise.reject(new Error("managed terminal create reply omitted a positive root PID"));
      }
      if (deps.resolveRootProcessIdentity === undefined) {
        const terminated = await terminateAndConfirm(sessionId, owner);
        if (!terminated.ok) return Promise.reject(terminated.error);
        return Promise.reject(new Error("managed terminal root process identity resolver is unavailable"));
      }
      rootProcessIdentity = await deps.resolveRootProcessIdentity(rootPid as number);
      if (rootProcessIdentity === undefined) {
        const terminated = await terminateAndConfirm(sessionId, owner);
        if (!terminated.ok) return Promise.reject(terminated.error);
        return Promise.reject(new Error(`managed terminal process ${String(rootPid)} start identity is unreadable`));
      }
      if (sessions.get(sessionId) !== handle) {
        return Promise.reject(new Error("managed terminal launch authority was revoked during creation"));
      }
      handle.rootProcessIdentity = rootProcessIdentity;
      const persistedIdentity = persistDurableDescriptor(
        req,
        owner,
        sessionId,
        createdAt,
        rootProcessIdentity,
      );
      if (!persistedIdentity.ok) {
        const retired = await terminateRetireAndDropManaged(handle);
        if (!retired.ok) {
          logger.warn(
            { sessionId, hint: "retry managed terminal retirement before releasing its reserved authority", errorKind: "resource" as const },
            "managed terminal identity persistence and retirement failed",
          );
        }
        return Promise.reject(persistedIdentity.error);
      }
    } else {
      const child = ensureWorker();
      const createFrame = buildRequestFrame(sessionId, "create", createParams);
      pending.set(`${sessionId}:${createFrame.requestId}`, markSpawnFailure);
      child.stdin?.write(encodeFrame(createFrame));
    }

    logger.info(
      { sessionId, allowId: req.allowId, command: req.bin },
      "terminal session registered",
    );
    return {
      sessionId,
      allowId: req.allowId,
      cols: req.cols,
      rows: req.rows,
      ...(rootProcessIdentity === undefined ? {} : { rootProcessIdentity }),
    };
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

  function getManagedBinding(sessionId: string): Omit<ManagedTerminalBinding, "canonicalRoot"> | undefined {
    const handle = sessions.get(sessionId);
    return handle?.managedRunId === undefined || handle.workspaceLeaseId === undefined || handle.serviceInstanceId === undefined
      ? undefined
      : { managedRunId: handle.managedRunId, workspaceLeaseId: handle.workspaceLeaseId, serviceInstanceId: handle.serviceInstanceId };
  }

  async function read(sessionId: string, owner: SessionOwner, opts?: ReadOptions): Promise<TerminalView> {
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined || handle.status === "lost") {
      // Not found / worker state lost — a minimal view the tool layer maps (no diff).
      // An exited session still exists in the worker, whose bounded emulator retains
      // the final screen needed to diagnose why the child stopped.
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
    // Owner-scoped: a cross-owner / absent / not-running session degrades
    // to the not-found view WITHOUT round-tripping a `status` frame — a probe with a
    // guessed sessionId never reaches the worker and never sees another owner's state.
    if (handle === undefined || handle.status !== "running") {
      return notFoundStatus(handle);
    }
    const reply = await request(sessionId, "status", { sessionId });
    handle.lastActivity = nowMs();
    // A wedged worker (reply timeout) degrades to the not-found view, never hangs.
    if (!reply.ok || reply.result === undefined) {
      return notFoundStatus(handle);
    }
    // The classifier state stays single-homed in the worker; compose it with the
    // daemon-side lastActivity (the leaf helper folds the two — keeps this file lean).
    // The `as WorkerStatusPerception` cast is of an UNTRUSTED cross-process reply, so
    // composeStatusView DEFENSIVELY narrows confidence/reason against a malformed /
    // version-skewed worker before they reach the status surface — the cast is
    // the happy-path type, the fold is the runtime safety net.
    return composeStatusView(reply.result as WorkerStatusPerception, handle);
  }

  /**
   * Defensively extract the `{screen,cursor}` subset from a worker reply.result
   * (read the fields rather than trusting the shape blindly — a corrupt reply
   * degrades to the empty snapshot, never injects an odd structure).
   */
  function toSendResult(result: unknown): SendResult {
    const r = (result ?? {}) as { screen?: unknown; cursor?: { x?: unknown; y?: unknown }; delivered?: unknown };
    const screen = typeof r.screen === "string" ? r.screen : "";
    const x = typeof r.cursor?.x === "number" ? r.cursor.x : 0;
    const y = typeof r.cursor?.y === "number" ? r.cursor.y : 0;
    return { screen, cursor: { x, y }, delivered: r.delivered === true };
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
      // Not-delivered: a wedged worker (the reply timeout) — the send
      // reached no live pane. delivered is left falsy so the audit records "rejected".
      return { screen: "", cursor: { x: 0, y: 0 } };
    }
    const result = toSendResult(reply.result);
    if (result.delivered !== true) return result;
    handle.lastActivity = nowMs();
    return result;
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
    const result = mapSendReply(handle, reply);
    // LOOP-CLOSURE: mark the drive TASKED once text actually lands on the pane (delivered). This is
    // the signal shouldPromoteDrive reads (everTasked) so a never-tasked detached durable drive does
    // not background at its first gate/idle wait. send_key is deliberately NOT counted — a trust-gate
    // answer or menu navigation is not a delivered task.
    if (result.delivered === true) handle.everSentText = true;
    return result;
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
    // Defensive worker→daemon map (preserves isComplete verbatim; passes producing/hint).
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

  function dropSession(handle: SessionHandle, message: string): void {
    const { sessionId } = handle;
    sessions.delete(sessionId);
    if (handle.workspace !== undefined) cleanupWorkspace(handle.workspace);
    if (handle.durable === true) deps.durability?.descriptorStore?.remove(sessionId);
    logger.info({ sessionId }, message);
  }

  function isManagedHandle(handle: SessionHandle): boolean {
    return handle.managedRunId !== undefined
      || handle.workspaceLeaseId !== undefined
      || handle.serviceInstanceId !== undefined;
  }

  function persistDurableDescriptor(
    req: CreateRequest,
    owner: SessionOwner,
    sessionId: string,
    createdAt: number,
    rootProcessIdentity?: TerminalRootProcessIdentity,
  ): Result<void, Error> {
    if (req.durable !== true) return ok(undefined);
    const store = deps.durability?.descriptorStore;
    if (store === undefined) {
      return req.managedBinding === undefined
        ? ok(undefined)
        : err(new Error("managed terminal durable descriptor store is unavailable"));
    }
    return store.persist(buildSessionDescriptor({
      sessionId,
      tmuxName: req.tmuxName ?? tmuxSessionName(sessionId),
      tmuxSocket: deps.tmuxSocketForSession?.(sessionId),
      allowId: req.allowId,
      owner,
      cols: req.cols,
      rows: req.rows,
      createdAt,
      scope: req.scope,
      originEndpoint: req.originEndpoint,
      managedBinding: req.managedBinding,
      rootProcessIdentity,
    }));
  }

  async function retireManagedExit(handle: SessionHandle): Promise<void> {
    const { sessionId, managedRunId, workspaceLeaseId, serviceInstanceId } = handle;
    const retireManagedSession = deps.durability?.retireManagedSession;
    if (
      managedRunId === undefined
      || workspaceLeaseId === undefined
      || serviceInstanceId === undefined
      || retireManagedSession === undefined
    ) {
      logger.warn(
        { sessionId, hint: "restore the exact managed terminal retirement authority before cleanup", errorKind: "resource" as const },
        "managed terminal exit retained its durable descriptor",
      );
      return;
    }
    const invoked = await fromPromise(retireManagedSession({
      managedRunId,
      workspaceLeaseId,
      serviceInstanceId,
      terminalSessionId: sessionId,
      transition: "exited",
    }));
    if (invoked.ok && invoked.value.ok) {
      deps.durability?.descriptorStore?.remove(sessionId);
      return;
    }
    logger.warn(
      { sessionId, hint: "retry durable terminal retirement before removing its descriptor", errorKind: "resource" as const },
      "managed terminal exit retirement failed",
    );
  }

  async function terminateRetireAndDropManaged(handle: SessionHandle): Promise<Result<void, Error>> {
    const { sessionId, managedRunId, workspaceLeaseId, serviceInstanceId } = handle;
    if (managedRunId === undefined || workspaceLeaseId === undefined || serviceInstanceId === undefined) {
      return err(new Error("managed terminal retirement identity is unavailable"));
    }
    const retireManagedSession = deps.durability?.retireManagedSession;
    if (retireManagedSession === undefined) {
      return err(new Error("managed terminal durable retirement is unavailable"));
    }
    if (handle.status === "running") {
      if (worker === undefined) return err(new Error("terminal worker is unavailable"));
      const reply = await request(sessionId, "kill", { sessionId });
      if (!reply.ok) return err(new Error(reply.error ?? "terminal backend termination was not acknowledged"));
      handle.status = "exited";
      handle.lastActivity = nowMs();
      if (handle.durable === true && handle.tmuxName !== undefined) {
        deps.durability?.killTmuxSession?.(handle.tmuxName, handle.tmuxSocket);
      }
    }
    const invoked = await fromPromise(retireManagedSession({
      managedRunId,
      workspaceLeaseId,
      serviceInstanceId,
      terminalSessionId: sessionId,
      transition: "released",
    }));
    if (!invoked.ok) return err(invoked.error);
    if (!invoked.value.ok) return invoked.value;
    dropSession(handle, "managed terminal termination and retirement confirmed");
    return ok(undefined);
  }

  /** Shared end-of-life boundary. Managed authority is retired durably before deletion. */
  async function evictInternal(handle: SessionHandle): Promise<Result<void, Error>> {
    if (isManagedHandle(handle)) return terminateRetireAndDropManaged(handle);
    const { sessionId } = handle;
    if (worker !== undefined && handle.status === "running") {
      send(sessionId, "kill", { sessionId });
    }
    if (handle.durable === true && handle.tmuxName !== undefined) {
      deps.durability?.killTmuxSession?.(handle.tmuxName, handle.tmuxSocket);
    }
    dropSession(handle, "terminal session killed");
    return ok(undefined);
  }

  async function terminateAndConfirm(sessionId: string, owner: SessionOwner): Promise<Result<void, Error>> {
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined) return err(new Error("terminal session authority is unavailable"));
    if (isManagedHandle(handle)) return terminateRetireAndDropManaged(handle);
    if (handle.status === "running") {
      if (worker === undefined) return err(new Error("terminal worker is unavailable"));
      const reply = await request(sessionId, "kill", { sessionId });
      if (!reply.ok) return err(new Error(reply.error ?? "terminal backend termination was not acknowledged"));
    }
    dropSession(handle, "terminal session termination confirmed");
    return ok(undefined);
  }

  async function kill(sessionId: string, owner: SessionOwner): Promise<void> {
    // A no-op if absent OR not owned by the caller (a subagent cannot terminate a
    // sibling subagent's session). Owner mismatch == not-found.
    const handle = ownedHandle(sessionId, owner);
    if (handle === undefined) return;
    const evicted = await evictInternal(handle);
    if (!evicted.ok) return Promise.reject(evicted.error);
  }

  // Compose the reaper + its single audited eviction site (the wiring closes over
  // `sessions` + `evictInternal` — the reused drop+cleanup site).
  const { reaper, evict: evictForReaper } = wireRegistryReaper({ sessions, nowMs, evictInternal, logger, caps: deps });
  reaper?.start(); // arm the periodic sweep iff the reaper is composed.

  async function evict(sessionId: string, owner: SessionOwner, reason: EvictReason): Promise<void> {
    // Owner-scoped like kill (no-op on absent/cross-owner); the single eviction
    // entry reused for max_interactions (cap-forget runs on that path too).
    if (ownedHandle(sessionId, owner) === undefined) return;
    const evicted = await evictForReaper(sessionId, reason);
    if (!evicted.ok) return Promise.reject(evicted.error);
  }

  function size(): number {
    return sessions.size;
  }

  async function cleanup(): Promise<void> {
    // Stop the reaper FIRST so the sweep interval never outlives the registry
    // (no leaked interval firing post-teardown).
    reaper?.stop();
    // Owner-AGNOSTIC: tears down the per-agent registry, dropping every session (the worker is shared across owners).
    for (const handle of Array.from(sessions.values())) {
      if (handle.durable === true) continue; // PRESERVE a durable session (detached tmux + descriptor) for recover-on-boot re-attach; never kill it on a graceful shutdown.
      const evicted = await evictInternal(handle);
      if (!evicted.ok) {
        logger.warn({ sessionId: handle.sessionId, hint: "retry terminal cleanup before daemon shutdown", errorKind: "resource" as const }, "terminal session cleanup failed");
      }
    }
    if (worker !== undefined) {
      worker.kill("SIGTERM");
      clearWorker();
    }
  }

  // Recover-on-boot (sibling-owned; no-op without a store).
  // The 4th arg is the worker `reattach` round-trip the sibling drives (worker re-attaches
  // the surviving pane, NEVER a create; running status + obs hooks gated on its ok).
  if (deps.durability !== undefined)
    applyRecoveredSessions(deps.durability, sessions, nowMs, (id, cols, rows, allowId, tmuxSocket) =>
      // Thread the recovered session's allowId so the worker re-resolves its platform profile
      // (render transform + perception) on reattach — without it a durable claude drive reverts to the
      // agnostic path after a restart (ghost-strip + perception silently lost).
      request(id, "reattach", { sessionId: id, cols, rows, allowId, ...(tmuxSocket !== undefined ? { tmuxSocket } : {}) }),
    );

  return { create, read, status, sendText, sendKey, resize, wait, get, getManagedBinding, list, kill, terminateAndConfirm, evict, getOwner: (sessionId: string): SessionOwner | undefined => sessions.get(sessionId)?.owner, getOriginEndpoint: (sessionId: string): ChannelEndpoint | undefined => sessions.get(sessionId)?.originEndpoint, size, cleanup };
}
