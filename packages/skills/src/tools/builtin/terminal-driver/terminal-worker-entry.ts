// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the worker IS the frame error-mapping boundary — `dispatch` wraps every handler in a try/catch that maps a thrown error to an `ok:false` reply (the registry's error-reply path). The sole `throw` is `handleCreate` re-raising a fail-closed JailUnavailableError (after dropping the half-registered session) so it reaches that boundary; never an unjailed fallback.
/**
 * The supervised Terminal Worker entry (spec §2.1/§2.2/§2.3).
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

import { spawn as childSpawn } from "node:child_process";
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
  type EgressControlPort,
  type EgressMaterialization,
} from "@comis/core";
import { isFsyncDisabledByPermissionModel } from "@comis/shared";

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
import {
  buildReadResult,
  createSessionEmulator,
  diffSnapshot,
  readSnapshotParams,
  type EmulatorSnapshot,
  type ReadResult,
  type SessionEmulator,
} from "./terminal-render.js";
import {
  runSettle,
  SETTLE_DEFAULT_IDLE_MS,
  type SettleDeps,
  type SettleParams,
  type SettleResult,
} from "./terminal-settle.js";

/**
 * The per-session emulator scrollback depth (retained rows above the viewport).
 * A sane default here; later made config/param-driven. Bounds per-session
 * emulator memory to `(rows + 1000) × cols` cells.
 */
const SCROLLBACK_DEFAULT = 1000;

// ---------------------------------------------------------------------------
// Injected dependency contracts
// ---------------------------------------------------------------------------

