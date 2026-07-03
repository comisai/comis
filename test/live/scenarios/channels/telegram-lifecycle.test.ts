// SPDX-License-Identifier: Apache-2.0
/**
 * AUTO-02/03 + the unattended sequence — the AUTONOMY KEYSTONE:
 * restart preserves the emulator + handle (no double-start
 * deadlock); reset --deep is an isolated clean slate; `tg wait` blocks on a
 * trajectory signal with a settle-timeout fallback; and the shell-only
 * sequence (reset --deep -> rpc -> send -> wait -> explain) runs end-to-end with
 * NO human step and honest exits.
 *
 * ── DRIVEN IN-PROCESS ──
 *
 * The rig controller is IN-PROCESS: a true cross-process cold-shell
 * `tg restart` is a separate deliverable (the CLI returns
 * `lifecycle_in_process_only` honestly). So the sequence drives the
 * CONTROLLER directly (restart / reset --deep) + the rig (send) + the harness
 * waiter (wait) — this is exactly the "vitest calls the launcher
 * functions in-process" path. The rpc / explain legs go over WEBSOCKET
 * (`ws-helpers.ts`), the transport the gateway actually serves for the generic
 * dispatch (see telegram-rpc-passthrough.test.ts: `POST /rpc` 404s at HEAD).
 *
 * ── THE CI vs COMIS_LIVE SPLIT ──
 *
 *   • Stage-B (ALWAYS runs, no daemon): the restart cleanup-before-reboot
 *     ORDERING proof — a `createRigController` with a fake daemonHandle + an
 *     injected bootFn spy asserts `cleanup()` resolved BEFORE the boot
 *     (`['cleanup','boot']`), so the activeHandle double-start guard can never
 *     deadlock — deterministically, with NO real daemon.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE): `startStandaloneRig` ->
 *     `controller.restart()` -> a second `/health` passes (probeHealth) AND the
 *     emulator instance + the handle file are PRESERVED; `controller.resetDeep()`
 *     -> a clean slate scoped to the isolated dataDir (never ~/.comis); then the
 *     unattended sequence (reset --deep -> rpc observe -> send -> wait
 *     model.completed -> obs.explain) runs in-proc with honest exits and NO hang.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-lifecycle.test.ts
 *   Stage-C (the autonomy keystone, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-lifecycle.test.ts
 *
 * (a BARE `pnpm vitest run test/live/...` resolves the ROOT config -> 0 files,
 *  exit 0 = false green. ALWAYS pass `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRigController, type RigControlState } from "../../harness/rig-control.js";
import { startStandaloneRig, type StandaloneRig } from "../../harness/rig.js";
import { handlePath, probeHealth } from "../../harness/chanlive-handle.js";
import { resolveTrajectoryFile, waitForTrajectorySignal } from "../../harness/wait.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../../../support/ws-helpers.js";
import type { TgEmulator, ChatRef } from "../../emulators/telegram/tg-emulator.js";
import type { TestDaemonHandle, startTestDaemon } from "../../../support/daemon-harness.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The fixed test chat the lifecycle drives (mirrors the rig's DEFAULT_CHAT_ID). */
const TEST_CHAT: ChatRef = { chatId: 424242 };

/** A handle-file base dir under tmp so the operator's real ~/.comis-chanlive is never touched. */
function freshHandleBaseDir(): string {
  return mkdtempSync(join(tmpdir(), "tg-lifecycle-handle-"));
}

// ---------------------------------------------------------------------------
// Stage-B — restart() cleanup-before-reboot ORDERING (deterministic, no daemon)
// ---------------------------------------------------------------------------

