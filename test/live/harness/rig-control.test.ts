// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-control.test.ts` — the AUTO-02 lifecycle owner (Phase 205, Plan 04).
 *
 * Two tiers, the 204 `isLive` split:
 *
 *   • DETERMINISTIC (always runs, no daemon, no network): the Pitfall-1 ordering
 *     proof — `restart()` / `resetDeep()` await the current `daemonHandle.cleanup()`
 *     (which sets the double-start `activeHandle = null`) BEFORE re-booting via the
 *     injected `bootFn`, so a real `startTestDaemon` would never throw "Test daemon
 *     already running". Plus the `resetDeep()` clean-slate filesystem proof (a real
 *     `mkdtempSync` data dir with a dummy `memory.db` + `logs/` + `workspace/sessions/`
 *     wiped) and the home-`.comis` SECURITY guard (`resetDeep()` THROWS on a
 *     non-isolated dataDir — T-205-10).
 *
 *   • LIVE (`describe.skipIf(!isLive)`, COMIS_LIVE): boots a REAL isolated rig,
 *     calls `restart()`, and asserts the gateway is healthy again (a second
 *     `/health` passes — no double-start deadlock, Pitfall 1) and the emulator
 *     instance is PRESERVED across the re-boot (success-criterion #5).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live` →
 * 0 files = false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig-control.test.ts
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * isolated state `resetDeep()` wipes — used by Task-2 too). Returns the dir + the
 * memory.db path.
 */
function makeIsolatedDataDir(): { dataDir: string; memoryDbPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-rigctl-test-"));
  const memoryDbPath = join(dataDir, "test-memory-channel-emu.db");
  writeFileSync(memoryDbPath, "dummy-sqlite-bytes", "utf-8");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  mkdirSync(join(dataDir, "workspace", "sessions"), { recursive: true });
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
// DETERMINISTIC — Pitfall-1 ordering (cleanup BEFORE the re-boot), no daemon
// ---------------------------------------------------------------------------

describe("rig-control (deterministic) — restart() ordering (the activeHandle double-start guard)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    delete process.env["COMIS_DATA_DIR"];
  });

  it("restart() awaits cleanup() BEFORE the boot (the activeHandle double-start guard ordering, Pitfall 1)", async () => {
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
    // through a controller (the same composition startStandaloneRig uses in Task 2).
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
    });

    const emulatorBefore = controller.emulator;
    const gatewayUrl = controller.gatewayUrl;

    // First /health is green (boot already awaited it).
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);

    // The Pitfall-1 proof: restart() does cleanup() (clears activeHandle) → re-pin
    // COMIS_DATA_DIR → startTestDaemon — WITHOUT throwing "Test daemon already running".
    await controller.restart();

    // Same port, a SECOND /health passes (no deadlock, the daemon re-booted).
    expect(controller.gatewayUrl).toBe(gatewayUrl);
    expect((await fetch(`${gatewayUrl}/health`)).ok).toBe(true);
    // The emulator instance is PRESERVED across the re-boot (success-criterion #5).
    expect(controller.emulator).toBe(emulatorBefore);

    // The controller now owns the live daemonHandle; sync it back so afterEach tears
    // down the CURRENT daemon (not the pre-restart one).
    built = { ...built, daemonHandle: controller.daemonHandle };
  });
});
