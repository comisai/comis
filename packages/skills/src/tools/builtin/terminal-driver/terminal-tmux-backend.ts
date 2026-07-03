// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-tmux-backend -- the THIRD worker backend (node-pty | pipe | tmux),
 * required for milestone-length runs (recovery across a worker/daemon restart).
 *
 * A worker crash loses an in-process (node-pty / pipe) PTY. The tmux backend owns the
 * driven child inside a DETERMINISTICALLY-named tmux session (`comis-<sessionId>`) so the
 * tmux SERVER outlives the worker/daemon: a restart RE-ATTACHES (`tmux has-session` →
 * `tmux attach`) rather than re-creating, and a human can `tmux attach -t comis-<id>` to
 * take over. The deterministic name + has-session-then-attach is the load-bearing survival
 * mechanism (a random/UUID name is un-recoverable and leaks an un-reapable session).
 *
 * DRIVABILITY (the read/drive model — corrected 2026-06-16). The backend drives the
 * session by ATTACHING a real **node-pty** running `tmux attach -t comis-<id>`. That pty IS
 * the {@link FakePtyLike}: it STREAMS the pane's raw bytes (onData→ring, feeding the xterm
 * emulator exactly like the pty backend), DRIVES it (write → the pty → tmux → the pane's
 * stdin), resizes via the pty, and fires onExit ONLY when the session genuinely dies (the
 * attach client exits). The PRIOR implementation read via a ONE-SHOT `capture-pane` whose
 * immediate close fired onExit → `markExited` → the session was wrongly flagged dead and
 * every `send_text`/`wait` was dropped (the F-A/F-B drivability bug, proven live: fresh AND
 * re-attached tmux sessions were undriveable). `attach` is the streaming analog of
 * node-pty's direct spawn — the only model that satisfies the worker's stream→emulator read
 * path. The session is configured `status off` (no chrome in reads) + `prefix None` (no
 * Ctrl-b interception of driven keystrokes) so the attach behaves as a transparent pipe.
 *
 * JAIL NESTING (no unjailed path). The driven child STILL runs inside the bwrap
 * jail: `attachBackend` hands this backend the already-composed plan command (`{bin,argv}` =
 * `bwrap [scope] -- <child> …`), and the backend runs `tmux new-session -d -s comis-<id> --
 * bwrap [scope] -- <child>`. tmux is the OUTERMOST process by DESIGN (not bwrap): the
 * survival premise is that the tmux SERVER outlives the worker, so bwrap CANNOT be the outer
 * wrapper. The attach pty is just a viewing/driving client — the driven child stays jailed
 * inside the tmux session.
 *
 * Architecture invariants (binding — AGENTS.md):
 *   - NO module-global mutable state: the per-session attach pty + closure state live inside
 *     the factory — two `createTmuxBackend` instances never share state.
 *   - PURE command builders: `tmuxSessionName` + the `buildTmux*Argv` set are free functions
 *     of their inputs (deterministic ⇒ the macOS unit tests pin the argv/survival logic; the
 *     live attach is the Linux-gated sibling). No clock, no timer, no env read.
 *   - Infra-free + DEPENDENCY-free: value-imports NOTHING (only types). The one-shot tmux
 *     runner AND the attach-pty spawner are INJECTED ({@link TmuxBackendDeps}) so the logic
 *     is provable on macOS without a live tmux server — never `@comis/infra` /
 *     `@comis/observability` (the infra-runtime-scope architecture gate NAMES this file).
 *
 * @module
 */

import type { FakePtyLike } from "./terminal-worker-types.js";

/**
 * Derive the DETERMINISTIC tmux session name from a worker sessionId. Stable +
 * recoverable: the same sessionId always maps to `comis-<sessionId>`, so a
 * worker/daemon restart re-attaches by name rather than re-creating under a fresh
 * (un-recoverable) name. This is the survival key.
 */