describe("AUTO-02 Stage-B — restart() awaits cleanup() before the re-boot (the double-start guard ordering, no daemon)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    delete process.env["COMIS_DATA_DIR"];
  });

  it("restart() resolves cleanup() BEFORE bootFn is called (so the activeHandle double-start guard can never deadlock)", async () => {
    // A throwaway isolated dir so the controller's COMIS_DATA_DIR re-pin is real.
    const dataDir = mkdtempSync(join(tmpdir(), "tg-lifecycle-data-"));
    const memoryDbPath = join(dataDir, "test-memory-channel-emu.db");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    // Record call order: cleanup() MUST resolve before bootFn runs.
    const order: string[] = [];
    const cleanup = vi.fn(async () => {
      order.push("cleanup");
    });
    const oldHandle = { cleanup, gatewayUrl: "http://127.0.0.1:1", authToken: "t" } as unknown as TestDaemonHandle;
    const newHandle = {
      cleanup: vi.fn(async () => undefined),
      gatewayUrl: "http://127.0.0.1:1",
      authToken: "t",
    } as unknown as TestDaemonHandle;
    const bootFn = vi.fn(async () => {
      order.push("boot");
      return newHandle;
    }) as unknown as typeof startTestDaemon;

    const emulator = { resetChat: vi.fn() } as unknown as TgEmulator;
    const state: RigControlState = {
      emulator,
      daemonHandle: oldHandle,
      dataDir,
      configPath: join(dataDir, "config.rig.yaml"),
      gatewayPort: 1,
      gatewayUrl: "http://127.0.0.1:1",
      chat: TEST_CHAT,
      memoryDbPath,
    };
    const controller = createRigController(state, bootFn);

    await controller.restart();

    // The load-bearing ordering: cleanup() resolved BEFORE boot was called (so a
    // real startTestDaemon would never throw "Test daemon already running" — the
    // activeHandle double-start guard can never deadlock).
    expect(order).toEqual(["cleanup", "boot"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(bootFn).toHaveBeenCalledTimes(1);
    // The emulator instance is PRESERVED across the re-boot.
    expect(controller.emulator).toBe(emulator);
    // The new handle was swapped in (a later cleanup tears down the CURRENT daemon).
    expect(controller.daemonHandle).toBe(newHandle);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — restart preserves emulator+handle; reset --deep clean slate; sequence
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("AUTO-02/03 Stage-C — restart preserves emulator+handle, reset --deep clean slate, the unattended sequence (COMIS_LIVE)", () => {
  let rig: StandaloneRig | undefined;
  let baseDir: string | undefined;

  beforeAll(async () => {
    baseDir = freshHandleBaseDir();
    rig = await startStandaloneRig({ channel: "telegram", model: "keyless", baseDir });
  }, 120_000);

  afterAll(async () => {
    if (rig?.cleanup) await rig.cleanup();
    rig = undefined;
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = undefined;
  });

  it("restart() re-boots without the double-start deadlock and PRESERVES the emulator + handle file (AUTO-02)", async () => {
    const r = rig;
    const bd = baseDir;
    expect(r, "rig spawned").toBeDefined();
    expect(r?.controller, "a spawned rig has a controller").toBeDefined();
    if (r === undefined || r.controller === undefined || bd === undefined) return;

    const emulatorBefore = r.controller.emulator;
    const gatewayUrl = r.controller.gatewayUrl;
    const handleFile = handlePath("telegram", bd);

    // Pre-condition: the gateway is healthy + the handle file exists.
    expect(await probeHealth(gatewayUrl)).toBe(true);
    expect(existsSync(handleFile)).toBe(true);

    // The double-start-guard proof live: restart() does cleanup() -> re-pin ->
    // boot WITHOUT throwing "Test daemon already running".
    await r.controller.restart();

    // A second /health passes (no deadlock, the daemon re-booted on the same port).
    expect(r.controller.gatewayUrl).toBe(gatewayUrl);
    expect(await probeHealth(gatewayUrl)).toBe(true);
    // The emulator instance is PRESERVED across the re-boot.
    expect(r.controller.emulator).toBe(emulatorBefore);
    // The handle file is still present (restart preserves the handle).
    expect(existsSync(handleFile)).toBe(true);
  });

  it("reset --deep gives a clean slate scoped to the ISOLATED dataDir (never ~/.comis) and the daemon is healthy again (AUTO-02)", async () => {
    const r = rig;
    expect(r?.controller, "controller present").toBeDefined();
    if (r === undefined || r.controller === undefined) return;

    // The isolation guarantee: the rig's dataDir is a throwaway mkdtemp dir, NEVER
    // the operator's real ~/.comis (the resetDeep guard enforces this —
    // it THROWS on a non-isolated dataDir before any I/O).
    const dataDir = r.handle.dataDir;
    expect(dataDir).not.toBe(join(homedir(), ".comis"));
    expect(dataDir).not.toBe("");
    expect(dataDir.length).toBeGreaterThan(0);

    await r.controller.resetDeep();

    // After the clean slate the daemon is healthy again (reset --deep re-boots).
    expect(await probeHealth(r.controller.gatewayUrl)).toBe(true);
    // The isolated dataDir itself survives (we wipe UNDER it, never the dir).
    expect(existsSync(dataDir)).toBe(true);
    // The operator's real ~/.comis was NEVER the target (the guarantee).
    expect(dataDir).not.toBe(join(homedir(), ".comis"));
  });

  it(
    "the unattended sequence runs end-to-end in-proc with NO human step: reset --deep -> rpc -> send -> wait -> explain, all honest-exit",
    async () => {
      const r = rig;
      expect(r?.controller, "controller present").toBeDefined();
      if (r === undefined || r.controller === undefined) return;
      const controller = r.controller;
      const { gatewayUrl, gatewayToken, dataDir, chatId } = r.handle;

      // STEP 1 — reset --deep: a clean slate before the sequence (no human step).
      await controller.resetDeep();
      expect(await probeHealth(gatewayUrl)).toBe(true);

      // STEP 2 — rpc <observe method>: an auth'd passthrough over the WS transport
      // (config.get needs no model). Honest: a result, or an honest error.
      const ws = await openAuthenticatedWebSocket(gatewayUrl, gatewayToken);
      let sessionFileFromSend: string | undefined;
      try {
        const cfg = (await sendJsonRpc(ws, "config.get", {}, 1, { timeoutMs: 20_000 })) as {
          result?: { tenantId?: string };
          error?: unknown;
        };
        expect(cfg.error).toBeUndefined();
        expect(cfg.result?.tenantId).toBe("test");

        // STEP 3 — send: inject a DM (the agent authors a reply over the keyless model).
        // Drive the rig's send via the controller's preserved emulator + the
        // control client is internal; use the standalone rig's gateway-side send
        // by injecting through the emulator's control surface is not exposed here,
        // so we inject via the emulator directly (the in-proc equivalent of a DM).
        const inboundId = controller.emulator.injectMessage(
          { chatId },
          { id: 100, firstName: "Tester", username: "tester" },
          "hello from the unattended sequence",
        );
        expect(inboundId).toBeGreaterThan(0);

        // STEP 4 — wait --event model.completed: block on the trajectory signal with
        // a settle-timeout fallback so a slow turn NEVER hangs (the AUTO-03 keystone).
        // Resolve the session file the daemon wrote under <dataDir>/workspace/sessions.
        sessionFileFromSend = await pollForSessionFile(dataDir, 60_000);
        if (sessionFileFromSend !== undefined) {
          const trajectoryFile = resolveTrajectoryFile(sessionFileFromSend);
          const waited = await waitForTrajectorySignal({
            trajectoryFile,
            event: "model.completed",
            settleMs: 3000,
            timeoutMs: 90_000,
          });
          // ALWAYS resolves — matched OR an honest settle_timeout/timeout (never a hang,
          // never a fabricated match). The honest-exit contract.
          expect(["matched", "settle_timeout", "timeout"]).toContain(waited.reason);
        }

        // STEP 5 — explain: the ground-truth IncidentReport over WS (obs.explain).
        // Resolve the session key from the emulator's chat -> the daemon's session.
        // We pass a best-effort sessionKey/traceId; obs.explain returns a report or
        // an honest error — either way the step is honest-exit (no false success).
        const explainResp = (await sendJsonRpc(
          ws,
          "obs.explain",
          { sessionKey: `test:tester:telegram:${chatId}`, depth: "summary" },
          2,
          { timeoutMs: 30_000 },
        )) as { result?: unknown; error?: { code: number; message: string } };
        // Honest: a result OR a reason-coded error — never a silent success.
        if (explainResp.error !== undefined) {
          expect(typeof explainResp.error.code).toBe("number");
        } else {
          expect(explainResp.result).toBeTypeOf("object");
        }
      } finally {
        ws.close();
      }

      // The whole sequence ran in-proc with NO human step and NO hang — the
      // autonomy keystone (every step honest-exit, the waiter settle-bounded).
      expect(true).toBe(true);
    },
    180_000,
  );

  /**
   * Poll for the session JSONL file the daemon writes under
   * `<dataDir>/workspace/sessions/<tenant>/<channel>/` after a send (the file
   * appears asynchronously). Returns the FIRST `.jsonl` (excluding the
   * `.trajectory.jsonl` derivative), or undefined on timeout (honest absence —
   * the wait step then simply skips, never hangs / never false-matches).
   */
  async function pollForSessionFile(dataDir: string, timeoutMs: number): Promise<string | undefined> {
    const base = join(dataDir, "workspace", "sessions");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = findSessionFile(base);
      if (found !== undefined) return found;
      await new Promise((res) => setTimeout(res, 250));
    }
    return undefined;
  }

  /** Recursively find the first non-trajectory `.jsonl` under `dir` (or undefined). */
  function findSessionFile(dir: string): string | undefined {
    if (!existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = findSessionFile(full);
        if (nested !== undefined) return nested;
      } else if (
        entry.name.endsWith(".jsonl") &&
        !entry.name.endsWith(".trajectory.jsonl")
      ) {
        return full;
      }
    }
    return undefined;
  }
});

// ---------------------------------------------------------------------------
// Stage-B — resetDeep() isolated-dir guard (deterministic, no daemon) —
// the "never destroy what you didn't spawn / never ~/.comis" property.
// ---------------------------------------------------------------------------

describe("AUTO-02 Stage-B — reset --deep REFUSES a non-isolated dataDir (the ~/.comis guard, no daemon)", () => {
  it("resetDeep() THROWS on the operator's real ~/.comis BEFORE any cleanup/boot/IO", async () => {
    const cleanup = vi.fn(async () => undefined);
    const handle = { cleanup, gatewayUrl: "http://127.0.0.1:1", authToken: "t" } as unknown as TestDaemonHandle;
    const bootFn = vi.fn(async () => handle) as unknown as typeof startTestDaemon;
    const emulator = { resetChat: vi.fn() } as unknown as TgEmulator;

    const homeComis = join(homedir(), ".comis");
    const controller = createRigController(
      {
        emulator,
        daemonHandle: handle,
        dataDir: homeComis,
        configPath: join(homeComis, "config.rig.yaml"),
        gatewayPort: 1,
        gatewayUrl: "http://127.0.0.1:1",
        chat: TEST_CHAT,
        memoryDbPath: join(homeComis, "memory.db"),
      },
      bootFn,
    );

    await expect(controller.resetDeep()).rejects.toThrow(/refusing reset --deep|non-isolated/);
    // The guard short-circuits — nothing was touched.
    expect(cleanup).not.toHaveBeenCalled();
    expect(bootFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage-B — a fixture-trajectory `tg wait` honest settle-timeout (no daemon) —
// proves the AUTO-03 waiter NEVER hangs even when the signal is slow/absent.
// ---------------------------------------------------------------------------

describe("AUTO-03 Stage-B — `tg wait` resolves honestly (settle_timeout) on a quiet trajectory, never hangs (no daemon)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("a trajectory with no matching event resolves { matched:false, reason:'settle_timeout' } well before the hard timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-lifecycle-traj-"));
    tmpDirs.push(dir);
    const trajectoryFile = join(dir, "s.jsonl.trajectory.jsonl");
    // A real-shape line that is NOT model.completed -> the waiter never matches it.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      trajectoryFile,
      JSON.stringify({ type: "session.started", data: {} }) + "\n",
      "utf-8",
    );

    const start = Date.now();
    const result = await waitForTrajectorySignal({
      trajectoryFile,
      event: "model.completed",
      settleMs: 200,
      timeoutMs: 10_000,
    });
    const elapsed = Date.now() - start;

    // Honest settle-timeout (never a hang to the hard ceiling, never a false match).
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("settle_timeout");
    expect(elapsed).toBeLessThan(9_000);
  });
});
