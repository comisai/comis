// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the worker IS the frame error-mapping boundary — `dispatch` wraps every handler in a try/catch that maps a thrown error to an `ok:false` reply (the registry's error-reply path). The sole `throw` is `handleCreate` re-raising a fail-closed JailUnavailableError (after dropping the half-registered session) so it reaches that boundary; never an unjailed fallback.
/**
 * The supervised Terminal Worker entry.
 *
 * The worker is the one net-new process boundary: a daemon-supervised child that
 * owns the PTY (node-pty, optional) + the driven CLI. The registry spawns
 * it under the proven `--permission` posture and exchanges length-prefixed JSON
 * frames over stdio. A FACTORY (`createTerminalWorker(deps)`) so it is
 * fully unit-testable WITHOUT forking — loader, logger, clock, env snapshot, pipe
 * spawner, durable-fs ops, the @xterm emulator factory, AND the scope-jail
 * composers are all injected.
 *
 * Architecture invariants enforced here: NO top-level static `node-pty` import
 * (INJECTED `loadPty`; a throw → the PIPE backend, `degraded`); NO
 * module-global mutable state (the session map is CLOSURE-local); NO `@comis/infra`
 * value-import (injected structural logger); NO redundant path resolution (the
 * frame's `{bin,argv}` ride VERBATIM after the bwrap `--`; buildDirectSpawn is the
 * SOLE path-resolution site); NO raw wall-clock/timer/env globals
 * (injected ports). The child runs INSIDE a bwrap jail — both backends
 * spawn `bwrap [scope args] -- bin argv`; no unjailed path.
 *
 * @module
 */

import {
  systemNowMs,
  systemEnvSnapshot,
  runWithContext,
  systemSetTimeout,
  systemClearTimeout,
  type SystemTimeoutHandle,
  type EgressControlPort,
} from "@comis/core";
import { isFsyncDisabledByPermissionModel, suppressError } from "@comis/shared";

import type { TerminalScope } from "./allowlist-matcher.js";
import {
  planSpawnFromCreateFrame,
  LEAST_PRIVILEGE_SCOPE,
  type SpawnPlanComposers,
} from "./terminal-spawn-plan.js";
import { buildScopeArgs as defaultBuildScopeArgs } from "./terminal-scope-args.js";
import { scrubChildEnv as defaultScrubChildEnv } from "./terminal-env-scrub.js";
import { buildEgressRelayLaunch as defaultBuildEgressRelayLaunch } from "./terminal-egress-relay.js";
import type { TerminalReplyFrame, TerminalRequestFrame } from "./terminal-ipc.js";
import { encodeKeyChord } from "./terminal-key-grammar.js";
import { sanitizeTraceId, WORKER_TRUST_LEVEL } from "./terminal-worker-context.js";
import { attachBackend } from "./terminal-worker-backend-attach.js";
import {
  SCROLLBACK_DEFAULT,
  STUCK_DEFAULT_MS,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  defaultLoadPty,
  defaultSpawnPipe,
  defaultFsPort,
} from "./terminal-worker-defaults.js";
import { createAttentionEmitter } from "./terminal-attention-emitter.js";
import { reattachWorkerSession } from "./terminal-worker-reattach.js";
import { observeSettledFrame, statusReplyFromState, type WorkerStatusPerception } from "./terminal-worker-classify.js";
// The worker's structural contracts the entry BODY references (deps/defaults/closures)
// type-imported from the neutral leaf terminal-worker-types.ts (breaks the import cycle).
// FakePtyLike is no longer referenced in the body (its consumers PtyModuleLike +
// SessionState moved to the leaf) — it is still re-exported for the public surface below.
import type {
  PipeChildLike,
  PtyModuleLike,
  SessionState,
  TmuxBackendLike,
  WorkerBackend,
  WorkerFsPort,
  WorkerLogger,
} from "./terminal-worker-types.js";
import {
  buildReadResult,
  createSessionEmulator,
  diffSnapshot,
  perceptionScreen,
  readSnapshotParams,
  type EmulatorSnapshot,
  type ReadResult,
  type SessionEmulator,
} from "./terminal-render.js";
import { getPlatformProfile } from "./platforms/index.js";
import {
  runSettle,
  settleHint,
  SETTLE_DEFAULT_IDLE_MS,
  type SettleDeps,
  type SettleParams,
  type SettleResult,
} from "./terminal-settle.js";

