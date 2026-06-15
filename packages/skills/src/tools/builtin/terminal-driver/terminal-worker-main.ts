// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the supervised worker PROCESS entry (spec §1.1/§2.1). A fatal wiring error MUST crash this child so the daemon's registry observes the `close` (sessions → lost → respawn) — never a silently half-spawned worker. The per-frame error boundary lives in createTerminalWorker.handle + the stdio pump.
/**
 * terminal-worker-main — the standalone, daemon-supervised Terminal Worker
 * **process** (spec §1.1/§2.1: the crash-isolated child). The daemon forks this
 * under the proven `--permission` posture via `buildProductionSpawnWorker`
 * (terminal-worker-launch.ts). It is the SERVER half of the §2.3 IPC the registry
 * (client) talks to:
 *
 *   - request frames IN  on stdin  (fd0)  → decoded → `worker.handle`
 *   - reply frames   OUT on stdout (fd1)  ← `fs.writeSync(1, …)`
 *   - terminal:* event frames OUT on fd3  ← `fs.writeSync(3, …)` (no-poll attention, TR-11)
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
import { spawn as childSpawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { createStdioPump } from "./terminal-worker-stdio-pump.js";
import { createTerminalEgressProxy } from "./terminal-egress-proxy.js";
import { createTmuxBackend, type TmuxChild } from "./terminal-tmux-backend.js";
import type { TmuxBackendLike } from "./terminal-worker-types.js";

/**
 * The durable-state dir the daemon scopes `--allow-fs-write` to
 * (`<dataDir>/terminal-worker`). `buildProductionSpawnWorker` injects
 * `COMIS_TERMINAL_DATA_DIR=<dataDir>` so this matches the write scope exactly;
 * the home fallback is for a direct (non-daemon) launch.
 */
export function durableDir(): string {
  // eslint-disable-next-line no-restricted-syntax -- worker PROCESS entry: the daemon threads the (non-secret) data dir via env when forking; not a SecretManager value.
  const dataDir = process.env.COMIS_TERMINAL_DATA_DIR ?? pathResolve(homedir(), ".comis");
  return pathResolve(dataDir, "terminal-worker");
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
 * DUR-01 §7.1.5 — the durable-vs-fallback WARN. tmux availability is a RUNTIME property, NOT
 * a config-validation hard-require (the LOCKED decision): `drive.durable:true` parses fine and
 * DEGRADES gracefully when tmux is absent. When the worker boots on a host with no tmux
 * (`tmuxPath === undefined`), a later `backend:"tmux"` durable drive falls back to pty/pipe —
 * and a daemon restart then ends that session `lost` (with the journal preserved; the
 * user-facing `failed` OUTCOME is Phase-166 NOTIFY-01's). Log ONE content-free WARN at boot so
 * an operator sees WHY a durable drive will not survive a restart on this host. Best-effort
 * (never throws out of the worker boot — a logging fault must not crash the process). §2.7:
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
        errorKind: "precondition",
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
 * The tmux long-run backend (OPS-05): a named tmux session outlives the worker, so a
 * milestone survives a worker crash + is re-attachable. `createTmuxBackend` makes the
 * survival decision via `has-session`; `runTmux` wraps `child_process.spawn` (a
 * ChildProcess structurally satisfies {@link TmuxChild}). Used ONLY for `backend:"tmux"`.
 */
export function buildLoadTmux(tmuxPath: string): TmuxBackendLike {
  return {
    spawn: (a) =>
      createTmuxBackend({
        sessionId: a.sessionId,
        bin: a.bin,
        argv: a.argv,
        cols: a.cols,
        rows: a.rows,
        env: a.env,
        tmuxPath,
        hasSession: (name) => {
          try {
            execFileSync(tmuxPath, ["has-session", "-t", name], { stdio: "ignore" });
            return true;
          } catch {
            return false;
          }
        },
        runTmux: (argv) => childSpawn(argv[0]!, argv.slice(1), { env: a.env }) as unknown as TmuxChild,
      }),
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

  // Long-run tmux backend (OPS-05) — present only if tmux is installed; absent ⇒
  // a backend:"tmux" request degrades to pty/pipe (never an error).
  const tmuxPath = resolveTmuxPath();
  const loadTmux = tmuxPath ? buildLoadTmux(tmuxPath) : undefined;
  // DUR-01 §7.1.5: WARN at boot if tmux is unavailable — a durable drive will degrade to
  // non-durable here, so a restart ends it `lost` (journal preserved; `failed` is Phase-166's).
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
