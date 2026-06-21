// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-daemon.ts` — the DETACHED-subprocess rig entrypoint (Phase 208, Plan 08 —
 * the cold-shell Option-A stretch, the milestone HEADLINE "shell-only,
 * unattended").
 *
 * The in-process rig (`startStandaloneRig` @ rig.ts) boots the daemon IN THE
 * `tg up` PROCESS, so it dies the instant `tg up` exits — a SECOND-shell
 * `tg send` cannot reach it. THIS entrypoint is the cross-process fix: the
 * launcher (`startStandaloneRig({ detached: true })`) `child_process.spawn`s it
 * `{ detached: true, stdio: "ignore" }` + `child.unref()`, so the rig OUTLIVES
 * `tg up` and a separate-process `tg send`/`tg explain`/`tg down` can drive it.
 *
 * WHAT THIS PROCESS OWNS:
 *   1. the `TgEmulator` + the `/control/*` API (the channel oracle) — started
 *      HERE so it lives in THIS process (not the ephemeral `tg up`);
 *   2. a REAL Comis daemon, spawned as a DETACHED GRANDCHILD under plain `node`
 *      (`packages/daemon/dist/daemon.js` — the SAME production entrypoint) pointed
 *      at the throwaway config + isolated `COMIS_DATA_DIR`. WHY a grandchild and
 *      not an in-process `main()`: a standalone `tsx`/`node` cannot resolve the
 *      dist `@comis/*` graph the way the vitest live-config alias map does (a
 *      bare `@comis/daemon` is unresolved; tsx's resolver chokes on the
 *      pnpm-linked `@comis/core` `exports`). Plain `node daemon.js` resolves the
 *      WHOLE dist graph correctly (it IS how production runs — CLAUDE.md "Direct
 *      (production)"), so the grandchild is the robust, deterministic boot;
 *   3. a loopback-only, owner-checked rig-control HTTP surface (`/health`,
 *      `/shutdown`, `/restart`, `/reconfigure`, `/reset`) — the cross-process
 *      lifecycle the cold-shell `tg` verbs POST;
 *   4. ORPHAN REAPING: a heartbeat that self-terminates THIS process (after
 *      reaping the daemon grandchild) when its handle file disappears or its
 *      parent (`tg up`) is gone AND nothing has adopted the rig — so a crashed /
 *      `kill -9`'d launcher never leaves a zombie daemon (the EXACT pm2 class
 *      CLAUDE.md §"pm2" warns about).
 *
 * TEARDOWN ORDER (SIGTERM / `/shutdown` / orphan-reap all converge here):
 *   reap the daemon grandchild (SIGTERM → grace → SIGKILL; the gateway-port-free
 *   probe is the authoritative "no leak" oracle) → stop the emulator → remove the
 *   handle file → rm the throwaway config + data dirs → exit 0. Idempotent (a
 *   second trigger is a no-op).
 *
 * SECURITY (T-208-30/31/32): the rig-control surface binds 127.0.0.1 ONLY and is
 * owner-checked against the `0600` handle's gateway token (a loopback caller
 * still must present the token). The handle file stays `0600`. This is the most
 * powerful test-only surface (stop/reset/restart a daemon) — it is FULLY isolated
 * ($0/throwaway dirs) and `test/`-only (SEC-02: never a `comis` subcommand, no
 * `@comis/*` published edge).
 *
 * TEST-HARNESS — lives under the test tree, never the packages source-tree; ZERO
 * production code change. `node:fs`/`node:http`/`child_process`/`process.env` are
 * all fine here. Build first: the daemon grandchild boots `@comis/daemon` from
 * `dist/` (a stale `dist/` masks `src/`).
 *
 * @module
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createTgEmulator, type TgEmulator } from "../emulators/telegram/tg-emulator.js";
import { registerControlApi } from "./control-api.js";
import { buildConfigYaml, FAKE_BOT_TOKEN, MEMORY_DB_FILE } from "./rig-config.js";
import {
  writeHandle,
  handlePath,
  type ChanliveHandle,
} from "./chanlive-handle.js";
import {
  respawnDaemon,
  reapForTeardown,
  type RespawnOutcome,
} from "./rig-lifecycle.js";