/** Structural logger — the minimal `{info,debug,warn,error}` surface; NOT `@comis/infra`'s `getLogger` (the worker never value-imports infra); the daemon injects the real logger. */
export interface WorkerLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Structural node-pty session handle (subset of `IPty`): `onData`→ring, `onExit`→markExited (payload ignored — only the exit signal matters), write/resize/kill forwarded. */
export interface FakePtyLike {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Structural node-pty module shape (only `spawn` is used). */
export interface PtyModuleLike {
  spawn(
    bin: string,
    argv: string[],
    opts: { cols: number; rows: number; env: NodeJS.ProcessEnv },
  ): FakePtyLike;
}

/** Pipe-backend spawn shape — a structural subset of `child_process.spawn`'s return; `stdout.on("data")`→ring, close/error flip `alive`. */
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
  /** Load node-pty. Default: a guarded `createRequire` load in a try — NEVER a top-level static import (crashes module load on a no-prebuild host); a throw → the pipe backend. */
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
  /** Schedule a one-shot timer. Default: wraps `systemSetTimeout` (no raw `setTimeout` global) + `.unref()`s the handle so a pending settle timer never holds the loop open. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel a `setTimer` handle (default: `systemClearTimeout`). */
  clearTimer?: (handle: unknown) => void;
  /** Construct a per-session @xterm emulator. Default: `createSessionEmulator`. Injectable so a test can assert the wiring (mirrors loadPty/spawnPipe). */
  createEmulator?: (opts: { cols: number; rows: number; scrollback: number }) => SessionEmulator;
  // -- scope-jail composition (injected; heavy logic is terminal-spawn-plan.ts) --
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
// Frame result shapes
// ---------------------------------------------------------------------------

/** Which backend a session is driven by — `degraded` is the pipe fallback. */
export type WorkerBackend = "pty" | "degraded";

/** The create-frame reply payload. */
interface CreateResult {
  sessionId: string;
  backend: WorkerBackend;
  cols: number;
  rows: number;
}

/** Post-action snapshot a mutating handler (send_text/send_key) returns: the SETTLED `{screen,cursor}` subset; `cursor` stays `{0,0}` until the real cursor lands. */
interface SendResult {
  screen: string;
  cursor: { x: number; y: number };
}

/** The `resize` reply payload (spec §5: `{ ok }`). */
interface ResizeResult {
  ok: boolean;
}

/**
 * The `wait` reply payload (spec §5): the settle outcome plus the
 * post-settle `{screen,cursor}`. `isComplete` is the LOAD-BEARING signal — it
 * flows through from {@link runSettle} VERBATIM (never coerced) so a timeout's
 * `false` survives (the turn ends; the attention model RESUMES it, never
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
  /** The accumulated stdout ring (initially a growing string; a true ring comes later). */
  ring: string;
  alive: boolean;
  pty?: FakePtyLike;
  pipe?: PipeChildLike;
  /** Per-session @xterm emulator — SOURCE OF TRUTH for `read` (grid+cursor+alt). Closure-local; fed by {@link appendRing}, serialized by `handleRead`, resized by `handleResize`. */
  emu?: SessionEmulator;
  /** Latest emulator write-parse promise: `appendRing` chains each `emu.write(chunk)` (serialized, @xterm-PARSE-backed); `handleRead` awaits it so a settled frame reflects every byte (§2.4). */
  writeFlush?: Promise<void>;
  /** Previous read's emulator snapshot: `handleRead` diffs the new one against this (per-session screen-diff) then stores it. */
  lastSnapshot?: EmulatorSnapshot;
  /** Settle ring-grow subscribers ({@link SettleDeps}.onRingChange), closure-local; `appendRing` notifies these. */
  ringListeners: Set<() => void>;
  /** Settle exit subscribers (onExit half); the pipe close/error + live pty exit notify these. */
  exitListeners: Set<() => void>;
  /** Operator-declared sandbox scope off the create frame — materialized into the bwrap jail by the scope-jail composer. */
  scope?: TerminalScope;
  /** Session workspace root (create frame) — the always-bound jail workspace. */
  workspace?: string;
  /** Session working directory (create frame) — the jail `--chdir` target. */
  cwd?: string;
  /**
   * The egress materialization for `network: listed-hosts`. Disposed
   * ONCE on session teardown ({@link markExited}) so the per-session socket is
   * cleaned up (no leak). Absent for `none`/`full`.
   */
  egress?: EgressMaterialization;
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
 * The production node-pty loader: a guarded `createRequire` load inside a try —
 * NEVER a top-level static import (that crashes module load when the native addon
 * has no prebuild). A throw is caught by the worker → the pipe backend, `degraded`.
 * ESM (`"type":"module"`), so `createRequire(import.meta.url)` is the lazy
 * load path; the literal module name appears only here, never a top-level binding.
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
// Bracketed-paste delimiters (spec §5 send_text bracketedPaste)
// ---------------------------------------------------------------------------

/** DECSET 2004 bracketed-paste START. `bracketedPaste:true` wraps text in START…END so a paste-aware program treats the bytes as DATA, not typed commands. */
const BRACKETED_PASTE_START = "\x1b[200~";
/** DECSET 2004 bracketed-paste END. */
const BRACKETED_PASTE_END = "\x1b[201~";

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
  // The scope-jail composers, threaded into planSpawnFromCreateFrame at the
  // spawn seam. bwrapPath/egressControl have NO default — the daemon injects them.
  const spawnComposers: SpawnPlanComposers = {
    buildScopeArgs: deps.buildScopeArgs ?? defaultBuildScopeArgs,
    scrubChildEnv: deps.scrubChildEnv ?? defaultScrubChildEnv,
    buildEgressRelayLaunch: deps.buildEgressRelayLaunch ?? defaultBuildEgressRelayLaunch,
    egressControl: deps.egressControl,
    bwrapPath: deps.bwrapPath,
  };

  /**
   * Append a chunk to the session ring (RAW settle feed + degraded view) AND feed it
   * into the @xterm emulator (the rendered-`read` source of truth), then notify the
   * settle's ring-change subscribers. The emu write chains onto
   * {@link SessionState.writeFlush} (serialized, @xterm-PARSE-backed) so `handleRead`
   * awaits it before serializing a settled frame.
   */
  function appendRing(state: SessionState, chunk: string): void {
    state.ring += chunk;
    state.writeFlush = (state.writeFlush ?? Promise.resolve()).then(() => state.emu?.write(chunk));
    for (const cb of state.ringListeners) cb();
  }

