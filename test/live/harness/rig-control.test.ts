// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-control.test.ts` — the AUTO-02 lifecycle owner.
 *
 * Two tiers, split by `isLive`:
 *
 *   • DETERMINISTIC (always runs, no daemon, no network): the cleanup-before-reboot
 *     ordering proof — `restart()` / `resetDeep()` await the current `daemonHandle.cleanup()`
 *     (which sets the double-start `activeHandle = null`) BEFORE re-booting via the
 *     injected `bootFn`, so a real `startTestDaemon` would never throw "Test daemon
 *     already running". Plus the `resetDeep()` clean-slate filesystem proof (a real
 *     `mkdtempSync` data dir with a dummy `memory.db` + `logs/` + `workspace/sessions/`
 *     wiped) and the home-`.comis` SECURITY guard (`resetDeep()` THROWS on a
 *     non-isolated dataDir).
 *
 *   • LIVE (`describe.skipIf(!isLive)`, COMIS_LIVE): boots a REAL isolated rig,
 *     calls `restart()`, and asserts the gateway is healthy again (a second
 *     `/health` passes — no double-start deadlock) and the emulator
 *     instance is PRESERVED across the re-boot.
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live` →
 * 0 files = false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig-control.test.ts
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRigController, type RigControlState } from "./rig-control.js";
import type { TgEmulator, ChatRef } from "../emulators/telegram/tg-emulator.js";
import type { TestDaemonHandle, startTestDaemon } from "../../support/daemon-harness.js";
import { buildRig, type BuiltRig } from "./rig.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The fixed test chat the controller's state carries. */
const TEST_CHAT: ChatRef = { chatId: 424242 };

/**
 * A throwaway data dir with a memory.db + logs/ + workspace/sessions/ tree (the
 * isolated state `resetDeep()` wipes). Returns the dir + the
 * memory.db path.
 */
function makeIsolatedDataDir(): { dataDir: string; memoryDbPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-rigctl-test-"));
  const memoryDbPath = join(dataDir, "test-memory-channel-emu.db");
  writeFileSync(memoryDbPath, "dummy-sqlite-bytes", "utf-8");
  writeFileSync(`${memoryDbPath}-wal`, "wal", "utf-8");
  writeFileSync(`${memoryDbPath}-shm`, "shm", "utf-8");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  writeFileSync(join(dataDir, "logs", "daemon.log"), "log line", "utf-8");
  mkdirSync(join(dataDir, "workspace", "sessions", "test", "telegram"), { recursive: true });
  writeFileSync(join(dataDir, "workspace", "sessions", "test", "telegram", "s.jsonl"), "{}", "utf-8");
  return { dataDir, memoryDbPath };
}

/**
 * A fake emulator stub — only `resetChat` is exercised by the controller; the
 * other members are unused in the deterministic tier (cast through unknown).
 */
function makeFakeEmulator(): { emulator: TgEmulator; resetChat: ReturnType<typeof vi.fn> } {
  const resetChat = vi.fn();
  const emulator = { resetChat } as unknown as TgEmulator;
  return { emulator, resetChat };
}

// ---------------------------------------------------------------------------
// DETERMINISTIC — cleanup-before-reboot ordering, no daemon
// ---------------------------------------------------------------------------

describe("rig-control (deterministic) — restart() ordering (the activeHandle double-start guard)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    delete process.env["COMIS_DATA_DIR"];
  });

  it("restart() awaits cleanup() BEFORE the boot (the activeHandle double-start guard ordering)", async () => {
    const { dataDir, memoryDbPath } = makeIsolatedDataDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    // Record call order: cleanup must resolve before bootFn is invoked.
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

    const { emulator } = makeFakeEmulator();
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

    // The load-bearing ordering: cleanup() resolved BEFORE boot was called.
    expect(order).toEqual(["cleanup", "boot"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    // boot re-pinned the SAME isolated data dir and was passed the recorded config/port.
    expect(bootFn).toHaveBeenCalledTimes(1);
    expect(bootFn).toHaveBeenCalledWith({ configPath: state.configPath, gatewayPort: 1 });
    // The controller swapped in the new handle; the emulator instance is preserved.
    expect(controller.daemonHandle).toBe(newHandle);
    expect(controller.emulator).toBe(emulator);
    // COMIS_DATA_DIR is restored (not leaked into sibling daemons) after the re-boot.
    expect(process.env["COMIS_DATA_DIR"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DETERMINISTIC — resetDeep() clean slate (isolated-dir-only) + the home guard
// ---------------------------------------------------------------------------

describe("rig-control (deterministic) — resetDeep() clean slate + the ~/.comis guard", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    delete process.env["COMIS_DATA_DIR"];
  });

  it("resetDeep() wipes ONLY the isolated dataDir (memory.db + wal/shm + logs + sessions), resets the emulator chat, then restarts", async () => {
    const { dataDir, memoryDbPath } = makeIsolatedDataDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const order: string[] = [];
    const cleanup = vi.fn(async () => {
      order.push("cleanup");
    });
    const oldHandle = { cleanup, gatewayUrl: "http://127.0.0.1:1", authToken: "t" } as unknown as TestDaemonHandle;
    const newHandle = { cleanup: vi.fn(async () => undefined), gatewayUrl: "http://127.0.0.1:1", authToken: "t" } as unknown as TestDaemonHandle;
    const bootFn = vi.fn(async () => {
      order.push("boot");
      return newHandle;
    }) as unknown as typeof startTestDaemon;

    const { emulator, resetChat } = makeFakeEmulator();
    const controller = createRigController(
      {
        emulator,
        daemonHandle: oldHandle,
        dataDir,
        configPath: join(dataDir, "config.rig.yaml"),
        gatewayPort: 1,
        gatewayUrl: "http://127.0.0.1:1",
        chat: TEST_CHAT,
        memoryDbPath,
      },
      bootFn,
    );

    // Pre-condition: the isolated state exists.
    expect(existsSync(memoryDbPath)).toBe(true);
    expect(existsSync(join(dataDir, "logs"))).toBe(true);
    expect(existsSync(join(dataDir, "workspace", "sessions"))).toBe(true);

    await controller.resetDeep();

    // The clean slate: memory.db (+ wal/shm), logs/, and workspace/sessions/ are gone.
    expect(existsSync(memoryDbPath)).toBe(false);
    expect(existsSync(`${memoryDbPath}-wal`)).toBe(false);
    expect(existsSync(`${memoryDbPath}-shm`)).toBe(false);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
    expect(existsSync(join(dataDir, "workspace", "sessions"))).toBe(false);
    // The data dir itself survives (we wipe UNDER it, never the dir — it is re-booted into).
    expect(existsSync(dataDir)).toBe(true);
    // The emulator chat was reset (channel-side clean slate).
    expect(resetChat).toHaveBeenCalledWith(TEST_CHAT);
    // And it restarted (cleanup → boot, the cleanup-before-reboot ordering, runs as part of resetDeep).
    expect(order).toEqual(["cleanup", "boot"]);
  });

  it("resetDeep() REFUSES a non-isolated dataDir (empty, or the operator's real ~/.comis) — the home-dir guard", async () => {
    const cleanup = vi.fn(async () => undefined);
    const handle = { cleanup, gatewayUrl: "http://127.0.0.1:1", authToken: "t" } as unknown as TestDaemonHandle;
    const bootFn = vi.fn(async () => handle) as unknown as typeof startTestDaemon;
    const { emulator } = makeFakeEmulator();

    const baseState = {
      emulator,
      daemonHandle: handle,
      configPath: "/tmp/x/config.rig.yaml",
      gatewayPort: 1,
      gatewayUrl: "http://127.0.0.1:1",
      chat: TEST_CHAT,
    };

    // Empty dataDir → refuse.
    const emptyCtl = createRigController({ ...baseState, dataDir: "", memoryDbPath: "" }, bootFn);
    await expect(emptyCtl.resetDeep()).rejects.toThrow(/refusing reset --deep|non-isolated/);

    // The real home ~/.comis → refuse (must never wipe operator state).
    const homeComis = join(homedir(), ".comis");
    const homeCtl = createRigController(
      { ...baseState, dataDir: homeComis, memoryDbPath: join(homeComis, "memory.db") },
      bootFn,
    );
    await expect(homeCtl.resetDeep()).rejects.toThrow(/refusing reset --deep|non-isolated/);

    // The guard short-circuits — neither cleanup nor boot ran (nothing was touched).
    expect(cleanup).not.toHaveBeenCalled();
    expect(bootFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DETERMINISTIC — reconfigure(overrides) rewrites the isolated YAML + restarts
// (AUTO-04, the model sweep) — no daemon, no network.
// ---------------------------------------------------------------------------

describe("rig-control (deterministic) — reconfigure(overrides) rewrites the isolated config then restarts", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    delete process.env["COMIS_DATA_DIR"];
  });

  it("reconfigure({'agents.default.model': <new>}) REWRITES state.configPath to name the new model, THEN restarts (cleanup→boot, same port)", async () => {
    const { dataDir, memoryDbPath } = makeIsolatedDataDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const configPath = join(dataDir, "config.rig.yaml");
    // Pre-seed the YAML with the OLD model (the file reconfigure must overwrite).
    writeFileSync(configPath, "model: old-model-0.0:1b\n", "utf-8");

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

    const { emulator } = makeFakeEmulator();
    // The injected config writer is the SINGLE override→YAML mapping seam (the real
    // launcher supplies one closing over buildConfigYaml + apiRoot + gatewayPort, so
    // rig-control never value-imports rig.ts — there is a rig.ts→rig-control.ts edge).
    const configYamlFor = vi.fn((overrides: Record<string, string>) => {
      const model = overrides["agents.default.model"] ?? "fallback";
      return `# rewritten\nmodel: "${model}"\nport: 1\n`;
    });
    const state: RigControlState = {
      emulator,
      daemonHandle: oldHandle,
      dataDir,
      configPath,
      gatewayPort: 1,
      gatewayUrl: "http://127.0.0.1:1",
      chat: TEST_CHAT,
      memoryDbPath,
      configYamlFor,
    };
    const controller = createRigController(state, bootFn);

    await controller.reconfigure({ "agents.default.model": "qwen3.6:14b" });

    // The writer was consulted with the overrides and the file was rewritten so it
    // names the NEW model (the model sweep) and no longer the old one.
    expect(configYamlFor).toHaveBeenCalledWith({ "agents.default.model": "qwen3.6:14b" });
    const rewritten = readFileSync(configPath, "utf-8");
    expect(rewritten).toContain("qwen3.6:14b");
    expect(rewritten).not.toContain("old-model-0.0:1b");
    // THEN it restarted: cleanup() ran BEFORE boot (the cleanup-before-reboot ordering), same port.
    expect(order).toEqual(["cleanup", "boot"]);
    expect(bootFn).toHaveBeenCalledWith({ configPath, gatewayPort: 1 });
    expect(controller.gatewayUrl).toBe("http://127.0.0.1:1");
  });

  it("reconfigure REFUSES on a controller with no configYamlFor writer (honest, never a silent no-op)", async () => {
    const { dataDir, memoryDbPath } = makeIsolatedDataDir();
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const cleanup = vi.fn(async () => undefined);
    const handle = { cleanup, gatewayUrl: "http://127.0.0.1:1", authToken: "t" } as unknown as TestDaemonHandle;
    const bootFn = vi.fn(async () => handle) as unknown as typeof startTestDaemon;
    const { emulator } = makeFakeEmulator();
    // NO configYamlFor → reconfigure cannot rewrite; it must throw, not no-op + boot.
    const controller = createRigController(
      {
        emulator,
        daemonHandle: handle,
        dataDir,
        configPath: join(dataDir, "config.rig.yaml"),
        gatewayPort: 1,
        gatewayUrl: "http://127.0.0.1:1",
        chat: TEST_CHAT,
        memoryDbPath,
      },
      bootFn,
    );
    await expect(
      controller.reconfigure({ "agents.default.model": "x" }),
    ).rejects.toThrow(/configYamlFor|reconfigure/);
    // The guard short-circuits — neither cleanup nor boot ran.
    expect(cleanup).not.toHaveBeenCalled();
    expect(bootFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LIVE — restart re-boots green (no deadlock), emulator preserved (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("rig-control Stage-C — restart() re-boots the isolated daemon (COMIS_LIVE)", () => {
  let built: BuiltRig | undefined;

  afterEach(async () => {
    if (built) await built.cleanup();
    built = undefined;
  });

  it("restart() re-boots without the double-start deadlock and preserves the emulator (a second /health passes)", async () => {
    // Boot a real isolated rig via the extracted internals factory, then drive it
    // through a controller (the same composition startStandaloneRig uses).
    built = await buildRig({ channel: "telegram", model: "keyless" });
    const controller = createRigController({
      emulator: built.emulator,
      daemonHandle: built.daemonHandle,
      dataDir: built.dataDir,
      configPath: built.configPath,
      gatewayPort: built.gatewayPort,
      gatewayUrl: built.gatewayUrl,
      chat: built.chat,
      memoryDbPath: built.memoryDbPath,
      // Keep the rig's cleanup pointed at the post-restart daemon (the holder), so
      // afterEach tears down the CURRENT daemon, never the stale pre-restart one.
      onDaemonHandle: built.rebindDaemonHandle,
    });

    const emulatorBefore = controller.emulator;
    const gatewayUrl = controller.gatewayUrl;

    // First /health is green (boot already awaited it).
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);

    // The cleanup-before-reboot proof: restart() does cleanup() (clears activeHandle) → re-pin
    // COMIS_DATA_DIR → startTestDaemon — WITHOUT throwing "Test daemon already running".
    await controller.restart();

    // Same port, a SECOND /health passes (no deadlock, the daemon re-booted).
    expect(controller.gatewayUrl).toBe(gatewayUrl);
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);
    // The emulator instance is PRESERVED across the re-boot.
    expect(controller.emulator).toBe(emulatorBefore);
    // afterEach's built.cleanup() tears down the post-restart daemon: restart()
    // called onDaemonHandle(newHandle) → the rig's cleanup holder now points at it.
  });
});
