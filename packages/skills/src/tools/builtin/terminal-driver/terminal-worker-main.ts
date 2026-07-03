// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the supervised worker PROCESS entry. A fatal wiring error MUST crash this child so the daemon's registry observes the `close` (sessions → lost → respawn) — never a silently half-spawned worker. The per-frame error boundary lives in createTerminalWorker.handle + the stdio pump.
/**
 * terminal-worker-main — the standalone, daemon-supervised Terminal Worker
 * **process** (the crash-isolated child). The daemon forks this
 * under the proven `--permission` posture via `buildProductionSpawnWorker`
 * (terminal-worker-launch.ts). It is the SERVER half of the IPC the registry
 * (client) talks to:
 *
 *   - request frames IN  on stdin  (fd0)  → decoded → `worker.handle`
 *   - reply frames   OUT on stdout (fd1)  ← `fs.writeSync(1, …)`
 *   - terminal:* event frames OUT on fd3  ← `fs.writeSync(3, …)` (no-poll attention)
 *
 * It wires the production-default deps into `createTerminalWorker` (node-pty via
 * the guarded loader + pipe fallback, the @xterm emulator, the scope-jail
 * composers — all module defaults) and supplies the three the factory leaves to
 * the host:
 *   1. a **file logger** — the daemon supervisor reads the worker's stdout + fd3
 *      only (NOT stderr), so writing logs to stderr would fill the un-drained
 *      pipe and wedge the worker; an append log under the `--allow-fs-write`
 *      durable dir is observable without that hazard;
 *   2. the **fd3 writer** (`fs.writeSync(3)`);
 *   3. **worker.stuckMs** from env (`COMIS_TERMINAL_STUCK_MS`).
 *
 * `bwrapPath` + `scope` ride each create frame (threaded by the registry from the
 * daemon-resolved provider), so the worker needs nothing else daemon-injected for
 * the spawn / network:none|full path. (listed-hosts egress + tmux are threaded in
 * a later step.)
 *
 * INFRA-FREE: imports only sibling skills leaves + node builtins.
 *
 * @module
 */

import { writeSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { createStdioPump } from "./terminal-worker-stdio-pump.js";
import { createTerminalEgressProxy } from "./terminal-egress-proxy.js";
import { createTmuxBackend } from "./terminal-tmux-backend.js";
import type { TmuxBackendLike, FakePtyLike, PtyModuleLike } from "./terminal-worker-types.js";

/**
 * The durable-state dir the daemon scopes `--allow-fs-write` to
 * (`<dataDir>/terminal-worker`). `buildProductionSpawnWorker` injects
 * `COMIS_TERMINAL_DATA_DIR=<dataDir>` so this matches the write scope exactly;
 * the home fallback is for a direct (non-daemon) launch.
 */
/**
 * Map a data dir to the worker's durable-state dir `<dataDir>/terminal-worker`. Exported
 * + single-sourced so BOTH the worker ({@link durableDir}) AND the daemon's recover-on-boot
 * liveness probe (`buildIsTmuxAlive`) derive the SAME tmux socket path from a data dir — a
 * drifted literal there would probe the wrong socket and falsely declare durable sessions lost.
 */
export function terminalWorkerDir(dataDir: string): string {
  return pathResolve(dataDir, "terminal-worker");
}

export function durableDir(): string {
  // eslint-disable-next-line no-restricted-syntax -- worker PROCESS entry: the daemon threads the (non-secret) data dir via env when forking; not a SecretManager value.
  const dataDir = process.env.COMIS_TERMINAL_DATA_DIR ?? pathResolve(homedir(), ".comis");
  return terminalWorkerDir(dataDir);
}

/**
 * The explicit tmux `-S` socket path: `<durableDir>/tmux.sock`. The durability survival key —
 * the socket lives on the PERSISTENT, shared data dir, NOT tmux's default
 * `/tmp/tmux-<uid>/default`. systemd `PrivateTmp=yes` gives every daemon START a fresh
 * private /tmp, so a /tmp socket is unreachable from the restarted daemon and re-attach
 * fails even though `KillMode=process` keeps the tmux server process alive (proven live
 * on the VPS 2026-06-16). The data-dir socket is reachable by BOTH daemon generations, so
 * the restarted daemon re-attaches by name. Short path by design (well under the ~108-char
 * AF_UNIX `sun_path` limit). The dir is `mkdir`'d in {@link main} (the `--allow-fs-write`
 * scope), so the socket's parent always exists before the tmux server binds it.
 */
export function resolveTmuxSocketPath(dir: string): string {
  return pathResolve(dir, "tmux.sock");
}

/**
 * A file-backed structural logger (append JSONL). Best-effort: a log write must
 * NEVER throw out of the worker. Writing to stderr is avoided on purpose (the
 * supervisor does not drain fd2 → a full pipe would wedge the worker).
 */
export function createFileLogger(logPath: string) {
  const write = (level: string, obj: Record<string, unknown>, msg?: string): void => {
    try {
      appendFileSync(logPath, `${JSON.stringify({ level, msg: msg ?? "", ...obj, t: Date.now() })}\n`);
    } catch {
      /* logging is best-effort — never crash the worker on a log failure */
    }
  };
  // Optional `msg` so the one logger satisfies BOTH WorkerLogger (createTerminalWorker)
  // AND EgressProxyLogger (createTerminalEgressProxy).
  return {
    debug: (obj: Record<string, unknown>, msg?: string) => write("debug", obj, msg),
    info: (obj: Record<string, unknown>, msg?: string) => write("info", obj, msg),
    warn: (obj: Record<string, unknown>, msg?: string) => write("warn", obj, msg),
    error: (obj: Record<string, unknown>, msg?: string) => write("error", obj, msg),
  };
}

/** Parse the operator stuck threshold (`worker.stuckMs`) the daemon threads via env. */
export function parseStuckMs(): number | undefined {
  // eslint-disable-next-line no-restricted-syntax -- worker PROCESS entry: the daemon threads the (non-secret) stuck-threshold via env; not a SecretManager value.
  const raw = process.env.COMIS_TERMINAL_STUCK_MS;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Resolve the tmux binary; undefined ⇒ a `backend:"tmux"` request falls back to pty/pipe. */
export function resolveTmuxPath(): string | undefined {
  try {
    return execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A minimal structural WARN sink (the file logger satisfies it). */
interface DurableWarnLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * The durable-vs-fallback WARN. tmux availability is a RUNTIME property, NOT
 * a config-validation hard-require: `drive.durable:true` parses fine and
 * DEGRADES gracefully when tmux is absent. When the worker boots on a host with no tmux
 * (`tmuxPath === undefined`), a later `backend:"tmux"` durable drive falls back to pty/pipe —
 * and a daemon restart then ends that session `lost` (with the journal preserved; the
 * user-facing `failed` outcome is derived downstream). Log ONE content-free WARN at boot so
 * an operator sees WHY a durable drive will not survive a restart on this host. Best-effort
 * (never throws out of the worker boot — a logging fault must not crash the process). Logs
 * `errorKind:"precondition"` + `step:"tmux_resolve"` + a `hint` naming the degradation.
 *
 * @param tmuxPath - The resolved tmux binary path, or `undefined` when tmux is unavailable.
 * @param logger - The worker's structural WARN sink.
 */
export function warnIfDurableTmuxUnavailable(tmuxPath: string | undefined, logger: DurableWarnLogger): void {
  if (tmuxPath !== undefined) return; // tmux present — a durable drive is genuinely durable.
  try {
    logger.warn(
      {
        errorKind: "precondition" as const,
        step: "tmux_resolve",
        hint: "durable requested but tmux unavailable; falling back non-durable; a restart then ends the session `lost` with the journal preserved (the user-facing `failed` outcome is derived in Phase 166)",
      },
      "terminal durable drive will degrade — tmux not found",
    );
  } catch {
    /* best-effort — a WARN failure must never crash the worker boot */
  }
}

/**
 * The tmux long-run backend: a named tmux session outlives the worker, so a
 * long-running job survives a worker crash + is re-attachable. `createTmuxBackend` makes the
 * survival decision via `has-session`, runs the one-shot tmux commands (new-session /
 * set-option / kill-session) via `runOneShot` (`execFileSync`), and DRIVES the session via
 * a node-pty `tmux attach` (`spawnAttachPty` = `loadPty().spawn`) — which streams the pane,
 * forwards keystrokes, and exits on session death (the streaming model the worker's ring/
 * emulator needs; NOT the prior one-shot capture-pane that mis-flagged sessions exited).
 * Used for `backend:"tmux"` create AND the recover-on-boot `reattach` (`forceAttachOnly`
 * — attach-or-gone, never a fresh `new-session`). `loadPty` is the SAME node-pty loader the
 * pty backend uses (the attach client is an ordinary pty).
 */
export function buildLoadTmux(tmuxPath: string, loadPty: () => PtyModuleLike): TmuxBackendLike {
  // The STABLE data-dir socket every tmux command targets via `-S` — so the server
  // binds it and a restarted daemon re-attaches to the SAME socket (NOT the PrivateTmp-private
  // /tmp default, which the new daemon generation cannot reach).
  // NEW sessions are created on this daemon generation's PER-BOOT socket
  // (the daemon injects COMIS_TERMINAL_TMUX_SOCKET = `<durableDir>/tmux-<gen>.sock`), so a restart's
  // new sessions get a fresh tmux server in the LIVE mount namespace — a stranded prior-generation
  // ns never breaks new bwrap sessions. A RE-ATTACH instead targets the SURVIVING
  // session's OWN (prior-boot) socket, threaded per-frame from its descriptor (`a.tmuxSocket`). The
  // legacy single socket is the fallback for both (no env / an older descriptor without it).
  const legacySocket = resolveTmuxSocketPath(durableDir());
  // eslint-disable-next-line no-restricted-syntax -- worker PROCESS entry: the daemon threads the (non-secret) per-boot tmux socket via env when forking; not a SecretManager value.
  const bootSocket = process.env.COMIS_TERMINAL_TMUX_SOCKET ?? legacySocket;
  const hasSessionOn =
    (socket: string) =>
    (name: string): boolean => {
      try {
        execFileSync(tmuxPath, ["-S", socket, "has-session", "-t", name], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
  // One-shot tmux command runner (new-session / set-option / kill-session): synchronous,
  // inherits the worker's scrubbed env per call; throws on a non-zero exit (the factory wraps
  // the tolerable ones). Distinct from the ATTACH path, which is a long-lived streaming pty.
  const runOneShot =
    (env: NodeJS.ProcessEnv) =>
    (argv: string[]): void => {
      execFileSync(argv[0]!, argv.slice(1), { env, stdio: "ignore" });
    };
  // The DRIVING attach pty: node-pty `tmux attach -t <name>` — streams the pane (onData),
  // forwards keystrokes (write), resizes via the pty, exits on session death. TERM is forced
  // so the tmux client renders (the worker's scrubbed env may omit it). Bound to the call's socket.
  const spawnAttachPtyOn =
    (socket: string, a: { cols: number; rows: number; env: NodeJS.ProcessEnv }) =>
    (name: string): FakePtyLike =>
      loadPty().spawn(tmuxPath, ["-S", socket, "attach", "-t", name], {
        cols: a.cols,
        rows: a.rows,
        env: { ...a.env, TERM: a.env.TERM ?? "xterm-256color" },
      });
  return {
    spawn: (a) =>
      // The create path never sets forceAttachOnly → createTmuxBackend always returns a
      // handle here; the `?? throwingHandle` would be dead, so we assert non-undefined.
      createTmuxBackend({
        sessionId: a.sessionId,
        bin: a.bin,
        argv: a.argv,
        cols: a.cols,
        rows: a.rows,
        env: a.env,
        tmuxPath,
        socketPath: bootSocket,
        hasSession: hasSessionOn(bootSocket),
        runOneShot: runOneShot(a.env),
        spawnAttachPty: spawnAttachPtyOn(bootSocket, a),
      })!,
    // Recover-on-boot re-attach — attach to an EXISTING session ONLY
    // (forceAttachOnly). The driven command is NOT re-spawned (the surviving pane is attached),
    // so bin/argv are empty; a gone session returns undefined → the worker replies ok:false.
    // Target the SURVIVOR's own per-boot socket (`a.tmuxSocket`), NOT this boot's.
    reattach: (a) => {
      const socket = a.tmuxSocket ?? legacySocket;
      return createTmuxBackend({
        sessionId: a.sessionId,
        bin: "",
        argv: [],
        cols: a.cols,
        rows: a.rows,
        env: a.env,
        tmuxPath,
        socketPath: socket,
        hasSession: hasSessionOn(socket),
        runOneShot: runOneShot(a.env),
        spawnAttachPty: spawnAttachPtyOn(socket, a),
        forceAttachOnly: true,
      });
    },
  };
}

function main(): void {
  const dir = durableDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the daemon scopes --allow-fs-write here; a mkdir failure degrades durable writes, not fatal */
  }
  const logger = createFileLogger(pathResolve(dir, "worker.log"));

  // The no-secret host-allowlist egress proxy for `network: listed-hosts`. The
  // worker runs OUTSIDE the jail (it has host network), so it owns its own proxy:
  // materialize(hosts) stands up a /tmp unix socket the jailed child bind-mounts +
  // relays through (the daemon needn't coordinate — the proxy injects no secret).
  // Untouched for network none/full.
  const egressControl = createTerminalEgressProxy({ logger });

  // Long-run tmux backend — present only if tmux is installed; absent ⇒
  // a backend:"tmux" request degrades to pty/pipe (never an error).
  const tmuxPath = resolveTmuxPath();
  // The attach client is an ordinary pty → reuse the SAME node-pty loader the pty backend uses.
  const loadTmux = tmuxPath ? buildLoadTmux(tmuxPath, defaultLoadPty) : undefined;
  // WARN at boot if tmux is unavailable — a durable drive will degrade to
  // non-durable here, so a restart ends it `lost` (journal preserved; the `failed`
  // outcome is derived downstream).
  warnIfDurableTmuxUnavailable(tmuxPath, logger);

  const worker = createTerminalWorker({
    // The guarded node-pty loader (createRequire in a try → pipe fallback on a
    // no-prebuild host). Required dep; the factory does not auto-default it.
    loadPty: defaultLoadPty,
    logger,
    stuckMs: parseStuckMs(),
    egressControl,
    ...(loadTmux ? { loadTmux } : {}),
    // The fd3 push channel — the worker is forked with fd3 reserved (4-fd stdio).
    writeFd3: (b) => {
      try {
        writeSync(3, b);
      } catch (err) {
        logger.warn({ err: String(err) }, "fd3 attention write failed");
      }
    },
    // loadPty / spawnPipe / emulator / scope+egress composers / clock / fs all
    // default in the factory (defaultLoadPty etc.). bwrapPath + scope ride the frame.
  });

  const pump = createStdioPump({
    handle: (frame) => worker.handle(frame),
    writeReply: (bytes) => {
      writeSync(1, bytes);
    },
    onError: (err, frame) =>
      logger.error(
        { err: String(err), sessionId: frame?.sessionId, requestId: frame?.requestId },
        "worker frame dispatch error",
      ),
  });

  // Request frames arrive on stdin; attaching the listener resumes the stream.
  process.stdin.on("data", (chunk: Buffer) => pump.push(chunk));
  // The daemon closing our stdin (shutdown / respawn) means the parent is gone —
  // exit so we never orphan; the supervisor's `close` listener flips sessions lost.
  const exit = (): void => process.exit(0);
  process.stdin.on("end", exit);
  process.stdin.on("close", exit);

  logger.info({ pid: process.pid, durableDir: dir }, "terminal worker started");
}

/**
 * Run `main()` ONLY when this module is the executed entry script (the production
 * fork: `node terminal-worker-main.js`). Guarding the side effect lets the unit
 * test import the pure helpers (parseStuckMs / durableDir / buildLoadTmux / …)
 * WITHOUT spawning a worker / attaching stdin listeners — the same pattern as
 * egress-relay-init.ts.
 */
function isEntryScript(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  main();
}
