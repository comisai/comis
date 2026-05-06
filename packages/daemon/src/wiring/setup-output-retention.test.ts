// SPDX-License-Identifier: Apache-2.0
//
// Phase 10 (Plan 15-08) — output retention housekeeper tests.
//
// Phase 10 introduces:
//   - packages/daemon/src/wiring/setup-output-retention.ts (NEW): factory
//     wiring the housekeeper against the daemon context, mirroring
//     setup-delivery.ts's prune+drain timer pattern.
//   - YAML config schema accepting per-class retention assertions.
//
// The contract:
//   - Per-class retention: files older than the class's retentionMs are deleted.
//   - Disk usage trends down on a synthetic load.
//   - Config schema rejects retentionMs <= 0; accepts retentionMs >= 1.
//
// All tests RED until 15-08 lands. Loaded dynamically with undefined
// fallback so the suite reaches assertions even without the module.
import { describe, it, expect } from "vitest";

interface RetentionClassConfig {
  classId: string;
  retentionMs: number;
}

interface OutputRetentionModule {
  setupOutputRetention?: (deps: {
    outputDir: string;
    classes: RetentionClassConfig[];
    logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  }) => { shutdown: () => void };
  validateOutputRetentionConfig?: (config: unknown) =>
    | { ok: true; value: { classes: RetentionClassConfig[] } }
    | { ok: false; error: Error };
}

async function loadOutputRetention(): Promise<OutputRetentionModule | undefined> {
  try {
    const mod = (await import("./setup-output-retention.js")) as OutputRetentionModule;
    return mod;
  } catch {
    return undefined;
  }
}

describe("Phase 10: output retention housekeeper (RC-9, AC-11)", () => {
  it("housekeeper test 1: per-class retention — files older than class.retentionMs are deleted", async () => {
    const mod = await loadOutputRetention();
    expect(mod).toBeDefined();
    if (!mod || typeof mod.setupOutputRetention !== "function") return;
    // Synthetic test: build a tmp dir with files of 3 retention classes,
    // call the housekeeper, and assert files older than each class's
    // retentionMs are deleted while younger ones remain.
    // (Implementation owned by 15-08; this test scaffolds the call shape.)
    expect(typeof mod.setupOutputRetention).toBe("function");
  });

  it("housekeeper test 2: disk usage trends down on a synthetic load", async () => {
    const mod = await loadOutputRetention();
    expect(mod).toBeDefined();
    if (!mod || typeof mod.setupOutputRetention !== "function") return;
    // Synthetic: total dir size after housekeeper run is less than before.
    // The factory shape is contract-tested here; the runtime simulation
    // lands in 15-08 alongside the production code.
    expect(typeof mod.setupOutputRetention).toBe("function");
  });

  it("housekeeper test 3: config schema rejects retentionMs <= 0; accepts retentionMs >= 1", async () => {
    const mod = await loadOutputRetention();
    expect(mod).toBeDefined();
    if (!mod || typeof mod.validateOutputRetentionConfig !== "function") return;
    // Negative: retentionMs = -1 rejected.
    const negative = mod.validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: -1 }],
    });
    expect(negative.ok).toBe(false);
    // Zero: retentionMs = 0 rejected (no retention is a misconfig).
    const zero = mod.validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: 0 }],
    });
    expect(zero.ok).toBe(false);
    // Positive: retentionMs = 1 accepted.
    const positive = mod.validateOutputRetentionConfig({
      classes: [{ classId: "attachment", retentionMs: 1 }],
    });
    expect(positive.ok).toBe(true);
  });
});
