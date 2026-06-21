// SPDX-License-Identifier: Apache-2.0
/**
 * `rig-control.ts` — the AUTO-02 isolated-daemon LIFECYCLE OWNER (Phase 205,
 * Plan 04). `createRigController(state, bootFn?)` returns a controller over the
 * rig's isolated daemon + its throwaway `COMIS_DATA_DIR`, exposing:
 *
 *   • `restart()` — re-boot the isolated daemon PRESERVING the emulator + handle.
 *     The EXACT cleanup-before-reboot ordering (Pitfall 1, the deadlock trap):
 *     `startTestDaemon` THROWS "Test daemon already running" if a second boot
 *     starts before the first `cleanup()` resets the `activeHandle` double-start
 *     guard to `null`. So `restart()` MUST: `await daemonHandle.cleanup()` (which
 *     clears the guard) → re-pin `COMIS_DATA_DIR` to the SAME isolated dir
 *     (Pitfall 2) → re-`startTestDaemon({ configPath, gatewayPort })` → restore
 *     `COMIS_DATA_DIR`. The injected `bootFn` (default `startTestDaemon`) makes
 *     the ordering deterministically unit-testable.
 *
 *   • `resetDeep()` — a one-call deterministic CLEAN SLATE, isolated-dir-only
 *     (added in this plan's Task 2; guarded against the operator's real
 *     `~/.comis`).
 *
 * SECURITY POSTURE — this is the most powerful test-only surface (stop / reset /
 * restart the daemon + mutate its data dir). It is in-process here; when fronted
 * by an HTTP endpoint (Plan 05) it binds 127.0.0.1 ONLY and is owner-checked, and
 * every destructive op is scoped UNDER the recorded throwaway `dataDir` — never a
 * real `~/.comis` (the `resetDeep()` home-dir guard, T-205-10).
 *
 * TEST-HARNESS — lives under the test tree, never the packages source-tree; ZERO
 * production code change. `test/` is outside every packages source-tree ESLint /
 * architecture rule, so `node:fs` / `process.env` are fine here.
 *
 * Run the unit tests under the LIVE vitest config (the bare root config excludes
 * `test/live` → 0 files = false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/rig-control.test.ts
 *
 * @module
 */

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startTestDaemon, type TestDaemonHandle } from "../../support/daemon-harness.js";
import type { TgEmulator, ChatRef } from "../emulators/telegram/tg-emulator.js";

/**
 * The state a {@link RigController} owns — everything `restart()`/`resetDeep()`
 * need to re-boot the isolated daemon and mutate ONLY its throwaway data dir.
 * The standalone launcher (`rig.ts`) fills this from the {@link import("./rig.js").BuiltRig}
 * internals.
 */
export interface RigControlState {
  /** The running emulator — PRESERVED across `restart()` (never stopped). */
  readonly emulator: TgEmulator;
  /** The current live daemon handle (its `cleanup()` clears the `activeHandle` guard). */
  daemonHandle: TestDaemonHandle;
  /** The throwaway `COMIS_DATA_DIR` — the dir `resetDeep()` wipes UNDER, never `~/.comis`. */
  readonly dataDir: string;
  /** The throwaway YAML config path, re-passed to `startTestDaemon` on re-boot. */
  readonly configPath: string;
  /** The gateway port, kept fixed across re-boots so the handle URL is stable. */
  readonly gatewayPort: number;
  /** The gateway base URL (`http://127.0.0.1:<G>`) — unchanged across `restart()`. */
  readonly gatewayUrl: string;
  /** The fixed test chat the clean slate resets (`emulator.resetChat`). */
  readonly chat: ChatRef;
  /** `<dataDir>/<memory.dbPath>` — the isolated `memory.db` `resetDeep()` replaces. */
  readonly memoryDbPath: string;
  /**
   * Optional re-bind hook — called with the NEW handle after every re-boot so the
   * owning rig's `cleanup()` tears down the CURRENT daemon, never the stale
   * pre-restart one (wired to `BuiltRig.rebindDaemonHandle`).
   */
  readonly onDaemonHandle?: (next: TestDaemonHandle) => void;
}

/**
 * The isolated-daemon lifecycle controller (AUTO-02). `restart()` re-boots
 * preserving the emulator + handle; `resetDeep()` (Task 2) is a one-call clean
 * slate scoped to the isolated dir.
 */
