// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-types -- the neutral LEAF type-module for the worker's shared
 * structural contracts.
 *
 * Extracted from `terminal-worker-entry.ts` (124-01) to break the source-level import
 * cycle the backend-attach extraction introduced: the entry value-imports `attachBackend`
 * FROM `terminal-worker-backend-attach.ts`, while backend-attach needed
 * `PipeChildLike`/`PtyModuleLike`/`SessionState`/`WorkerLogger` back FROM the entry — a
 * 2-member cycle (the no-cycles architecture gate counts type-only edges). Hoisting the
 * shared types into this leaf lets BOTH the entry and backend-attach import them from here,
 * leaving a single forward edge (entry → backend-attach).
 *
 * LEAF + INFRA-FREE: this is a pure type-declaration module. It value-imports NOTHING and
 * type-imports ONLY from sibling LEAVES (`terminal-render.ts`, `allowlist-matcher.ts`) +
 * the `EgressMaterialization` TYPE from `@comis/core` — never the entry/backend-attach
 * (which would re-introduce a cycle), never @comis/infra or @comis/observability (worker ↛
 * infra; Shared Pattern A).
 *
 * The entry RE-EXPORTS these types (`export type { … } from "./terminal-worker-types.js"`)
 * so every existing `from "./terminal-worker-entry.js"` importer (the worker tests, the
 * render-live harness) keeps working with zero call-site churn — a type re-export is
 * compile-time-only, not a runtime dual code path.
 *
 * @module
 */

import type { EgressMaterialization } from "@comis/core";

import type { EmulatorSnapshot, SessionEmulator } from "./terminal-render.js";
import type { TerminalScope } from "./allowlist-matcher.js";
import type { AttentionEmitter } from "./terminal-attention-emitter.js";