// SCROLLBACK_DEFAULT / STUCK_DEFAULT_MS + the production-default ports
// (defaultLoadPty/defaultSpawnPipe/defaultFsPort) + the BRACKETED_PASTE_* constants
// live in ./terminal-worker-defaults.ts so this file stays under the line cap;
// imported above + defaultLoadPty re-exported below so the public surface is unchanged.

// ---------------------------------------------------------------------------
// Injected dependency contracts
// ---------------------------------------------------------------------------
//
// WorkerLogger + FakePtyLike + PtyModuleLike + PipeChildLike + WorkerBackend +
// SessionState + WorkerFsPort live in the neutral leaf terminal-worker-types.ts to
// break the import cycles (the entry value-imports attachBackend +
// terminal-worker-defaults, both of which need these types back).
// Type-imported above; re-exported below so the public surface (TerminalWorkerDeps + the
// worker tests' structural-type imports) is unchanged.

/** Worker dependencies — all injectable for unit tests; production defaults provided. */
// @optional-field-count: 15 optional fields — TerminalWorkerDeps is the worker's
// dependency-injection contract: EVERY optional is a genuinely-conditional injectable port
// (spawnPipe/loadTmux/nowMs/envSnapshot/fs/setTimer/clearTimer/createEmulator/buildScopeArgs/
// scrubChildEnv/buildEgressRelayLaunch/egressControl/writeFd3/stuckMs/bwrapPath) with a
// factory default (or daemon-injected), overridden ONLY by a test or the composition root.
// Tightening any to required would force every call site to fabricate a port it never
// exercises. The "(a) genuinely conditional" classification, not a cluster-split — one
// cohesive worker deps bag.
export interface TerminalWorkerDeps {
  /** Load node-pty. Default: a guarded `createRequire` load in a try — NEVER a top-level static import (crashes module load on a no-prebuild host); a throw → the pipe backend. */
  loadPty: () => PtyModuleLike;
  /** The tmux named-session backend loader — the 3rd option behind the same FakePtyLike seam as node-pty | pipe. Used ONLY when a create frame requests `backend:"tmux"`; the daemon binds it (resolved tmux path + has-session probe + runTmux). Absent ⇒ a tmux request falls back to pty/pipe. */
  loadTmux?: TmuxBackendLike;
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
  /** Schedule a one-shot timer. Default: wraps `systemSetTimeout` (no raw `setTimeout` global) + `.unref()`s the handle so a pending settle timer never holds the loop open. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
  /** Construct a per-session @xterm emulator. Default: `createSessionEmulator`. Injectable so a test can assert the wiring (mirrors loadPty/spawnPipe). `transformSnapshot` is the selected platform profile's read-side render hook, passed through verbatim. */
  createEmulator?: (opts: {
    cols: number;
    rows: number;
    scrollback: number;
    transformSnapshot?: (snap: EmulatorSnapshot) => EmulatorSnapshot;
  }) => SessionEmulator;
  /**
   * Write a length-prefixed frame to fd3 — the no-poll attention push channel.
   * Production wraps `fs.writeSync(3, b)` (the worker spawns with fd3 reserved,
   * `terminal-worker-launch.ts`); tests inject a capturing fake. ABSENT ⇒ the attention
   * emit is a no-op (the worker still settles normally — the emit is best-effort, never
   * required for correctness). The fd3 frame carries a redaction-safe summary ONLY.
   */
  writeFd3?: (b: Buffer) => void;
  /**
   * The operator stuck threshold in ms (`worker.stuckMs`) the classifier compares
   * to a session's no-progress window. Default {@link STUCK_DEFAULT_MS}; the daemon threads
   * the config value. Stuck is by PROGRESS, never elapsed session wall-clock.
   */
  stuckMs?: number;
  // -- Scope-jail composition (injected; heavy logic is terminal-spawn-plan.ts) --
  /** Scope->bwrap argv composer. Default: the module export. */
  buildScopeArgs?: typeof defaultBuildScopeArgs;
  /** Child-env blocklist scrubber. Default: the module export. */
  scrubChildEnv?: typeof defaultScrubChildEnv;
  /** Egress relay-as-init launch builder. Default: the module export. */
  buildEgressRelayLaunch?: typeof defaultBuildEgressRelayLaunch;
  /** Daemon-injected no-secret egress port (TYPE from @comis/core, NEVER infra). ONLY `network: listed-hosts` materializes it; untouched for none/full. */
  egressControl?: EgressControlPort;
  /** Resolved bwrap path (daemon-detected once). NO default — `undefined` ⇒ fail-closed: no spawn, create reply `ok:false`, session `lost`; never an unjailed fallback. */
  bwrapPath?: string;
}

