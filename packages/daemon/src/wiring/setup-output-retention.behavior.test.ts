// SPDX-License-Identifier: Apache-2.0
//
// Output retention housekeeper behavior tests.
//
// These tests exercise the actual housekeeper behavior beyond the
// signature checks in setup-output-retention.test.ts:
//   - per-class retention: files older than class.retentionMs are deleted;
//     younger files preserved.
//   - disk usage trends down on a synthetic load (size sum decreases).
//   - "default" class fallback for unknown subdirectory names.
//   - shutdown() clears the recurring interval (idempotent).
//   - enabled: false → no interval started; shutdown() is still callable.
//   - validator: rejects retentionMs <= 0; accepts >= 1; fractional rejected.
//
// Co-located unit test pattern (AGENTS §2.5): no real network, no real
// daemon — synthetic tmpdir with files at known mtimes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupOutputRetention,
  validateOutputRetentionConfig,
} from "./setup-output-retention.js";
import type { OutputRetentionConfig } from "@comis/core";

// Minimal logger shim. Per AGENTS §2.4 we never import @comis/infra at runtime
// in the SUT; tests build a hand-typed mock matching the methods the SUT calls.
function makeLogger(): {
  child: () => ReturnType<typeof makeChild>;
} {
  return {
    child: () => makeChild(),
  };
}
function makeChild(): {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  child: () => ReturnType<typeof makeChild>;
} {
  return {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    child: () => makeChild(),
  };
}

function makeConfig(
  overrides: Partial<OutputRetentionConfig> = {},
): OutputRetentionConfig {
  return {
    enabled: true,
    intervalMs: 3_600_000,
    classes: {
      attachment: { retentionMs: 1_000 },
      chart: { retentionMs: 10_000 },
      default: { retentionMs: 5_000 },
    },
    ...overrides,
  };
}

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "comis-output-retention-test-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** Helper: create a file under output/<className>/<file> with a backdated mtime. */
function makeFile(className: string, name: string, ageMs: number, sizeBytes = 1024): string {
  const classDir = join(workspaceDir, "output", className);
  mkdirSync(classDir, { recursive: true });
  const filePath = join(classDir, name);
  writeFileSync(filePath, "x".repeat(sizeBytes));
  const past = Date.now() - ageMs;
  utimesSync(filePath, past / 1000, past / 1000);
  return filePath;
}