/** Structural logger — the minimal `{info,debug,warn,error}` surface; NOT `@comis/infra`'s `getLogger` (the worker never value-imports infra); the daemon injects the real logger. */
export interface WorkerLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The durable-fs ops the worker uses — injected so the fsync-thrower test runs on macOS. Moved to this neutral leaf (165-REVIEW) so the worker-defaults sibling can type the default fs port without an import cycle back through the entry. */
export interface WorkerFsPort {
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  openSync(path: string, flags: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
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

/**
 * Which backend a session is driven by:
 *   - `pty`      — node-pty (the default, full TUI);
 *   - `tmux`     — the named-session backend required for milestone-length runs
 *                  (OPS-05): the tmux server outlives the worker so a restart
 *                  RE-ATTACHES by the deterministic `comis-<id>` name (124-08);
 *   - `degraded` — the pipe fallback (TR-08), when node-pty is unavailable.
 */
export type WorkerBackend = "pty" | "tmux" | "degraded";

/**
 * The tmux-backend LOADER seam — the third option behind the same backend interface as
 * `loadPty` (124-08, OPS-05). The daemon binds the session-agnostic deps (the resolved
 * tmux path, the `has-session` probe, the `runTmux` spawner) and hands the worker this
 * factory; the worker calls it per session with the composed plan command + geometry and
 * gets back a {@link FakePtyLike} handle (onData→ring, onExit→markExited, write/resize/kill
 * over the named session). Structural (not the concrete `createTmuxBackend`) so the worker
 * stays decoupled from the tmux module + the daemon-injected probe/runner.
 */
export interface TmuxBackendLike {
  spawn(args: {
    sessionId: string;
    bin: string;
    argv: readonly string[];
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }): FakePtyLike;
  /**
   * BL-01 (165-REVIEW): RE-ATTACH to an EXISTING tmux session by name on
   * recover-on-boot — the load-bearing fix for the recover zombie. The registry
   * rehydrates a recovered durable session `running`, but the freshly-spawned worker
   * has an EMPTY sessions map; without this it re-attaches a pane ONLY inside
   * `handleCreate`, so a recovered session's first `read`/`status` returns
   * `alive:false` (a zombie). `reattach` is `has-session`-gated to NEVER create: a
   * LIVE session (`hasSession` true) returns the {@link FakePtyLike} pane reader
   * (onData→ring, onExit→markExited) WITHOUT a `new-session`; a GONE session
   * (`hasSession` false) returns `undefined` so the worker replies `ok:false` (the
   * registry then flips `lost` + fires `onUnrecoverable` — honest death, never a
   * fresh CLI / double-drive, I10). Distinct from {@link spawn} (which creates-OR-
   * attaches) so the no-double-create is structural, not conventional.
   */
  reattach(args: {
    sessionId: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
    /** RECUR-03: the surviving session's OWN per-boot `-S` socket (from its descriptor) — re-attach
     *  targets THIS server, not this boot's fresh one. Absent ⇒ the legacy single-socket default. */
    tmuxSocket?: string;
  }): FakePtyLike | undefined;
}

/**
 * A closure-local per-session record (NOT module-global). Exported as a worker-internal
 * structural type so the extracted backend-attach sibling (`attachBackend` in
 * `terminal-worker-backend-attach.ts`) can type the `state` it feeds; it is NOT a
 * public-surface contract (not re-exported by the barrel) — purely intra-module.
 */
// @optional-field-count: 13 optional fields — SessionState is the worker's per-session
// record: EVERY optional is a genuinely-conditional per-session datum that is present
// only on a specific path (pty XOR pipe handle; emu/writeFlush/lastSnapshot once the
// emulator is built; emitter/lastClassifiedSnapshot/lastProgressMs once attention is
// wired; scope/workspace/cwd/egress from the create frame; exitCode only after a pty
// exit). Promoting any to required would falsely claim a datum exists before its path
// runs. This is the "(a) genuinely conditional" classification, not a cluster-split.
export interface SessionState {
  backend: WorkerBackend;
  cols: number;
  rows: number;
  /** The accumulated stdout ring (P0: a growing string; a true ring is P2/121). */
  ring: string;
  alive: boolean;
  pty?: FakePtyLike;
  pipe?: PipeChildLike;
  /** Per-session @xterm emulator (P2/121) — SOURCE OF TRUTH for `read` (grid+cursor+alt). Closure-local; fed by `appendRing`, serialized by `handleRead`, resized by `handleResize`. */
  emu?: SessionEmulator;
  /** Latest emulator write-parse promise (P2/121): `appendRing` chains each `emu.write(chunk)` (serialized, @xterm-PARSE-backed); `handleRead` awaits it so a settled frame reflects every byte (§2.4). */
  writeFlush?: Promise<void>;
  /** Previous read's emulator snapshot (TR-14): `handleRead` diffs the new one against this (per-session screen-diff) then stores it. */
  lastSnapshot?: EmulatorSnapshot;
  /** The per-session attention emitter (124-05): the worker hands each settled frame's `Classification` to `emitter.observe`, which writes a fd3 `TerminalEventFrame` on a state TRANSITION only (TR-11, no poll). Absent when the worker was built with no `writeFd3` (the emit is best-effort). */
  emitter?: AttentionEmitter;
  /** The exit-wake observe hook (124-05 gap-close): bound by `handleCreate` alongside {@link emitter}; `markExited` fires it so a child that exits with NO settle pending STILL pushes its `terminal:session_state(exited)` transition on fd3 (TR-11 holds for completion, not just prompts — without this an event-driven agent is never woken on exit and must poll). Fire-and-forget + never throws; the edge-triggered emitter dedups it against a concurrent settle-path observe. Absent when no emitter is wired. */
  observeExit?: () => void;
  /** Previously-CLASSIFIED emulator snapshot (124-05): the attention diff anchor, kept SEPARATE from {@link lastSnapshot} (read's diff) so the two never fight over one field. */
  lastClassifiedSnapshot?: EmulatorSnapshot;
  /** Epoch ms of the last observed PROGRESS (classified screen changed) — the OPS-04 stuck-by-progress signal; `noProgressMs = nowMs - lastProgressMs`. Stamped by the classify glue against the worker's injected clock. */
  lastProgressMs?: number;
  /** Per-session interaction count (124-06): incremented at the single `logInteraction` chokepoint (every send_text / send_key / wait / resize). Surfaced by the `status` frame as the spec §5 `interactions` perception. */
  interactions: number;
  /** The PTY exit code when the backend reported one (124-06): captured on the pty `onExit` payload; surfaced by the `status` frame as the spec §5 `exitCode`. Absent on the pipe close/error path (no code) and while alive. */
  exitCode?: number;
  /** Settle ring-grow subscribers (`SettleDeps.onRingChange`), closure-local; `appendRing` notifies these. */
  ringListeners: Set<() => void>;
  /** Settle exit subscribers (onExit half); the pipe close/error + live pty exit notify these. */
  exitListeners: Set<() => void>;
  /** Operator-declared sandbox scope (SEC-02) off the create frame — materialized into the bwrap jail by the 122-06 composer. */
  scope?: TerminalScope;
  /** Session workspace root (create frame) — the always-bound jail workspace. */
  workspace?: string;
  /** Session working directory (create frame) — the jail `--chdir` target. */
  cwd?: string;
  /**
   * The egress materialization for `network: listed-hosts` (122-05/06). Disposed
   * ONCE on session teardown (`markExited`) so the per-session socket is
   * cleaned up (no leak). Absent for `none`/`full`.
   */
  egress?: EgressMaterialization;
}

// ---------------------------------------------------------------------------
// Frame result shapes — the worker's per-method reply payloads. Pure types; moved
// here from terminal-worker-entry.ts (124-08) so that file keeps headroom under the
// 800-line architecture cap once the tmux backend seam plumbing lands. Intra-module
// (the entry's handlers return them); NOT re-exported by the barrel.
// ---------------------------------------------------------------------------

/** The create-frame reply payload. */
export interface CreateResult {
  sessionId: string;
  backend: WorkerBackend;
  cols: number;
  rows: number;
}

/** Post-action snapshot a mutating handler (send_text/send_key) returns (TR-03): the SETTLED `{screen,cursor}` subset; `cursor` stays `{0,0}` until the real cursor lands (P2/121). */
export interface SendResult {
  screen: string;
  cursor: { x: number; y: number };
}

/** The `resize` reply payload (spec §5: `{ ok }`). */
export interface ResizeResult {
  ok: boolean;
}

/**
 * The `wait` reply payload (spec §5 / TR-05). The canonical shape + its defensive
 * worker→daemon mapping live in terminal-wait-reply so the worker and the daemon share
 * ONE type; re-exported here for the worker's reply-builder. `isComplete` is LOAD-BEARING
 * — it flows from `runSettle` VERBATIM (a timeout's `false` survives; the P5 attention
 * model RESUMES the turn, never finalizes a live session). T1.1 adds `producing` + `hint`.
 */
export type { WaitResult } from "./terminal-wait-reply.js";