/** The fixed test chat id the rig drives (a fabricated id, never a real operator chat — T-204-15). */
const DEFAULT_CHAT_ID = 424242;

/**
 * The `@comis/daemon` PRODUCTION entrypoint, resolved relative to THIS file. The
 * grandchild boots it under plain `node` (the dist `@comis/*` graph resolves
 * there; it does NOT under a standalone `tsx`). The SAME staleness contract as
 * the rest of the harness: `pnpm build` first.
 */
const DAEMON_JS = new URL("../../../packages/daemon/dist/daemon.js", import.meta.url).pathname;

/** How long to wait for the daemon grandchild's `/health` before giving up (ms). */
const HEALTH_WAIT_MS = 30_000;
/** Poll cadence for the `/health` + port-free probes (ms). */
const PROBE_INTERVAL_MS = 250;
/** Grace after SIGTERM before escalating to SIGKILL when reaping the daemon grandchild (ms). */
const REAP_GRACE_MS = 8_000;
/** Orphan-reaper heartbeat cadence (ms) — checks handle-present + parent-alive. */
const HEARTBEAT_INTERVAL_MS = 1_000;

/** The env contract the launcher sets when spawning this entrypoint. */
interface RigDaemonEnv {
  /** The channel (telegram). */
  readonly channel: string;
  /** The model the daemon's agent runs (`keyless` or a provider/model id). */
  readonly model: string;
  /** The handle-file base dir (default `~/.comis-chanlive`). */
  readonly baseDir: string;
  /** The PRE-ALLOCATED gateway port (the launcher picked it so the handle URL is known up-front). */
  readonly gatewayPort: number;
  /** The PRE-ALLOCATED rig-control HTTP port (≠ gateway). */
  readonly rigControlPort: number;
  /** The launcher's pid — the orphan-reaper self-terminates if this parent is gone AND the handle is stale. */
  readonly parentPid: number;
}

/** Read + validate the env contract (an honest throw on a missing/invalid var — never a silent default). */
function readEnv(): RigDaemonEnv {
  const get = (k: string): string => {
    const v = process.env[k];
    if (v === undefined || v.length === 0) {
      throw new Error(`rig-daemon: missing required env ${k}`);
    }
    return v;
  };
  const num = (k: string): number => {
    const n = Number(get(k));
    if (!Number.isFinite(n)) throw new Error(`rig-daemon: env ${k} is not a finite number`);
    return n;
  };
  return {
    channel: get("COMIS_RIG_CHANNEL"),
    model: get("COMIS_RIG_MODEL"),
    baseDir: get("COMIS_RIG_BASE_DIR"),
    gatewayPort: num("COMIS_RIG_GATEWAY_PORT"),
    rigControlPort: num("COMIS_RIG_CONTROL_PORT"),
    parentPid: num("COMIS_RIG_PARENT_PID"),
  };
}

