// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-tmux-backend -- the THIRD worker backend (node-pty | pipe | tmux),
 * required for milestone-length runs (OPS-05, spec §4.6 "Recovery").
 *
 * A worker crash loses an in-process (node-pty / pipe) PTY. The tmux backend owns the
 * PTY inside a DETERMINISTICALLY-named tmux session (`comis-<sessionId>`) so the tmux
 * SERVER outlives the worker/daemon: a restart RE-ATTACHES (`tmux has-session` → read
 * the existing pane) rather than re-creating, and a human can `tmux attach -t
 * comis-<id>` to take over. The deterministic name + has-session-then-attach is the
 * load-bearing survival mechanism (RESEARCH Pitfall 6 — a random/UUID name is
 * un-recoverable and leaks an un-reapable session; T-124-23).
 *
 * It joins the SAME worker backend seam as node-pty | pipe: {@link createTmuxBackend}
 * returns a {@link FakePtyLike}-shaped handle (onData→ring, onExit→markExited,
 * write/resize/kill forwarded), so {@link attachBackend} selects it behind one
 * interface with NO worker-entry branching beyond the seam.
 *
 * JAIL NESTING (T-124-24 — no unjailed path). The driven child STILL runs inside the
 * bwrap jail: `attachBackend` hands this backend the already-composed plan command
 * (`{bin,argv}` = `bwrap [scope] -- <child> …`, built by `terminal-spawn-plan.ts`), and
 * the backend runs `tmux new-session -d -s comis-<id> -- bwrap [scope] -- <child>`. tmux
 * is the OUTERMOST process by DESIGN (not bwrap): the survival premise is that the tmux
 * SERVER outlives the worker, so bwrap CANNOT be the outer wrapper (killing the worker's
 * bwrap would kill the server and defeat re-attach). The child is never unjailed — bwrap
 * wraps it INSIDE the tmux session — which satisfies the threat-model intent (the child
 * runs under `bwrap [scope] --`) while preserving server survival.
 *
 * Architecture invariants (binding — AGENTS.md / 124 house style, mirrors
 * `terminal-worker-launch.ts` / `terminal-loop-guard.ts`):
 *   - NO module-global mutable state: the per-session read child + closure state live
 *     inside the factory — two `createTmuxBackend` instances never share state.
 *   - PURE command builders: `tmuxSessionName` + the `buildTmux*Argv` set are free
 *     functions of their inputs (deterministic ⇒ the macOS unit tests pin the survival
 *     logic; the live server is the Linux-gated sibling). No clock, no timer, no env read.
 *   - Infra-free: value-imports ONLY `node:child_process` (the production `runTmux`
 *     default) — never `@comis/infra` / `@comis/observability` (SEC-07; the
 *     infra-runtime-scope architecture gate NAMES this file). The tmux command runner
 *     is INJECTED so the logic is provable on macOS without a live tmux server.
 *
 * @module
 */

import { spawn as childSpawn } from "node:child_process";

import type { FakePtyLike } from "./terminal-worker-types.js";

/**
 * Derive the DETERMINISTIC tmux session name from a worker sessionId. Stable +
 * recoverable: the same sessionId always maps to `comis-<sessionId>`, so a
 * worker/daemon restart re-attaches by name rather than re-creating under a fresh
 * (un-recoverable) name. This is the OPS-05 survival key (RESEARCH Pitfall 6).
 */