  /**
   * Flip a session to not-alive + notify the settle's exit subscribers (onExit half)
   * so a pending `wait`/settle resolves `exit`. ALSO disposes the `listed-hosts`
   * egress materialization ONCE (socket cleanup) — nulling the handle first
   * so a second exit signal (close AND error) cannot double-dispose.
   */
  function markExited(state: SessionState): void {
    state.alive = false;
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
   * Build the {@link SettleDeps} over a session (injected timer ports + ring/liveness
   * getters + closure-local listener sets) and run the bounded settle — the
   * heart of every act-then-return-SETTLED handler + the explicit `wait`. `params`
   * passes through to {@link runSettle}.
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
      // Content below the viewport is NOT settleable — the idle path RE-ARMS
      // (more below ⇒ keep waiting). The gate only SUPPRESSES an idle-settle, never
      // forces one (exit/text/timeout unaffected).
      isSettleable: () => !(state.emu?.hasContentBelowFold() ?? false),
    };
    return runSettle(settleDeps, params);
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

    const state: SessionState = {
      backend: "pty",
      cols,
      rows,
      ring: "",
      alive: true,
      ringListeners: new Set(),
      exitListeners: new Set(),
      scope,
      workspace,
      cwd,
    };

    // Construct the per-session @xterm emulator BEFORE wiring the backend's onData
    // (so the first chunk is rendered). Built for BOTH backends; the
    // scrollback is threaded from the create frame (DEFAULT_SCROLLBACK / config, never agent input).
    state.emu = createEmulator({ cols, rows, scrollback });

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

    let pty: PtyModuleLike | undefined;
    try {
      pty = deps.loadPty();
    } catch (err) {
      // node-pty unavailable → the pipe backend, reported as degraded.
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
      // Wire child exit -> markExited (the pty analog of the pipe close/error below;
      // payload ignored). WITHOUT it a real node-pty child that exits never notifies
      // an in-flight wait({forExit:true}) (the VPS real-PTY gate).
      handle.onExit(() => {
        markExited(state);
      });
      state.pty = handle;
    } else {
      // Pipe backend (degraded) — ALSO wrapped in bwrap (no unjailed degraded path).
      const child = spawnPipe(plan.bin, plan.argv, { env: plan.env });
      child.stdout?.on("data", (chunk: Buffer) => appendRing(state, chunk.toString("utf8")));
      child.on("close", () => {
        markExited(state);
      });
      child.on("error", () => {
        markExited(state);
      });
      state.pipe = child;
    }

    // (The session was registered synchronously above so concurrent frames find it.)
    logger.info(
      { sessionId, backend: state.backend, durationMs: nowMs() - startedAt },
      "terminal session created",
    );
    return { sessionId, backend: state.backend, cols, rows };
  }

  /**
   * Handle a `read` frame. AWAITS the pending emulator write-parse
   * ({@link SessionState.writeFlush}, the §2.4 stability flush — resolves on the
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
   * Handle a `send_key` frame: encode the chord via the named-key grammar,
   * write the EXACT bytes ONCE. An unknown key makes `encodeKeyChord`
   * throw `invalid_value` → dispatch's catch returns ok:false with NOTHING written
   * (the write is AFTER the encode — the keystroke-injection guard).
   */
  function handleSendKey(frame: TerminalRequestFrame): SendResult {
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
    return { screen: state.ring, cursor: { x: 0, y: 0 } };
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
    return { screen: state.ring, cursor: { x: 0, y: 0 } };
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
   * Handle a `wait` frame — the explicit parameterized settle. Runs the
   * bounded {@link runSettle} and replies `{matched,isComplete,reason,screen,cursor}`;
   * an absent session is gone (reason `exit`, not-complete). CRITICAL: `isComplete`
   * passes through from runSettle VERBATIM — `false` on timeout (the worker never
   * holds the frame open; the attention model resumes the turn), NEVER hard-coded true.
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
          result = await handleCreate(frame); // awaits the scope-jail composition; fail-closed throw → ok:false
          break;
        case "read":
          result = await handleRead(frame); // awaits the pending emulator write-parse
          break;
        case "send_key":
          result = handleSendKey(frame);
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