/** Is `pid` alive? `kill(pid, 0)` throws ESRCH when it is not (POSIX liveness probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A bounded GET `<url>/health` → true on 200, false on any throw/non-200 (honest, never hangs). */
async function probeHealthy(gatewayUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(PROBE_INTERVAL_MS * 4) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve true when `<gatewayUrl>/health` is 200 within `HEALTH_WAIT_MS`, else false (bounded). */
async function waitForHealthy(gatewayUrl: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    if (await probeHealthy(gatewayUrl)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}

/** Can we bind `port` on loopback? true = FREE (the authoritative "no leaked daemon/port" oracle). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Reap the daemon grandchild DETERMINISTICALLY: SIGTERM → wait up to
 * {@link REAP_GRACE_MS} for the grandchild PROCESS to be DEAD **and** the gateway
 * PORT to be FREE → SIGKILL escalation if it overruns. The PROCESS-dead check is
 * the primary oracle (a SO_REUSEADDR bind can succeed while the socket lingers, so
 * the port alone is not "no leaked daemon"); the port-free check is the secondary
 * confirmation. The production daemon's graceful shutdown can be slow, so SIGKILL
 * after the grace window guarantees no lingering daemon. Returns true when reaped.
 */
async function reapDaemon(child: ChildProcess | undefined, gatewayPort: number): Promise<boolean> {
  if (child?.pid === undefined) return await isPortFree(gatewayPort);
  const pid = child.pid;
  const reaped = async (): Promise<boolean> => !isAlive(pid) && (await isPortFree(gatewayPort));
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + REAP_GRACE_MS;
  while (Date.now() < deadline) {
    if (await reaped()) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  // Escalate — graceful shutdown overran; SIGKILL the grandchild, then confirm dead.
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  const killDeadline = Date.now() + REAP_GRACE_MS;
  while (Date.now() < killDeadline) {
    if (await reaped()) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return await reaped();
}

/** The live state the rig-control routes + the teardown converge on. */
interface RigState {
  readonly env: RigDaemonEnv;
  readonly emulator: TgEmulator;
  /** The emulator's loopback base (`http://127.0.0.1:P`) — kept so `/reconfigure` can re-write the config's apiRoot. */
  readonly apiRoot: string;
  readonly gatewayUrl: string;
  readonly configDir: string;
  readonly configPath: string;
  readonly dataDir: string;
  /** The current daemon grandchild (swapped on `/restart` + `/reconfigure`). */
  daemon: ChildProcess | undefined;
  /** Set once teardown begins so it is idempotent. */
  tearingDown: boolean;
}

/**
 * Spawn the daemon grandchild (plain `node daemon.js`) on the throwaway config +
 * isolated data dir.
 *
 * NOT `detached` (deliberate): a `detached: true` grandchild gets its OWN process
 * group, so a cold-shell group-kill of the rig-daemon's group (`kill(-pgid)`)
 * would MISS it → a leaked daemon (the pm2 zombie class). Keeping it in the
 * rig-daemon's group means a single group-kill reaps BOTH the rig-daemon AND the
 * daemon. `unref()` still lets the rig-daemon's event loop idle independently; the
 * rig-daemon's explicit {@link reapDaemon} handles the GRACEFUL SIGTERM shutdown
 * (port-free oracle) for the normal `tg down` path.
 */
function spawnDaemonGrandchild(state: RigState): ChildProcess {
  const child = spawn(process.execPath, [DAEMON_JS], {
    stdio: "ignore",
    env: {
      ...process.env,
      COMIS_CONFIG_PATHS: state.configPath,
      COMIS_DATA_DIR: state.dataDir,
      // The grandchild is its OWN production-style daemon, NOT a vitest process —
      // clear VITEST so daemon.js does not take the test-process config-guard branch.
      VITEST: "",
    },
  });
  // unref so the rig-daemon's event loop can idle independently of the grandchild,
  // but we still hold the handle (child.pid) to reap it deterministically.
  child.unref();
  return child;
}

/**
 * Tear down EVERYTHING (idempotent): reap the daemon grandchild (SIGTERM → port-free
 * → SIGKILL) → stop the emulator → remove the handle file → rm the throwaway dirs →
 * exit. Every path (SIGTERM, `/shutdown`, orphan-reap) calls this.
 */
async function teardown(state: RigState, code: number): Promise<never> {
  // AUTHORITATIVE teardown (WR-01): reapForTeardown sets the `tearingDown` latch (so a
  // racing /reset|/restart refuses to respawn) and reaps the CURRENT daemon, then
  // re-reads state.daemon and reaps AGAIN — catching a daemon a /reset swapped in just
  // before the latch took effect. This guarantees NO daemon survives teardown even on
  // the orphan-reap path (where process.exit does NOT group-kill the respawned one).
  // It returns false when the latch was already set (a concurrent teardown owns it).
  let owned = true;
  try {
    owned = await reapForTeardown(
      state,
      { gatewayPort: state.env.gatewayPort, reap: reapDaemon },
    );
  } catch {
    // best-effort — proceed to the rest of teardown regardless.
  }
  if (!owned) {
    // A second trigger — wait out the first teardown, then exit.
    await new Promise((r) => setTimeout(r, REAP_GRACE_MS));
    process.exit(code);
  }
  try {
    await state.emulator.stop();
  } catch {
    // best-effort
  }
  // Remove the handle so a later discover does not resolve a dead rig.
  try {
    const path = handlePath(state.env.channel, state.env.baseDir);
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // best-effort
  }
  rmSync(state.configDir, { recursive: true, force: true });
  rmSync(state.dataDir, { recursive: true, force: true });
  process.exit(code);
}

/**
 * The loopback-only, owner-checked rig-control HTTP surface. Routes:
 *   GET  /health      → 200 `{ ok, pid }` once the daemon grandchild is healthy
 *                       (no token — the launcher's readiness probe; reveals nothing secret).
 *   POST /shutdown    → tear down + 200, then exit (the cold-shell `tg down` path).
 *   POST /restart     → reap + re-spawn the daemon grandchild (same config), 200 on healthy.
 *   POST /reconfigure → rewrite the throwaway config with `{ overrides }` then restart, 200.
 *   POST /reset       → wipe the isolated memory.db/logs/sessions + resetChat + restart, 200.
 * Every POST is owner-checked against the gateway token (`Authorization: Bearer …`).
 */
function startRigControlServer(state: RigState, token: string): Promise<HttpServer> {
  const server = createHttpServer((req, res) => {
    void handleRigControl(req, res, state, token).catch(() => {
      // A handler failure must not crash the control server — answer 500, stay up.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "rig-control handler error" }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.env.rigControlPort, "127.0.0.1", () => resolve(server));
  });
}

/** Parse a `/reconfigure` body → `{ overrides }`, honestly erroring on bad json / no overrides. */
function parseReconfigureBody(
  body: string,
): { ok: true; overrides: Record<string, string> } | { ok: false; error: string } {
  let overrides: Record<string, string>;
  try {
    const parsed = JSON.parse(body.length > 0 ? body : "{}") as { overrides?: Record<string, string> };
    overrides = parsed.overrides ?? {};
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (Object.keys(overrides).length === 0) {
    return { ok: false, error: "no overrides" };
  }
  return { ok: true, overrides };
}

/** Read the full request body as a string (bounded by Node's default; the routes send tiny JSON). */
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(body));
  });
}

/** Dispatch one rig-control request (owner-checked for the mutating verbs). */
async function handleRigControl(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  state: RigState,
  token: string,
): Promise<void> {
  const url = req.url ?? "/";
  // GET /health — the launcher's readiness probe (no secret revealed; no auth).
  if (req.method === "GET" && url === "/health") {
    const healthy = await probeHealthy(state.gatewayUrl);
    res.statusCode = healthy ? 200 : 503;
    res.end(JSON.stringify({ ok: healthy, pid: process.pid }));
    return;
  }
  // Every MUTATING verb is owner-checked against the gateway token (T-208-30).
  const auth = req.headers["authorization"];
  const presented = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (presented !== token) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  if (req.method === "POST" && url === "/shutdown") {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, status: "shutting_down", pid: process.pid }));
    // Tear down AFTER the response flushes.
    setImmediate(() => {
      void teardown(state, 0);
    });
    return;
  }
  if (req.method === "POST" && url === "/restart") {
    const ok = await restartDaemon(state);
    res.statusCode = ok ? 200 : 503;
    res.end(JSON.stringify({ ok, status: ok ? "restarted" : "restart_unhealthy" }));
    return;
  }
  if (req.method === "POST" && url === "/reconfigure") {
    const body = await readBody(req);
    const parsed = parseReconfigureBody(body);
    if (!parsed.ok) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: parsed.error }));
      return;
    }
    const overrides = parsed.overrides;
    // Rewrite the throwaway config with the new model, then restart (the Track-K sweep).
    const newModel = overrides["agents.default.model"] ?? state.env.model;
    writeFileSync(
      state.configPath,
      buildConfigYaml(state.apiRoot, state.env.gatewayPort, newModel),
      "utf-8",
    );
    const ok = await restartDaemon(state);
    res.statusCode = ok ? 200 : 503;
    res.end(JSON.stringify({ ok, status: ok ? "reconfigured" : "reconfigure_unhealthy", overrides }));
    return;
  }
  if (req.method === "POST" && url === "/reset") {
    // Clean-slate the isolated state (memory.db + logs + sessions), reset the chat
    // oracle, then restart. Scoped UNDER the throwaway dataDir — never ~/.comis.
    //
    // Delegated to respawnDaemon so /reset shares the SAME guards as /restart:
    //   - WR-01: refuses to respawn (and skips the wipe) once teardown's latch is set;
    //   - WR-02: only wipes + rebinds once the prior daemon is CONFIRMED reaped AND the
    //     gateway port is free — so the wipe never runs against a live daemon's db and
    //     the fresh daemon never races an EADDRINUSE.
    // The wipe is the beforeSpawn seam (after the confirmed reap, before the new spawn).
    const outcome: RespawnOutcome = await respawnDaemon(state, {
      gatewayPort: state.env.gatewayPort,
      reap: reapDaemon,
      isPortFree,
      spawn: () => spawnDaemonGrandchild(state),
      waitForHealthy: () => waitForHealthy(state.gatewayUrl),
      beforeSpawn: () => {
        for (const f of [
          join(state.dataDir, MEMORY_DB_FILE),
          `${join(state.dataDir, MEMORY_DB_FILE)}-wal`,
          `${join(state.dataDir, MEMORY_DB_FILE)}-shm`,
        ]) {
          rmSync(f, { force: true });
        }
        rmSync(join(state.dataDir, "logs"), { recursive: true, force: true });
        rmSync(join(state.dataDir, "workspace", "sessions"), { recursive: true, force: true });
        state.emulator.resetChat({ chatId: DEFAULT_CHAT_ID });
      },
    });
    res.statusCode = outcome.ok ? 200 : 503;
    res.end(JSON.stringify({ ok: outcome.ok, status: outcome.ok ? "reset" : "reset_unhealthy" }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: "not_found", url }));
}