export interface RigController {
  /** The PRESERVED emulator instance (identical across `restart()`). */
  readonly emulator: TgEmulator;
  /** The CURRENT live daemon handle (swapped on each `restart()`). */
  readonly daemonHandle: TestDaemonHandle;
  /** The gateway base URL (stable across `restart()` — same port). */
  readonly gatewayUrl: string;
  /**
   * Re-boot the isolated daemon WITHOUT the double-start deadlock (Pitfall 1):
   * `await cleanup()` → re-pin `COMIS_DATA_DIR` → re-`startTestDaemon` → restore
   * env. The emulator + handle are preserved.
   */
  restart(): Promise<void>;
  /**
   * One-call deterministic CLEAN SLATE, scoped to the isolated `dataDir`: stop the
   * daemon (`cleanup()`) → delete `memory.db` (+ `-wal`/`-shm`) + wipe `logs/` and
   * `workspace/sessions/` UNDER `dataDir` → `emulator.resetChat(chat)` → `restart()`.
   *
   * SECURITY: REFUSES (throws) when `dataDir` is empty or equals the operator's
   * real `~/.comis` — a misconfigured controller must never wipe real state
   * (T-205-10). Every `rmSync` path is composed under the recorded `dataDir`.
   */
  resetDeep(): Promise<void>;
}

/** The boot function shape — `startTestDaemon`, injectable for the ordering unit. */
type BootFn = typeof startTestDaemon;

/**
 * Create the isolated-daemon lifecycle controller. `bootFn` defaults to the real
 * `startTestDaemon`; the ordering unit injects a spy so the cleanup-before-reboot
 * sequence is asserted with no real daemon.
 */
export function createRigController(state: RigControlState, bootFn: BootFn = startTestDaemon): RigController {
  // The controller mutates `daemonHandle` in place (the current live handle).
  const controller: RigController = {
    get emulator(): TgEmulator {
      return state.emulator;
    },
    get daemonHandle(): TestDaemonHandle {
      return state.daemonHandle;
    },
    get gatewayUrl(): string {
      return state.gatewayUrl;
    },

    async restart(): Promise<void> {
      // Pitfall 1 — the EXACT cleanup-before-reboot ordering. cleanup() runs the
      // shutdown + settle delay + WAL cleanup and, in its finally, deletes
      // COMIS_CONFIG_PATHS and sets activeHandle = null. ONLY after that can a
      // second startTestDaemon boot without throwing "Test daemon already running".
      await state.daemonHandle.cleanup();
      // Re-boot into the same isolated dir (re-pin COMIS_DATA_DIR — Pitfall 2 —
      // boot, restore env, rebind). The daemon is already down from cleanup().
      await rebootCleanIsolatedDir();
    },

    async resetDeep(): Promise<void> {
      // SECURITY (T-205-10) — refuse a non-isolated dataDir BEFORE touching the
      // filesystem or the daemon. An empty dir or the operator's real ~/.comis
      // would have its memory.db / logs / sessions wiped — never allowed.
      if (state.dataDir === "" || state.dataDir === join(homedir(), ".comis")) {
        throw new Error(
          `rig-control: refusing reset --deep on a non-isolated dataDir "${state.dataDir}" ` +
            "(empty or the operator's ~/.comis)",
        );
      }

      // 1. Stop the daemon first (releases the SQLite/WAL handles + the lock).
      await state.daemonHandle.cleanup();

      // 2. Wipe the isolated state — memory.db (+ wal/shm) and the logs/ +
      //    workspace/sessions/ trees, ALL composed under the recorded dataDir.
      for (const f of [state.memoryDbPath, `${state.memoryDbPath}-wal`, `${state.memoryDbPath}-shm`]) {
        rmSync(f, { force: true });
      }
      rmSync(join(state.dataDir, "logs"), { recursive: true, force: true });
      rmSync(join(state.dataDir, "workspace", "sessions"), { recursive: true, force: true });

      // 3. Reset the channel-side oracle (the emulator's recorded chat state).
      state.emulator.resetChat(state.chat);

      // 4. Re-boot into the now-clean isolated dir (the Pitfall-1 ordering — but
      //    cleanup() already ran above, so restart() must NOT cleanup() twice).
      await rebootCleanIsolatedDir();
    },
  };

  /**
   * Re-boot the daemon into the (already-cleaned) isolated dir — the second half
   * of `restart()` WITHOUT a fresh `cleanup()` (resetDeep already stopped the
   * daemon). Re-pins `COMIS_DATA_DIR` (Pitfall 2), boots, restores env, rebinds.
   */
  async function rebootCleanIsolatedDir(): Promise<void> {
    const hadDataDirEnv = process.env["COMIS_DATA_DIR"] !== undefined;
    const priorDataDir = process.env["COMIS_DATA_DIR"];
    process.env["COMIS_DATA_DIR"] = state.dataDir;
    try {
      state.daemonHandle = await bootFn({
        configPath: state.configPath,
        gatewayPort: state.gatewayPort,
      });
    } finally {
      if (hadDataDirEnv) process.env["COMIS_DATA_DIR"] = priorDataDir;
      else delete process.env["COMIS_DATA_DIR"];
    }
    state.onDaemonHandle?.(state.daemonHandle);
  }

  return controller;
}