export function tmuxSessionName(sessionId: string): string {
  return `comis-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Pure command builders
// ---------------------------------------------------------------------------

/**
 * The `tmux -S <socket> …` prefix shared by EVERY command builder. Survival: the
 * socket MUST be an explicit, STABLE path under the data dir — NOT tmux's default
 * `$TMUX_TMPDIR|/tmp/tmux-<uid>/default`. systemd `PrivateTmp=yes` gives each daemon START
 * a FRESH private /tmp, so a /tmp socket is UNREACHABLE from the restarted daemon and
 * re-attach fails even when `KillMode=process` keeps the tmux SERVER process alive (proven
 * live on the VPS 2026-06-16: server pid survived, new daemon's /tmp was empty). `-S` must
 * LEAD so the server (`new-session`) binds it AND every later client (`has-session`/
 * `attach`/`kill`/`set-option`) connects to the SAME socket. Optional only for the
 * standalone pure-builder unit tests; the production {@link TmuxBackendDeps.socketPath}
 * always supplies it.
 */
function tmuxSocketHead(tmuxPath: string, socketPath: string | undefined): string[] {
  return socketPath === undefined ? [tmuxPath] : [tmuxPath, "-S", socketPath];
}

/**
 * Build `tmux new-session -d -s <name> -x <cols> -y <rows> -- <bin> <binArgv…>`: a
 * DETACHED named session whose command is the driven CLI. Detached (`-d`) so the tmux
 * server owns the PTY and the session outlives the worker (survival). The driven
 * `{bin,binArgv}` ride at the tail VERBATIM (the worker's already-composed plan command).
 */
export function buildTmuxSpawnArgv(opts: {
  tmuxPath: string;
  socketPath?: string;
  name: string;
  bin: string;
  binArgv: readonly string[];
  cols: number;
  rows: number;
}): string[] {
  return [
    ...tmuxSocketHead(opts.tmuxPath, opts.socketPath),
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-x",
    String(opts.cols),
    "-y",
    String(opts.rows),
    "--",
    opts.bin,
    ...opts.binArgv,
  ];
}

/** Build `tmux -S <socket> has-session -t <name>` — the re-attach decision probe (exit 0 ⇒ alive). */
export function buildTmuxHasSessionArgv(opts: { tmuxPath: string; socketPath?: string; name: string }): string[] {
  return [...tmuxSocketHead(opts.tmuxPath, opts.socketPath), "has-session", "-t", opts.name];
}

/** Build `tmux -S <socket> kill-session -t <name>` — the reaper evict path (deterministic, by name). */
export function buildTmuxKillArgv(opts: { tmuxPath: string; socketPath?: string; name: string }): string[] {
  return [...tmuxSocketHead(opts.tmuxPath, opts.socketPath), "kill-session", "-t", opts.name];
}

/**
 * Build `tmux -S <socket> attach -t <name>` — the DRIVING client. node-pty spawns this in a
 * real pty so it STREAMS the pane (onData), forwards keystrokes (write → the pane's stdin),
 * and exits when the session dies (onExit). The streaming analog of node-pty's direct spawn
 * — the load-bearing drivability primitive (a one-shot `capture-pane` can neither stream nor
 * accept input, which is why the prior capture-based read marked sessions dead + dropped drives).
 */
export function buildTmuxAttachArgv(opts: { tmuxPath: string; socketPath?: string; name: string }): string[] {
  return [...tmuxSocketHead(opts.tmuxPath, opts.socketPath), "attach", "-t", opts.name];
}

/**
 * Build `tmux -S <socket> set-option -t <name> <option> <value>` — the per-session driving
 * config. The backend sets `status off` (no tmux status-bar chrome polluting the streamed
 * pane reads) + `prefix None` (no Ctrl-b interception, so the worker's keystrokes pass
 * straight through to the driven child) right after create/before attach.
 */
export function buildTmuxSetOptionArgv(opts: {
  tmuxPath: string;
  socketPath?: string;
  name: string;
  option: string;
  value: string;
}): string[] {
  return [...tmuxSocketHead(opts.tmuxPath, opts.socketPath), "set-option", "-t", opts.name, opts.option, opts.value];
}

// ---------------------------------------------------------------------------
// The injected runners + the backend factory
// ---------------------------------------------------------------------------

/** The tmux backend's injected dependencies — all substitutable for the macOS unit tests. */
export interface TmuxBackendDeps {
  /** The worker sessionId — the DETERMINISTIC `comis-<id>` name derives from it (survival key). */
  sessionId: string;
  /** The driven binary (the worker's composed plan command — rides after `tmux new-session … --`). Empty on the reattach path (the surviving session is attached, never re-spawned). */
  bin: string;
  /** The driven binary's argv (composed plan args). Empty on the reattach path. */
  argv: readonly string[];
  /** Terminal columns for the detached session (and the attach pty). */
  cols: number;
  /** Terminal rows for the detached session (and the attach pty). */
  rows: number;
  /** The child environment (the worker's scrubbed env) — passed to the one-shot tmux commands AND the attach pty. */
  env: NodeJS.ProcessEnv;
  /** Absolute tmux path (operator/daemon-resolved — like the resolved bwrapPath). */
  tmuxPath: string;
  /**
   * The explicit `-S` socket path — a STABLE file under the data dir (e.g.
   * `<dataDir>/terminal-worker/tmux.sock`), NOT tmux's default /tmp socket. Survival
   * key: systemd `PrivateTmp=yes` privatizes /tmp per daemon start, so the default socket is
   * unreachable after a restart; the data-dir socket is reachable by both daemon generations
   * so the restarted daemon re-attaches. See {@link tmuxSocketHead}.
   */
  socketPath: string;
  /**
   * Probe whether the named session already exists (the re-attach decision). Production runs
   * {@link buildTmuxHasSessionArgv} synchronously and maps exit 0 → true; the test injects a
   * fake. TRUE ⇒ attach the existing session; FALSE ⇒ create then attach.
   */
  hasSession: (name: string) => boolean;
  /**
   * Run a one-shot tmux command synchronously (new-session / set-option / kill-session) —
   * production = `execFileSync`, tests inject a recorder. May throw on a non-zero exit; the
   * factory wraps the tolerable ones (set-option / kill) best-effort.
   */
  runOneShot: (argv: string[]) => void;
  /**
   * Spawn the DRIVING attach pty for the named session — a node-pty `tmux attach` wrapped as
   * {@link FakePtyLike} (production = `loadPty().spawn(tmux, attachArgv, {cols,rows,env})`;
   * tests inject a fake pty). It STREAMS the pane (onData), DRIVES it (write), resizes via
   * the pty, and fires onExit ONLY on genuine session death.
   */
  spawnAttachPty: (name: string) => FakePtyLike;
  /**
   * Re-attach ONLY — NEVER create. When `true` and `hasSession` is
   * false, {@link createTmuxBackend} returns `undefined` (the session is genuinely gone; the
   * worker's `reattach` handler replies `ok:false` → the registry flips `lost`). This is the
   * recover-on-boot path: a fresh `new-session` would spawn a SECOND CLI against a session
   * whose liveness we could not confirm — a double-drive. Absent/false ⇒ create-or-attach.
   */
  forceAttachOnly?: boolean;
}

/**
 * Create a tmux backend handle for a session. On construction it makes the survival
 * decision ONCE: `hasSession(comis-<id>)` ? ATTACH (the session survived a restart) : CREATE
 * (`new-session -d`) then ATTACH. It configures the session for transparent driving
 * (`status off` + `prefix None`), then spawns the node-pty `tmux attach` that IS the
 * {@link FakePtyLike} — onData (stream), write (drive), resize, onExit (session-death) all
 * the pty's; `kill` additionally `kill-session`s the server-side session.
 *
 * NEVER an unconditional `new-session`: re-creating an existing session would discard the
 * surviving session's state (the whole point of tmux survival).
 *
 * With `forceAttachOnly:true` (the recover-on-boot re-attach path) a
 * GONE session (`hasSession` false) returns `undefined` instead of creating — the caller
 * (the worker's `reattach` handler) then replies `ok:false`, NEVER a fresh CLI.
 */
export function createTmuxBackend(deps: TmuxBackendDeps): FakePtyLike | undefined {
  const { sessionId, bin, argv, cols, rows, tmuxPath, socketPath, hasSession, runOneShot, spawnAttachPty, forceAttachOnly } =
    deps;
  const name = tmuxSessionName(sessionId);

  // The survival decision, made ONCE at construction.
  const exists = hasSession(name);
  if (!exists) {
    // Attach-only (recover-on-boot) + the session is gone → re-attach is impossible.
    // Return undefined so the worker replies ok:false (the registry flips lost) — NEVER a
    // fresh new-session (a double-drive).
    if (forceAttachOnly === true) return undefined;
    // Fresh session: create it DETACHED (the tmux server owns the PTY so it outlives this worker).
    runOneShot(buildTmuxSpawnArgv({ tmuxPath, socketPath, name, bin, binArgv: argv, cols, rows }));
  }

  // Configure the session for TRANSPARENT pty-driving (idempotent ⇒ safe on re-attach too):
  //   - status off : no tmux status-bar chrome in the streamed pane reads.
  //   - prefix None: no Ctrl-b interception — the worker's keystrokes pass straight through
  //     to the driven child (claude/bash), exactly like the pty backend.
  // Best-effort: a set-option failure must never abort driving.
  for (const [option, value] of [
    ["status", "off"],
    ["prefix", "None"],
    ["prefix2", "None"],
  ] as const) {
    try {
      runOneShot(buildTmuxSetOptionArgv({ tmuxPath, socketPath, name, option, value }));
    } catch {
      /* non-fatal driving-config tweak — drive proceeds without it */
    }
  }

  // ATTACH the driving pty (node-pty `tmux attach`). This IS the FakePtyLike: it STREAMS the
  // pane (onData→ring→emulator), DRIVES it (write), resizes via the pty, and fires onExit
  // ONLY on genuine session death — the streaming analog of the pty backend, NOT a one-shot
  // capture-pane (whose close used to fire onExit immediately → the drivability bug).
  const pty = spawnAttachPty(name);
  return {
    pid: pty.pid,
    onData: (cb: (data: string) => void) => pty.onData(cb),
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => pty.onExit(cb),
    write: (data: string) => pty.write(data),
    resize: (nextCols: number, nextRows: number) => pty.resize(nextCols, nextRows),
    kill: (signal?: string) => {
      // Deterministic evict by name (the reaper path) — kill the SERVER-side session, then
      // drop the local attach pty. Best-effort: the session may already be gone.
      try {
        runOneShot(buildTmuxKillArgv({ tmuxPath, socketPath, name }));
      } catch {
        /* session already gone — still drop the local pty below */
      }
      pty.kill(signal);
    },
  };
}