/**
 * Reap the current daemon grandchild + re-spawn it on the (current) config; wait on
 * health. Delegates the DECISION to {@link respawnDaemon}, which (WR-01) REFUSES to
 * respawn once teardown's `tearingDown` latch is set — so no daemon is created that a
 * teardown-via-`process.exit` could not reap on the orphan-reap path — and (WR-02)
 * HONORS the reap result + confirms {@link isPortFree} before rebinding, so a fresh
 * daemon never races an EADDRINUSE onto a gateway port the prior (slow-to-die) daemon
 * still holds. Returns the boolean the `/restart`/`/reconfigure` verbs branch on (a
 * refusal is honestly "not healthy" → a `*_unhealthy` 503).
 */
async function restartDaemon(state: RigState): Promise<boolean> {
  const outcome: RespawnOutcome = await respawnDaemon(state, {
    gatewayPort: state.env.gatewayPort,
    reap: reapDaemon,
    isPortFree,
    spawn: () => spawnDaemonGrandchild(state),
    waitForHealthy: () => waitForHealthy(state.gatewayUrl),
  });
  return outcome.ok;
}

/**
 * Boot the detached rig: emulator + control-api → throwaway config + data dir →
 * the daemon grandchild → wait on `/health` → the rig-control HTTP surface → the
 * `0600` handle (pid + the dedicated rigControlEndpoint) → the orphan-reaper +
 * the SIGTERM handler. On a boot failure, tear down and exit non-zero (no leak).
 */
