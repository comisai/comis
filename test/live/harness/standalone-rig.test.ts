// SPDX-License-Identifier: Apache-2.0
/**
 * `standalone-rig.test.ts` — the CLI-01 discover-or-spawn launcher
 * (`startStandaloneRig`).
 *
 * Two tiers, split by `isLive`:
 *
 *   • DETERMINISTIC (always runs, no daemon, no network): the discover-or-spawn
 *     DECISION via injected `probeFn` / `spawnFn` seams —
 *       - a recorded handle whose `/health` probes TRUE → `{ reused: true }`,
 *         the spawn function NEVER called (no second daemon over a healthy one);
 *       - no handle (or a dead one whose probe is FALSE) → SPAWNS, and the 0600
 *         handle file is written (`writeHandle`).
 *
 *   • LIVE (`describe.skipIf(!isLive)`, COMIS_LIVE): a REAL spawn — boots an
 *     isolated rig, writes the handle, then a SECOND `startStandaloneRig` reuses
 *     it (`reused: true`, no second daemon).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live` →
 * 0 files = false green):
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/harness/standalone-rig.test.ts
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startStandaloneRig,
  type BuiltRig,
  type DetachedRigHandle,
} from "./rig.js";
import { writeHandle, readHandle, handlePath, type ChanliveHandle } from "./chanlive-handle.js";

const isLive = !!process.env["COMIS_LIVE"];

/** A recorded handle for the discover path (the endpoints are throwaway loopback ports). */
function makeHandle(baseDir: string): ChanliveHandle {
  return {
    channel: "telegram",
    controlEndpoint: "http://127.0.0.1:1",
    rigControlEndpoint: "http://127.0.0.1:2",
    gatewayUrl: "http://127.0.0.1:3",
    gatewayToken: "test-secret-key-for-integration-tests",
    chatId: 424242,
    dataDir: join(baseDir, "data"),
    memoryDbPath: join(baseDir, "data", "test-memory-channel-emu.db"),
  };
}

// ---------------------------------------------------------------------------
// DETERMINISTIC — the discover-or-spawn decision (injected probe + spawn)
// ---------------------------------------------------------------------------

describe("startStandaloneRig (deterministic) — discover-or-spawn decision", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("REUSES a healthy recorded rig (probe TRUE) and NEVER spawns a second daemon", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "comis-standalone-test-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));

    // Record a handle, then make its probe report healthy.
    const handle = makeHandle(baseDir);
    writeHandle(handle, baseDir);
    const probeFn = vi.fn(async () => true);
    const spawnFn = vi.fn(async (): Promise<BuiltRig> => {
      throw new Error("spawnFn must NOT be called when a healthy rig is discovered");
    });

    const res = await startStandaloneRig(
      { channel: "telegram", model: "keyless", baseDir },
      { probeFn, spawnFn: spawnFn as unknown as typeof import("./rig.js").buildRig },
    );

    expect(res.reused).toBe(true);
    expect(res.handle.gatewayUrl).toBe(handle.gatewayUrl);
    // The discover path probed the recorded gateway and DID NOT spawn.
    expect(probeFn).toHaveBeenCalledWith(handle.gatewayUrl);
    expect(spawnFn).not.toHaveBeenCalled();
    // No controller / cleanup on a reuse (we don't own the rig we reused).
    expect(res.controller).toBeUndefined();
  });

  it("SPAWNS when no healthy rig exists (no handle) and writes the 0600 handle file", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "comis-standalone-test-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));

    // No handle on disk → discover finds nothing → spawn. The spawnFn returns a
    // fake BuiltRig whose fields populate the written handle.
    const fakeBuilt = makeFakeBuiltRig(baseDir);
    const probeFn = vi.fn(async () => false);
    const spawnFn = vi.fn(async () => fakeBuilt) as unknown as typeof import("./rig.js").buildRig;

    const res = await startStandaloneRig(
      { channel: "telegram", model: "keyless", baseDir },
      { probeFn, spawnFn },
    );

    expect(res.reused).toBe(false);
    expect(res.controller).toBeDefined();
    expect(res.cleanup).toBeDefined();

    // The 0600 handle file was written from the spawned rig's internals.
    const path = handlePath("telegram", baseDir);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const written = readHandle("telegram", baseDir);
    expect(written?.gatewayUrl).toBe(fakeBuilt.gatewayUrl);
    expect(written?.gatewayToken).toBe(fakeBuilt.authToken);
    expect(written?.dataDir).toBe(fakeBuilt.dataDir);
    expect(written?.memoryDbPath).toBe(fakeBuilt.memoryDbPath);
    expect(written?.chatId).toBe(fakeBuilt.chat.chatId);

    // The cleanup tears the rig down AND removes the handle file.
    await res.cleanup!();
    expect(fakeBuilt.cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  });

  it("SPAWNS when the recorded handle is DEAD (probe FALSE) — an unhealthy rig is not reused", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "comis-standalone-test-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));

    // A stale handle exists but its gateway is dead (probe FALSE) → must spawn.
    writeHandle(makeHandle(baseDir), baseDir);
    const fakeBuilt = makeFakeBuiltRig(baseDir);
    const probeFn = vi.fn(async () => false);
    const spawnFn = vi.fn(async () => fakeBuilt) as unknown as typeof import("./rig.js").buildRig;

    const res = await startStandaloneRig(
      { channel: "telegram", model: "keyless", baseDir },
      { probeFn, spawnFn },
    );

    expect(res.reused).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    await res.cleanup!();
  });

  // -------------------------------------------------------------------------
  // DETACHED MODE — the cold-shell cross-process rig.
  //
  // When `detached: true`, the launcher spawns a DETACHED subprocess
  // (`rig-daemon.ts`) that OUTLIVES the launching process, and records a handle
  // carrying a real `pid` + a rig-control HTTP `rigControlEndpoint` (≠ gateway
  // URL). The spawn is injected here so the DECISION + the handle SHAPE are
  // proven deterministically with no real subprocess. The real cross-process
  // boot is the COMIS_LIVE leg (telegram-cold-shell.test.ts).
  // -------------------------------------------------------------------------

  it("DETACHED spawn records a handle with a real pid + a rigControlEndpoint DISTINCT from the gateway URL (the cross-process surface)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "comis-standalone-detached-"));
    cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));

    // A detached subprocess result: a real pid + a rig-control endpoint that is
    // NOT the gateway URL (the dedicated cold-shell control surface).
    const detached: DetachedRigHandle = {
      pid: 987654,
      gatewayUrl: "http://127.0.0.1:50100",
      gatewayToken: "test-secret-key-for-integration-tests",
      controlEndpoint: "http://127.0.0.1:50101",
      rigControlEndpoint: "http://127.0.0.1:50102",
      chatId: 424242,
      dataDir: join(baseDir, "data"),
      memoryDbPath: join(baseDir, "data", "test-memory-channel-emu.db"),
      cleanup: vi.fn(async () => undefined),
    };
    const spawnDetachedFn = vi.fn(async () => detached);
    // probe FALSE so the launcher does not short-circuit on a (nonexistent) reuse.
    const probeFn = vi.fn(async () => false);

    const res = await startStandaloneRig(
      { channel: "telegram", model: "keyless", baseDir, detached: true },
      { probeFn, spawnDetachedFn },
    );

    // A detached spawn happened (NOT the in-process buildRig path).
    expect(spawnDetachedFn).toHaveBeenCalledTimes(1);
    expect(res.reused).toBe(false);

    // The recorded handle carries the real pid + the rig-control endpoint.
    const written = readHandle("telegram", baseDir);
    expect(written?.pid).toBe(detached.pid);
    // The cold-shell control surface is a DEDICATED endpoint, NOT the gateway URL
    // (the in-process spine sets rigControlEndpoint = the gateway anchor; the
    // detached rig advertises a real cross-process control surface instead).
    expect(written?.rigControlEndpoint).toBe(detached.rigControlEndpoint);
    expect(written?.rigControlEndpoint).not.toBe(written?.gatewayUrl);

    // cleanup tears the detached rig down (SIGTERM the child) AND removes the handle.
    const path = handlePath("telegram", baseDir);
    expect(existsSync(path)).toBe(true);
    await res.cleanup!();
    expect(detached.cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  });
});