export function tmuxSessionName(sessionId: string): string {
  return `comis-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Pure command builders (the spawn-posture analog — buildProductionSpawnWorker)
// ---------------------------------------------------------------------------

/**
 * The `tmux -S <socket> …` prefix shared by EVERY command builder. DUR-01 survival: the
 * socket MUST be an explicit, STABLE path under the data dir — NOT tmux's default
 * `$TMUX_TMPDIR|/tmp/tmux-<uid>/default`. systemd `PrivateTmp=yes` gives each daemon
 * START a FRESH private /tmp, so a /tmp socket is UNREACHABLE from the restarted daemon
 * and re-attach fails even when `KillMode=process` keeps the tmux SERVER process alive
 * (proven live on the VPS 2026-06-16: server pid survived, new daemon's /tmp was empty).
 * `-S` must LEAD so the server (`new-session`) binds it AND every later client
 * (`has-session`/`capture`/`send-keys`/`kill`/`resize`) connects to the SAME socket.
 * Optional only for the standalone pure-builder unit tests; the production
 * {@link TmuxBackendDeps.socketPath} always supplies it.
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
 * Build `tmux send-keys -t <name> -l <bytes>` — the keystroke path. `-l` (literal)
 * sends the worker's ALREADY-ENCODED bytes verbatim instead of re-parsing them as tmux
 * key NAMES (the worker's key grammar already produced the exact control bytes; a second
 * tmux-side key-name expansion would corrupt them — the keystroke-injection guard).
 */
export function buildTmuxSendKeysArgv(opts: { tmuxPath: string; socketPath?: string; name: string; bytes: string }): string[] {
  return [...tmuxSocketHead(opts.tmuxPath, opts.socketPath), "send-keys", "-t", opts.name, "-l", opts.bytes];
}

/**
 * Build `tmux capture-pane -p -t <name>` — read the named session's pane to stdout
 * (`-p`). The backend spawns this (and re-spawns to follow) to feed onData; on a
 * re-attach it is the SOLE read path (the session already exists, only its output is read).
 */
export function buildTmuxCaptureArgv(opts: { tmuxPath: string; socketPath?: string; name: string }): string[] {
  return [...tmuxSocketHead(opts.tmuxPath, opts.socketPath), "capture-pane", "-p", "-t", opts.name];
}

/** Build `tmux resize-window -t <name> -x <cols> -y <rows>` — TR-03 reflow on the tmux backend. */
export function buildTmuxResizeArgv(opts: {
  tmuxPath: string;
  socketPath?: string;
  name: string;
  cols: number;
  rows: number;
}): string[] {
  return [
    ...tmuxSocketHead(opts.tmuxPath, opts.socketPath),
    "resize-window",
    "-t",
    opts.name,
    "-x",
    String(opts.cols),
    "-y",
    String(opts.rows),
  ];
}

// ---------------------------------------------------------------------------
// The injected tmux command runner + the backend factory
// ---------------------------------------------------------------------------

/**
 * A structural subset of `child_process.spawn`'s return — the shape a spawned tmux
 * command exposes to this backend: `stdout.on("data")`→ring, close→exit, `stdin.write`
 * for the (rare) interactive command. INJECTED so the survival logic is provable on
 * macOS without a live tmux server (the test passes a capturing fake).
 */
export interface TmuxChild {
  pid?: number;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  stdin: { write(data: string): void } | null;
  on(event: "close" | "error", cb: (arg?: unknown) => void): void;
  kill(signal?: string): void;
}

/** The tmux backend's injected dependencies — all substitutable for the macOS unit tests. */
export interface TmuxBackendDeps {
  /** The worker sessionId — the DETERMINISTIC `comis-<id>` name derives from it (survival key). */
  sessionId: string;
  /** The driven binary (the worker's composed plan command — rides after `tmux … --`). */
  bin: string;
  /** The driven binary's argv (composed plan args). */
  argv: readonly string[];
  /** Terminal columns for the detached session (and resize). */
  cols: number;
  /** Terminal rows for the detached session (and resize). */
  rows: number;
  /** The child environment for the spawned tmux command (the worker's scrubbed env). */
  env: NodeJS.ProcessEnv;
  /** Absolute tmux path (operator/daemon-resolved — like the resolved bwrapPath). */
  tmuxPath: string;
  /**
   * The explicit `-S` socket path — a STABLE file under the data dir (e.g.
   * `<dataDir>/terminal-worker/tmux.sock`), NOT tmux's default /tmp socket. DUR-01
   * survival key: systemd `PrivateTmp=yes` privatizes /tmp per daemon start, so the
   * default socket is unreachable after a restart; the data-dir socket is reachable by
   * both daemon generations so the restarted daemon re-attaches. See {@link tmuxSocketHead}.
   */
  socketPath: string;
  /**
   * Probe whether the named session already exists (the re-attach decision). Production
   * runs {@link buildTmuxHasSessionArgv} synchronously and maps exit 0 → true; the test
   * injects a fake. TRUE ⇒ re-attach (read the existing pane); FALSE ⇒ create then read.
   */
  hasSession: (name: string) => boolean;
  /**
   * Run a tmux command argv, returning a {@link TmuxChild}. Production wraps
   * `child_process.spawn`; the test injects a capturing fake. The backend uses it for the
   * create/capture (long-lived read) child and for the one-shot send-keys/kill/resize.
   */
  runTmux: (argv: string[]) => TmuxChild;
  /**
   * BL-01 (165-REVIEW): re-attach ONLY — NEVER create. When `true` and `hasSession` is
   * false, {@link createTmuxBackend} returns `undefined` (the session is genuinely gone;
   * the worker's `reattach` handler replies `ok:false` → the registry flips `lost`). This
   * is the recover-on-boot path: a fresh `new-session` would spawn a SECOND CLI against a
   * session whose liveness we could not confirm — a double-drive (I10). Absent/false ⇒
   * today's create-or-attach behavior (the create path is unchanged, byte-identical).
   */
  forceAttachOnly?: boolean;
}

/**
 * Create a tmux backend handle for a session. On construction it makes the OPS-05
 * survival decision ONCE: `hasSession(comis-<id>)` ? RE-ATTACH (the session survived a
 * restart — read its existing pane) : CREATE (`new-session -d`, then read). It then
 * wires the read child's pane output to `onData` and its close to `onExit`, and exposes
 * `write` (send-keys -l), `resize` (resize-window), and `kill` (kill-session) over the
 * named session — exactly the {@link FakePtyLike} seam node-pty | pipe satisfy.
 *
 * NEVER an unconditional `new-session`: re-creating an existing session would discard
 * the surviving session's state (the whole point of tmux survival).
 *
 * BL-01 (165-REVIEW): with `forceAttachOnly:true` (the recover-on-boot re-attach path)
 * a GONE session (`hasSession` false) returns `undefined` instead of creating — the
 * caller (the worker's `reattach` handler) then replies `ok:false`, NEVER a fresh CLI.
 */
export function createTmuxBackend(deps: TmuxBackendDeps): FakePtyLike | undefined {
  const { sessionId, bin, argv, cols, rows, tmuxPath, socketPath, hasSession, runTmux, forceAttachOnly } = deps;
  const name = tmuxSessionName(sessionId);

  // The OPS-05 decision (RESEARCH Pitfall 6), made ONCE at construction.
  const exists = hasSession(name);
  if (!exists) {
    // BL-01: attach-only (recover-on-boot) + the session is gone → re-attach is
    // impossible. Return undefined so the worker replies ok:false (the registry flips
    // lost + fires onUnrecoverable) — NEVER a fresh new-session (a double-drive, I10).
    if (forceAttachOnly === true) return undefined;
    // Fresh session: create it DETACHED (the tmux server takes ownership of the PTY so
    // it outlives this worker). One-shot — its own lifetime is the create command, not
    // the session; the long-lived read child below follows the pane.
    runTmux(buildTmuxSpawnArgv({ tmuxPath, socketPath, name, bin, binArgv: argv, cols, rows }));
  }
  // Whether created-now or surviving-from-before, READ the named session's pane. This is
  // the SOLE read path on the re-attach branch (the session already exists; we only
  // resume reading it) and the post-create read path on the fresh branch. Its stdout is
  // the ring feed (onData) and its close is the session-gone signal (onExit).
  const reader = runTmux(buildTmuxCaptureArgv({ tmuxPath, socketPath, name }));

  return {
    pid: reader.pid ?? 0,
    onData(cb: (data: string) => void): void {
      // The captured pane bytes feed the worker ring (decoded utf8, like the pipe backend).
      reader.stdout?.on("data", (chunk: Buffer) => cb(chunk.toString("utf8")));
    },
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
      // The read child closing is the per-session gone signal — markExited. tmux gives no
      // exit code on a capture close, so report 0 (the worker only needs the exit SIGNAL
      // to resolve an in-flight wait({forExit:true}); the code is best-effort).
      reader.on("close", (code?: unknown) => cb({ exitCode: typeof code === "number" ? code : 0 }));
    },
    write(data: string): void {
      // Send the worker's already-encoded bytes to the named session LITERALLY (-l) — the
      // worker's key grammar produced the exact control bytes; tmux must not re-parse them.
      const child = runTmux(buildTmuxSendKeysArgv({ tmuxPath, socketPath, name, bytes: data }));
      child.kill(); // one-shot send; do not leak the send-keys child
    },
    resize(nextCols: number, nextRows: number): void {
      const child = runTmux(buildTmuxResizeArgv({ tmuxPath, socketPath, name, cols: nextCols, rows: nextRows }));
      child.kill(); // one-shot resize
    },
    kill(): void {
      // Deterministic evict by name (the reaper path) — kill the SERVER-side session, then
      // drop the local read child.
      const child = runTmux(buildTmuxKillArgv({ tmuxPath, socketPath, name }));
      child.kill(); // one-shot kill-session command
      reader.kill();
    },
  };
}

/**
 * The production tmux command runner: `child_process.spawn` with stdio pipes (mirrors
 * the pipe backend's `defaultSpawnPipe`). Exported so the daemon (when wiring the tmux
 * backend) can build the injected {@link TmuxBackendDeps.runTmux}; tests inject a fake.
 *
 * IN-02: the first argv element is always `tmuxPath` (every `buildTmux*Argv` puts it
 * first), but the previous bare `bin!` non-null assertion left that invariant implicit —
 * an empty argv (a future caller bug) would call `childSpawn(undefined, …)` and surface
 * the opaque node `The "file" argument must be of type string` error. Guard it explicitly
 * so a programming error fails with an actionable message naming the function.
 * @allow-throw: programming-error boundary guard — an empty argv is a caller bug, not a
 * recoverable runtime condition; this throw is the actionable analogue of the implicit
 * `bin!` assertion it replaces, raised at the same synchronous spawn boundary.
 */
export function defaultRunTmux(argv: string[], env: NodeJS.ProcessEnv): TmuxChild {
  const [bin, ...rest] = argv;
  if (bin === undefined) {
    throw new Error("defaultRunTmux: empty argv (expected tmuxPath as the first element)");
  }
  return childSpawn(bin, rest, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as TmuxChild;
}
