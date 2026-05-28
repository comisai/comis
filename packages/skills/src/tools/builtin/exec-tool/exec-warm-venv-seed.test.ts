// SPDX-License-Identifier: Apache-2.0
/**
 * R7.3 regression tests — warm-venv requests seed for non-Docker hosts.
 *
 * ensureWarmVenvSeed:
 *  - On first init (venv exists, no sentinel): writes sentinel + spawns pip
 *  - warmVenvSeed: [] → no pip spawned
 *  - Sentinel already present → no pip spawned (idempotent)
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", output: [], pid: 1, signal: null }),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureWarmVenvSeed } from "./exec-shared.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempWorkspace(): string {
  const dir = join(tmpdir(), `comis-test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "venv", "bin"), { recursive: true });
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ensureWarmVenvSeed", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeTempWorkspace();
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      output: [],
      pid: 1,
      signal: null,
    } as ReturnType<typeof spawnSync>);
  });

  afterEach(() => {
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("ensureWarmVenv seeds requests into venv on first init (non-Docker, warmVenvSeed default)", async () => {
    // venv/bin exists but no sentinel yet — first init
    expect(existsSync(join(workspaceDir, "venv", ".seed-done"))).toBe(false);

    await ensureWarmVenvSeed(workspaceDir, ["requests==2.32.3"]);

    // Sentinel should now exist
    expect(existsSync(join(workspaceDir, "venv", ".seed-done"))).toBe(true);
    // pip subprocess should have been spawned with install + package names
    expect(spawnSync).toHaveBeenCalledOnce();
    const [pipBin, pipArgs] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(String(pipBin)).toMatch(/venv[\\/]bin[\\/]pip/);
    expect(pipArgs).toEqual(["install", "--quiet", "requests==2.32.3"]);
  });

  it("ensureWarmVenv skips seed when warmVenvSeed is empty", async () => {
    await ensureWarmVenvSeed(workspaceDir, []);

    // No sentinel written
    expect(existsSync(join(workspaceDir, "venv", ".seed-done"))).toBe(false);
    // No pip subprocess spawned
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("ensureWarmVenv skips seed when sentinel already exists", async () => {
    // Pre-create the sentinel
    writeFileSync(join(workspaceDir, "venv", ".seed-done"), "2026-01-01T00:00:00Z");

    await ensureWarmVenvSeed(workspaceDir, ["requests==2.32.3"]);

    // pip must NOT be spawned again (idempotent)
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