/** A fake {@link BuiltRig} for the spawn path — only the fields the launcher reads + cleanup. */
function makeFakeBuiltRig(baseDir: string): BuiltRig & { cleanup: ReturnType<typeof vi.fn> } {
  const dataDir = join(baseDir, "data");
  const cleanup = vi.fn(async () => undefined);
  return {
    emulator: { resetChat: vi.fn() } as never,
    controlClient: { apiRoot: "http://127.0.0.1:8" } as never,
    chat: { chatId: 424242 },
    gatewayUrl: "http://127.0.0.1:9",
    authToken: "test-secret-key-for-integration-tests",
    controlEndpoint: "http://127.0.0.1:8",
    dataDir,
    configDir: join(baseDir, "cfg"),
    configPath: join(baseDir, "cfg", "config.rig.yaml"),
    gatewayPort: 9,
    daemonHandle: { cleanup: vi.fn(async () => undefined) } as never,
    memoryDbPath: join(dataDir, "test-memory-channel-emu.db"),
    rebindDaemonHandle: vi.fn(),
    send: vi.fn(async () => 1),
    waitForReply: vi.fn(async () => undefined),
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// LIVE — a real spawn, then a real reuse (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("startStandaloneRig Stage-C — real spawn then reuse (COMIS_LIVE)", () => {
  let baseDir: string | undefined;
  let spawned: Awaited<ReturnType<typeof startStandaloneRig>> | undefined;

  afterEach(async () => {
    if (spawned?.cleanup) await spawned.cleanup();
    spawned = undefined;
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = undefined;
  });

  it("spawns a real rig (writes the handle), then a second call REUSES it (no second daemon)", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "comis-standalone-live-"));

    // First call: no handle → real spawn (boots an isolated daemon).
    spawned = await startStandaloneRig({ channel: "telegram", model: "keyless", baseDir });
    expect(spawned.reused).toBe(false);
    expect(existsSync(handlePath("telegram", baseDir))).toBe(true);
    // The spawned gateway is healthy.
    expect((await fetch(`${spawned.handle.gatewayUrl}/health`)).ok).toBe(true);

    // Second call: the recorded rig is healthy → REUSE (no second daemon booted).
    const reused = await startStandaloneRig({ channel: "telegram", model: "keyless", baseDir });
    expect(reused.reused).toBe(true);
    expect(reused.handle.gatewayUrl).toBe(spawned.handle.gatewayUrl);
    expect(reused.controller).toBeUndefined();
  });
});