// ---------------------------------------------------------------------------
// Frame result shapes + the worker's structural contracts
// ---------------------------------------------------------------------------
//
// WorkerBackend + SessionState + the four per-method reply shapes (CreateResult /
// SendResult / ResizeResult / WaitResult) live in the neutral leaf
// terminal-worker-types.ts to keep this file under the 800-line cap. Type-imported here for the handler
// bodies + RE-EXPORTED below so every existing `from "./terminal-worker-entry.js"`
// importer (the worker tests, the render-live harness) keeps working — type-only, no churn.
import type {
  CreateResult,
  ResizeResult,
  SendResult,
  WaitResult,
} from "./terminal-worker-types.js";

export type {
  FakePtyLike,
  PipeChildLike,
  PtyModuleLike,
  SessionState,
  TmuxBackendLike,
  WorkerBackend,
  WorkerFsPort,
  WorkerLogger,
} from "./terminal-worker-types.js";

/** The worker's public surface — `handle` dispatches a frame; `writeDurable` persists state. */
export interface TerminalWorker {
  handle(frame: TerminalRequestFrame): Promise<TerminalReplyFrame>;
  writeDurable(path: string, data: string): void;
}

// The production-default ports (defaultLoadPty / defaultSpawnPipe / defaultFsPort) +
// the bracketed-paste delimiters live in ./terminal-worker-defaults.ts to keep this
// file under the line cap; imported above. defaultLoadPty is re-exported at the file tail.

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Terminal Worker. The per-session backend + ring map is CLOSURE-local
 * — there is no module-global mutable state. Each `handle(frame)` re-establishes
 * a VALIDATED `traceId` as the ALS context so worker logs
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
  // holds the event loop open — mirrors the registry's port shape.
  const setTimer =
    deps.setTimer ??
    ((cb: () => void, ms: number): SystemTimeoutHandle => {
      const h = systemSetTimeout(cb, ms);
      h.unref();
      return h;
    });
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => systemClearTimeout(handle as SystemTimeoutHandle));
  // The per-session @xterm emulator factory. Default: the real pure-JS
  // wrapper; a test injects a recording emulator to assert the wiring.
  const createEmulator = deps.createEmulator ?? createSessionEmulator;
  // The no-poll attention plumbing. `writeFd3` is the push-channel sink (a
  // production worker wraps `fs.writeSync(3, …)`; absent ⇒ the emit is a no-op). `stuckMs`
  // is the operator stuck threshold the classifier compares no-progress against.
  const { writeFd3 } = deps;
  const stuckMs = deps.stuckMs ?? STUCK_DEFAULT_MS;
  // The scope-jail composers, threaded into planSpawnFromCreateFrame at the
  // spawn seam. bwrapPath/egressControl have NO default — the daemon injects them.
  const spawnComposers: SpawnPlanComposers = {
    buildScopeArgs: deps.buildScopeArgs ?? defaultBuildScopeArgs,
    scrubChildEnv: deps.scrubChildEnv ?? defaultScrubChildEnv,
    buildEgressRelayLaunch: deps.buildEgressRelayLaunch ?? defaultBuildEgressRelayLaunch,
    egressControl: deps.egressControl,
    bwrapPath: deps.bwrapPath,
  };

  // appendRing (ring + emulator feed + settle ring-change notify) and markExited (not-alive
  // flip + once-only egress dispose + settle exit notify) live in terminal-worker-backend-attach.ts
  // — their ONLY callers are the backend stream handlers there, so they ride with
  // attachBackend.

  /** Resolve the backend write sink: pty.write for the pty backend, else pipe.stdin.write. */
  function writeToBackend(state: SessionState, bytes: string): void {
    if (state.pty !== undefined) {
      state.pty.write(bytes);
      return;
    }
    state.pipe?.stdin?.write(bytes);
  }

  /**
   * Build the {@link SettleDeps} over a session (injected timer ports + ring/liveness
   * getters + closure-local listener sets) and run the bounded settle — the
   * heart of every act-then-return-SETTLED handler + the explicit `wait`. `params`
   * passes through to {@link runSettle}.
   */
  async function settleSession(state: SessionState, params: SettleParams, suppressAttentionEmit = false): Promise<SettleResult> {
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
      // Content below the viewport is NOT settleable — the idle path RE-ARMS
      // (more below ⇒ keep waiting). The gate only SUPPRESSES an idle-settle, never
      // forces one (exit/text/timeout unaffected).
      isSettleable: () => !(state.emu?.hasContentBelowFold() ?? false),
    };
    const result = await runSettle(settleDeps, params);

    // The no-poll mechanism: after the settle resolves, classify the
    // settled frame and hand the verdict to the per-session emitter — which writes a fd3
    // attention frame ONLY on a state TRANSITION. EDGE-triggered (driven by the settle the
    // worker already runs), NEVER a poll. `settled` is true unless the settle timed out
    // (output still in flight ⇒ the classifier reads `working`). Best-effort: skipped when
    // no emitter is wired (no `writeFd3`); a classify/emit failure must not break the settle.
    if (state.emitter !== undefined) {
      await observeSettledFrame({
        state,
        emitter: state.emitter,
        settled: result.reason !== "timeout",
        nowMs,
        stuckMs,
        // A foreground `wait` settle suppresses the fd3 attention write (the wait
        // reply is the agent's signal); act-then-return settles (create/send) emit normally.
        suppressEmit: suppressAttentionEmit,
      });
    }
    return result;
  }

  /**
   * Handle a `create` frame. Materializes the entry's `scope` into a bwrap jail
   * and spawns `bwrap [scope args] -- bin argv` (the worker holds the PTY
   * master; bwrap + the driven child run INSIDE). The frame's `{bin,argv}` ride
   * VERBATIM after the composer's `--` (no re-resolution; buildDirectSpawn is
   * the SOLE path-resolution site). BOTH backends are wrapped (no unjailed path).
   * Fail-closed: no `bwrapPath` (or a `listed-hosts` scope with no egress
   * port) ⇒ {@link planSpawnFromCreateFrame} throws ⇒ dispatch replies `ok:false`
   * (the registry flips the session `lost`) and NOTHING spawns.
   */
  async function handleCreate(frame: TerminalRequestFrame): Promise<CreateResult> {
    const startedAt = nowMs();
    const p = frame.params;
    const sessionId = String(p["sessionId"]);
    const bin = String(p["bin"]);
    const argv = Array.isArray(p["argv"]) ? (p["argv"] as string[]) : [];
    const cols = typeof p["cols"] === "number" ? p["cols"] : 80;
    const rows = typeof p["rows"] === "number" ? p["rows"] : 24;
    // The create frame carries the per-session scrollback ceiling (registry-
    // sourced from DEFAULT_SCROLLBACK / config, NOT agent input); fall back to
    // SCROLLBACK_DEFAULT only when the frame omits it.
    const scrollback = typeof p["scrollback"] === "number" ? p["scrollback"] : SCROLLBACK_DEFAULT;
    // The operator scope + its workspace/cwd jail companions (threaded onto the
    // frame). Least-privilege default when absent.
    const scope = (p["scope"] as TerminalScope | undefined) ?? LEAST_PRIVILEGE_SCOPE;
    const workspace = typeof p["workspace"] === "string" ? p["workspace"] : undefined;
    const cwd = typeof p["cwd"] === "string" ? p["cwd"] : undefined;
    // The operator-declared allowId (registry-threaded from the create request). It selects the
    // read-side platform profile — by allowId ONLY, never content-sniffed,
    // so the driven program cannot choose its own profile. `undefined` ⇒ the agnostic default.
    const allowId = typeof p["allowId"] === "string" ? p["allowId"] : undefined;
    const profile = allowId !== undefined ? getPlatformProfile(allowId) : undefined;

    const state: SessionState = {
      backend: "pty",
      cols,
      rows,
      ring: "",
      alive: true,
      interactions: 0,
      ringListeners: new Set(),
      exitListeners: new Set(),
      scope,
      workspace,
      cwd,
      allowId,
    };

    // Construct the per-session @xterm emulator BEFORE wiring the backend's onData
    // (so the first chunk is rendered). Built for BOTH backends; the
    // scrollback is threaded from the create frame (DEFAULT_SCROLLBACK / config, never agent input).
    // The selected profile's read-side `transformSnapshot` (e.g. the Claude ghost-strip) is injected
    // as a GENERIC hook — the emulator stays platform-agnostic; identity when no profile.
    state.emu = createEmulator({ cols, rows, scrollback, transformSnapshot: profile?.transformSnapshot });

    // A per-session transition-only attention emitter over the injected
    // fd3 push channel. Built only when `writeFd3` is wired (the production worker; tests
    // inject a fake). The worker hands each SETTLED frame's classification to
    // `emitter.observe` (in settleSession) — which writes a fd3 frame ONLY on a state
    // transition. No emitter (no writeFd3) ⇒ the classify-and-emit step is skipped.
    if (writeFd3 !== undefined) {
      const emitter = createAttentionEmitter({ sessionId, writeFd3 });
      state.emitter = emitter;
      // The exit wake: `markExited` fires this so a child that exits
      // with NO settle pending still pushes its exited transition on fd3 — the
      // no-poll wake holds for completion, not just prompts (without it an event-driven
      // agent whose long command finished while it sat idle is NEVER woken; the
      // `claude --help` soak run is exactly that shape). Same single-homed classify
      // seam as the settle path; the edge-triggered emitter dedups a concurrent
      // settle-resolved observe of the same exit. Fire-and-forget; never throws.
      state.observeExit = () => {
        // Best-effort: an emit failure must never break the exit path. `observeSettledFrame`
        // is documented total, but suppressError (not a bare empty catch — the banned form)
        // guards the void-promise and routes any rejection through the structural logger.
        suppressError(
          observeSettledFrame({ state, emitter, settled: true, nowMs, stuckMs }),
          "terminal exit-wake fd3 emit",
          (m) => logger.debug({ submodule: "exit-wake", sessionId, errorKind: "internal" }, m),
        );
      };
    }

    // Register the session SYNCHRONOUSLY (before the async spawn-plan await) so a
    // read/resize/wait frame arriving mid-composition finds it; the backend attaches
    // after the plan (create was once sync — the egress materialize made it async).
    sessions.set(sessionId, state);

    // Compose the bwrap-wrapping spawn (host-side jail companions +
    // SYSTEM_RO_PATHS filtering live in planSpawnFromCreateFrame so the worker stays
    // fs/os-read-free). THROWS when fail-closed (no bwrapPath / no egress
    // port) — caught to DROP the session + re-throw so dispatch replies ok:false (the
    // registry flips it lost); NOTHING spawns. The frame's bwrapPath (registry-threaded
    // from the daemon) overrides the factory default.
    const frameBwrapPath = typeof p["bwrapPath"] === "string" ? p["bwrapPath"] : spawnComposers.bwrapPath;
    let plan;
    try {
      plan = await planSpawnFromCreateFrame(
        { bin, argv, scope, workspace, cwd },
        envSnapshot(),
        { ...spawnComposers, bwrapPath: frameBwrapPath },
      );
    } catch (err) {
      sessions.delete(sessionId); // fail-closed: no backend attaches; surface ok:false
      throw err;
    }
    state.egress = plan.egress; // disposed on teardown (markExited)

    // Attach the backend (PTY or the degraded pipe fallback) — the EXACT try-loadPty /
    // wire-onData/onExit / pipe-close-error block, lifted into a sibling so this file
    // keeps headroom under the 800-line cap. appendRing/markExited moved with it
    // (their only callers were those stream handlers); the rest ride in as explicit params.
    // Only an explicit create-frame `backend:"tmux"` (allow-entry, daemon-threaded) + a
    // wired `loadTmux` diverges to the tmux survival backend; everything else takes the
    // node-pty → pipe path (attachBackend decides).
    const requestedBackend: WorkerBackend | undefined = p["backend"] === "tmux" ? "tmux" : undefined;
    attachBackend({
      plan: { bin: plan.bin, argv: plan.argv, env: plan.env },
      cols,
      rows,
      state,
      loadPty: deps.loadPty,
      spawnPipe,
      logger,
      requestedBackend,
      loadTmux: deps.loadTmux,
      sessionId,
    });

    // (The session was registered synchronously above so concurrent frames find it.)
    logger.info(
      { sessionId, backend: state.backend, durationMs: nowMs() - startedAt },
      "terminal session created",
    );
    return { sessionId, backend: state.backend, cols, rows };
  }

  /**
   * Handle a `read` frame. AWAITS the pending emulator write-parse
   * ({@link SessionState.writeFlush}, the stability flush — resolves on the
   * @xterm parse callback) so the snapshot reflects every emitted byte, then
   * serializes the @xterm grid (real cursor+alt) in the requested format/scrollback.
   * The emulator is the SOLE source when present; the raw ring is the emulator-absent
   * fallback (NOT a dual path) — see {@link buildReadResult}.
   */
  async function handleRead(frame: TerminalRequestFrame): Promise<ReadResult> {
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) {
      return { screen: "", cursor: { x: 0, y: 0 }, cols: 0, rows: 0, alt: false, alive: false };
    }
    await state.writeFlush;
    const snap = state.emu?.snapshot(readSnapshotParams(frame.params));
    const result = buildReadResult(snap, {
      ring: state.ring,
      cols: state.cols,
      rows: state.rows,
      alive: state.alive,
    });
    // Screen-diff: compare to the prior snapshot, attach the diff, store the
    // new one as lastSnapshot. Only when an emulator snapshot exists (the diff is
    // over the rendered grid; the degraded ring-fallback path carries no diff).
    if (snap !== undefined) {
      result.diff = diffSnapshot(state.lastSnapshot, snap);
      state.lastSnapshot = snap;
    }
    return result;
  }

  /** The not-alive minimal `{screen,cursor}` for an absent/gone session. */
  function goneSnapshot(): SendResult {
    return { screen: "", cursor: { x: 0, y: 0 } };
  }

  /**
   * One bounded INFO line per interaction handler (method + durationMs). ALSO
   * the single chokepoint that advances the per-session interaction counter:
   * every send_text / send_key / wait / resize lands here (read/status are read-only
   * and do NOT call this), so `interactions` increments in exactly one place.
   */
  function logInteraction(
    sessionId: string,
    method: string,
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): void {
    const state = sessions.get(sessionId);
    if (state !== undefined) state.interactions += 1;
    logger.info(
      { sessionId, method, durationMs: nowMs() - startedAt, step: "interaction", ...extra },
      "terminal interaction",
    );
  }

  /**
   * Handle a `send_key` frame: encode the chord via the named-key grammar,
   * write the EXACT bytes ONCE. An unknown key makes `encodeKeyChord`
   * throw `invalid_value` → dispatch's catch returns ok:false with NOTHING written
   * (the write is AFTER the encode — the keystroke-injection guard).
   */
  async function handleSendKey(frame: TerminalRequestFrame): Promise<SendResult> {
    const startedAt = nowMs();
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) return goneSnapshot();

    const keys = Array.isArray(frame.params["keys"]) ? (frame.params["keys"] as string[]) : [];
    // encodeKeyChord throws invalid_value on an unknown key → dispatch's catch (write
    // is AFTER encode, so a throw writes NOTHING — the keystroke-injection guard).
    const bytes = encodeKeyChord(keys);
    writeToBackend(state, bytes);

    logInteraction(sessionId, "send_key", startedAt, { keyCount: keys.length });
    await state.writeFlush; // perceive the SETTLED grid (like read), not a mid-parse snapshot
    return perceptionScreen(state.emu?.snapshot(), state.ring);
  }

  /**
   * Handle a `send_text` frame: write the text (bracketed-paste-wrapped on
   * request), settle, then on `submit` write `\r` as a SEPARATE write AFTER the
   * settle resolves (text → settle → Enter; NEVER coalesced, so the program
   * consumes/echoes the line before it sees Enter). Returns the post-action SETTLED snapshot.
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

    // Settle so the program consumed/echoed the text; on submit the settle SEPARATES
    // the text from the Enter byte, else it still settles for the post-action snapshot.
    await settleSession(state, { forIdleMs: SETTLE_DEFAULT_IDLE_MS });
    if (submit) {
      writeToBackend(state, "\r");
    }

    logInteraction(sessionId, "send_text", startedAt, {
      submit,
      bracketedPaste,
      bytes: payload.length,
    });
    await state.writeFlush; // perceive the SETTLED grid, not a mid-parse snapshot
    return perceptionScreen(state.emu?.snapshot(), state.ring);
  }

  /**
   * Handle a `resize` frame: resize the PTY winsize (pty backend only), the
   * @xterm emulator grid (reflows on BOTH backends), and record the ring
   * geometry. The degraded pipe backend has no winsize but its grid still reflows. Replies `{ ok }`.
   */
  function handleResize(frame: TerminalRequestFrame): ResizeResult {
    const startedAt = nowMs();
    const sessionId = String(frame.params["sessionId"] ?? frame.sessionId);
    const state = sessions.get(sessionId);
    if (state === undefined) return { ok: false };

    const cols = typeof frame.params["cols"] === "number" ? frame.params["cols"] : state.cols;
    const rows = typeof frame.params["rows"] === "number" ? frame.params["rows"] : state.rows;

    state.pty?.resize(cols, rows); // pty backend; the pipe backend has no winsize
    state.emu?.resize(cols, rows); // reflow the @xterm grid on both backends
    state.cols = cols;
    state.rows = rows;

    logInteraction(sessionId, "resize", startedAt, { cols, rows });
    return { ok: true };
  }

  /**
   * Handle a `wait` frame — the explicit parameterized settle. Runs {@link runSettle} and
   * replies `{matched,isComplete,reason,producing,hint,screen,cursor}`;
   * an absent session is gone (reason `exit`, not-complete). CRITICAL: `isComplete` passes from
   * runSettle VERBATIM — `false` on timeout (attention model resumes the turn), NEVER hard-coded true.
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
    // Suppress the fd3 attention emit for this foreground `wait` settle — the wait
    // reply below IS the agent's attention signal (it unblocks + drives), so a fd3 woken turn would
    // race it (the launch escalation). The progress clock + the emitter's edge-state still advance.
    const r = await settleSession(state, params, true);

    logInteraction(sessionId, "wait", startedAt, { reason: r.reason, isComplete: r.isComplete });
    await state.writeFlush; // perceive the SETTLED grid, not a mid-parse snapshot
    return {
      matched: r.matched,
      isComplete: r.isComplete, // VERBATIM from runSettle — false on timeout.
      reason: r.reason,
      producing: r.producing, // was output still arriving at a not-complete timeout?
      hint: settleHint(r), // branched, actionable not-complete-timeout hint
      ...perceptionScreen(state.emu?.snapshot(), state.ring),
    };
  }

  /**
   * Handle a `status` frame (perception) — the classifier
   * stays SINGLE-HOMED in the worker. Delegates to the read-only
   * {@link statusReplyFromState} (it classifies the CURRENT grid; see its doc). An
   * absent session is gone → `exited`. `settled:true` (a point-in-time snapshot).
   */
  async function handleStatus(frame: TerminalRequestFrame): Promise<WorkerStatusPerception> {
    const state = sessions.get(String(frame.params["sessionId"] ?? frame.sessionId));
    // Absent session → gone (`exited`, the safe direction). Confidence+reason stay TOTAL here too (an absent session IS exited; mirrors notFoundStatus — never an undefined field). Else classify the live grid.
    if (state === undefined) return { state: "exited", cursorParked: false, screenDiffEmpty: true, interactions: 0, confidence: "high", reason: "exited" };
    return statusReplyFromState({ state, settled: true, nowMs, stuckMs });
  }

  /** Dispatch a decoded request frame to its method handler. */
  async function dispatch(frame: TerminalRequestFrame): Promise<TerminalReplyFrame> {
    try {
      let result: unknown;
      switch (frame.method) {
        case "create":
          result = await handleCreate(frame); // awaits the scope-jail composition; fail-closed throw → ok:false
          break;
        case "reattach": {
          // Recover-on-boot re-attach (sibling-owned for cap headroom) —
          // ok:false when the tmux session is gone (the registry flips lost), so it rides the
          // reply.ok channel directly (the surviving pane is read, never re-spawned).
          const r = await reattachWorkerSession({
            frame, sessions, createEmulator, writeFd3, nowMs, stuckMs, logger,
            loadPty: deps.loadPty, spawnPipe, loadTmux: deps.loadTmux, envSnapshot,
            scrollbackDefault: SCROLLBACK_DEFAULT,
          });
          return { sessionId: frame.sessionId, requestId: frame.requestId, ok: r.ok, result: { backend: r.backend } };
        }
        case "read":
          result = await handleRead(frame); // awaits the pending emulator write-parse
          break;
        case "send_key":
          result = await handleSendKey(frame);
          break;
        case "send_text":
          result = await handleSendText(frame); // awaits the text↔submit settle
          break;
        case "resize":
          result = handleResize(frame);
          break;
        case "wait":
          result = await handleWait(frame); // awaits the bounded settle
          break;
        case "status":
          result = await handleStatus(frame); // awaits the pending emulator write-parse; classifies the current grid
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
   * Persist durable worker state via write→rename, swallowing ONLY the disabled-fsync
   * refusal under `--permission`. A genuine I/O error (EIO/ENOSPC/EBADF)
   * re-throws (real disk problems are not masked); the fsync is best-effort over an
   * already-completed write+rename (skipping it only widens the power-failure window).
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
      // Re-establish the originating traceId as the ALS context (ALS does
      // not cross the process boundary — re-established from the frame here) so the
      // bound logger's mixin carries it. The wire traceId is VALIDATED (a
      // non-UUID is regenerated — log-correlation-poisoning defense) + the context
      // runs at the least-privileged trust level (the worker makes no authz calls).
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