describe("Phase 10 housekeeper: per-class retention behavior (R8, AC-11)", () => {
  it("deletes files older than the class's retentionMs; preserves younger ones", async () => {
    // attachment retentionMs=1_000. Old=2_000ms (deleted); young=500ms (kept).
    const oldAttachment = makeFile("attachment", "old.png", 2_000);
    const youngAttachment = makeFile("attachment", "young.png", 500);
    // chart retentionMs=10_000. Old=15_000 (deleted); young=5_000 (kept).
    const oldChart = makeFile("chart", "old.svg", 15_000);
    const youngChart = makeFile("chart", "young.svg", 5_000);

    const handle = setupOutputRetention({
      config: makeConfig(),
      workspaceDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });

    const result = await handle.runOnePass();

    expect(existsSync(oldAttachment)).toBe(false);
    expect(existsSync(youngAttachment)).toBe(true);
    expect(existsSync(oldChart)).toBe(false);
    expect(existsSync(youngChart)).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(0);

    handle.shutdown();
  });

  it("disk usage trends down on a synthetic load", async () => {
    // 5 files at varying ages. 3 expired, 2 kept.
    makeFile("attachment", "a1.png", 5_000, 4096);
    makeFile("attachment", "a2.png", 3_000, 4096);
    makeFile("chart", "c1.svg", 20_000, 8192);
    makeFile("attachment", "young1.png", 100, 4096);
    makeFile("chart", "young2.svg", 1_000, 8192);

    const beforeSize =
      statSync(join(workspaceDir, "output", "attachment", "a1.png")).size +
      statSync(join(workspaceDir, "output", "attachment", "a2.png")).size +
      statSync(join(workspaceDir, "output", "chart", "c1.svg")).size +
      statSync(join(workspaceDir, "output", "attachment", "young1.png")).size +
      statSync(join(workspaceDir, "output", "chart", "young2.svg")).size;

    const handle = setupOutputRetention({
      config: makeConfig(),
      workspaceDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });

    const result = await handle.runOnePass();

    // After housekeeper: only the 2 young files remain.
    expect(existsSync(join(workspaceDir, "output", "attachment", "young1.png"))).toBe(
      true,
    );
    expect(existsSync(join(workspaceDir, "output", "chart", "young2.svg"))).toBe(true);

    const afterSize =
      statSync(join(workspaceDir, "output", "attachment", "young1.png")).size +
      statSync(join(workspaceDir, "output", "chart", "young2.svg")).size;

    expect(afterSize).toBeLessThan(beforeSize);
    expect(result.deleted).toBe(3);
    // bytesFreed reflects the 3 deleted files (4096 + 4096 + 8192 = 16384).
    expect(result.bytesFreed).toBe(16_384);

    handle.shutdown();
  });

  it("uses the 'default' class fallback for unknown subdirectory names", async () => {
    // "default" retentionMs=5_000. Unknown subdir "transcripts" age=10_000 (expired).
    const expired = makeFile("transcripts", "old.txt", 10_000);
    const young = makeFile("transcripts", "young.txt", 1_000);

    const handle = setupOutputRetention({
      config: makeConfig(),
      workspaceDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });
    const result = await handle.runOnePass();

    expect(existsSync(expired)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(result.deleted).toBe(1);

    handle.shutdown();
  });

  it("returns { deleted: 0, bytesFreed: 0 } when output/ is missing", async () => {
    const handle = setupOutputRetention({
      config: makeConfig(),
      workspaceDir, // No output/ dir created.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });
    const result = await handle.runOnePass();
    expect(result.deleted).toBe(0);
    expect(result.bytesFreed).toBe(0);

    handle.shutdown();
  });

  it("skips subdirectories inside a class dir (only deletes leaf files)", async () => {
    const classDir = join(workspaceDir, "output", "attachment");
    mkdirSync(classDir, { recursive: true });
    // Add a nested directory.
    mkdirSync(join(classDir, "nested"), { recursive: true });
    // Add an old leaf file at top-level.
    const oldFile = makeFile("attachment", "leaf.png", 5_000);

    const handle = setupOutputRetention({
      config: makeConfig(),
      workspaceDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });

    const result = await handle.runOnePass();

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(classDir, "nested"))).toBe(true); // subdir preserved
    expect(result.deleted).toBe(1);

    handle.shutdown();
  });

  it("when enabled: false, shutdown() is callable and runOnePass still works (manual trigger)", async () => {
    const oldFile = makeFile("attachment", "old.png", 5_000);
    const handle = setupOutputRetention({
      config: makeConfig({ enabled: false }),
      workspaceDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });

    // Manual trigger still works (operator can run a one-shot housekeeper pass).
    const result = await handle.runOnePass();
    expect(existsSync(oldFile)).toBe(false);
    expect(result.deleted).toBe(1);

    // shutdown() is idempotent and harmless when no interval was started.
    handle.shutdown();
    handle.shutdown();
  });

  it("shutdown() is idempotent (multiple calls clear the interval once)", () => {
    const handle = setupOutputRetention({
      config: makeConfig(),
      workspaceDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal logger shim
      logger: makeLogger() as any,
    });
    handle.shutdown();
    handle.shutdown(); // second call should not throw
  });
});

describe("Phase 10 validator: validateOutputRetentionConfig (15-01 contract)", () => {
  it("accepts retentionMs >= 1", () => {
    const r = validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: 1 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.classes).toEqual([{ classId: "attachment", retentionMs: 1 }]);
    }
  });

  it("rejects retentionMs = 0", () => {
    const r = validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: 0 }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects retentionMs = -1", () => {
    const r = validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: -1 }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects fractional retentionMs", () => {
    const r = validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: 1.5 }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects empty classId", () => {
    const r = validateOutputRetentionConfig({
      classes: [{ classId: "", retentionMs: 1000 }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-array classes", () => {
    const r = validateOutputRetentionConfig({ classes: { foo: "bar" } });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateOutputRetentionConfig(null).ok).toBe(false);
    expect(validateOutputRetentionConfig(42).ok).toBe(false);
    expect(validateOutputRetentionConfig("config").ok).toBe(false);
  });
});