async function main(): Promise<void> {
  const env = readEnv();

  // 1. Start the emulator + the /control/* API — they live in THIS process.
  const emulator = createTgEmulator({ botToken: FAKE_BOT_TOKEN });
  const { apiRoot } = await emulator.start();
  registerControlApi(emulator.backend, emulator);

  // 2. Write the throwaway config (AFTER the emulator started so apiRoot is real)
  //    + an isolated COMIS_DATA_DIR.
  const configDir = mkdtempSync(join(tmpdir(), "comis-rigd-cfg-"));
  const configPath = join(configDir, "config.rig.yaml");
  writeFileSync(configPath, buildConfigYaml(apiRoot, env.gatewayPort, env.model), "utf-8");
  const dataDir = mkdtempSync(join(tmpdir(), "comis-rigd-data-"));
  const gatewayUrl = `http://127.0.0.1:${env.gatewayPort}`;

  const state: RigState = {
    env,
    emulator,
    apiRoot,
    gatewayUrl,
    configDir,
    configPath,
    dataDir,
    daemon: undefined,
    tearingDown: false,
  };

  // 3. Spawn the daemon grandchild + wait on /health. A boot failure tears down + exits non-zero.
  state.daemon = spawnDaemonGrandchild(state);
  const healthy = await waitForHealthy(gatewayUrl);
  if (!healthy) {
    await teardown(state, 1);
    return;
  }

  // 4. Resolve the gateway token (the literal the config carries) for the owner check.
  const token = "test-secret-key-for-integration-tests";

  // 5. Start the loopback-only rig-control HTTP surface.
  await startRigControlServer(state, token);
  const rigControlEndpoint = `http://127.0.0.1:${env.rigControlPort}`;

  // 6. Write the 0600 handle — pid + the DEDICATED rigControlEndpoint (≠ gateway).
  const handle: ChanliveHandle = {
    channel: env.channel,
    controlEndpoint: apiRoot,
    rigControlEndpoint,
    gatewayUrl,
    gatewayToken: token,
    chatId: DEFAULT_CHAT_ID,
    dataDir,
    memoryDbPath: join(dataDir, MEMORY_DB_FILE),
    pid: process.pid,
  };
  writeHandle(handle, env.baseDir);

  // 7. SIGTERM/SIGINT → graceful teardown (the cold-shell `tg down` SIGTERMs the pid).
  const onSignal = (): void => {
    void teardown(state, 0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // 8. Orphan reaping: self-terminate (reaping the daemon first) if the handle file
  //    DISAPPEARS — the cross-process "no owner" signal. A `tg down` removes the
  //    handle out-of-band (then we reap ourselves cleanly if the SIGTERM raced), and
  //    an operator who `rm`s the stale handle gets the daemon reaped too (no zombie).
  //
  //    NB: we DELIBERATELY do NOT reap on "parent (`tg up`) gone" — a `--detached`
  //    rig is BUILT to OUTLIVE its launcher (the cold-shell premise: `tg up` exits,
  //    the rig keeps running so a SEPARATE-shell `tg send` reaches it). Treating the
  //    expected parent exit as an orphan signal would tear the rig down the instant
  //    `tg up` returns — the exact opposite of Option A. The handle-gone signal is
  //    the correct, sufficient orphan oracle. `env.parentPid` is retained only for
  //    diagnostics (it identifies which launcher spawned this rig).
  void env.parentPid;
  const heartbeat = setInterval(() => {
    if (state.tearingDown) return;
    const path = handlePath(env.channel, env.baseDir);
    if (!existsSync(path)) {
      void teardown(state, 0);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
}

main().catch((err: unknown) => {
  // A boot-path throw is still an honest non-zero exit (never a half-alive rig).
  console.error("rig-daemon: fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// Touch homedir so a future default-baseDir branch keeps the import (the launcher
// always passes COMIS_RIG_BASE_DIR today; defaulting to ~/.comis-chanlive is the
// honest fallback if it is ever omitted).
void homedir;
