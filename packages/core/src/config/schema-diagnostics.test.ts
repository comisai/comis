// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { DiagnosticsConfigSchema } from "./schema-diagnostics.js";
import { AppConfigSchema } from "./schema.js";

describe("DiagnosticsConfigSchema — parse semantics", () => {
  it("empty parse populates all three subsection defaults", () => {
    const result = DiagnosticsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // trajectory has populated defaults (enabled + maxFileBytes).
      expect(result.data.trajectory.enabled).toBe(true);
      expect(result.data.trajectory.maxFileBytes).toBe(50 * 1024 * 1024);
      // cacheTrace defaults.
      expect(result.data.cacheTrace.enabled).toBe(true);
      expect(result.data.cacheTrace.includeMessages).toBe(false);
      expect(result.data.cacheTrace.includePrompt).toBe(true);
      expect(result.data.cacheTrace.includeSystem).toBe(false); // PII-safe default: only systemDigest is recorded
      // configAudit defaults.
      expect(result.data.configAudit.enabled).toBe(true);
      expect(result.data.configAudit.rotateAtBytes).toBe(10 * 1024 * 1024);
      expect(result.data.configAudit.keepRotated).toBe(5);
    }
  });

  it("undefined input also produces fully-defaulted DiagnosticsConfig (top-level .default)", () => {
    const result = DiagnosticsConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.enabled).toBe(true);
      expect(result.data.trajectory.maxFileBytes).toBe(50 * 1024 * 1024);
      // cacheTrace defaults populated.
      expect(result.data.cacheTrace.enabled).toBe(true);
      expect(result.data.cacheTrace.includeMessages).toBe(false);
      expect(result.data.cacheTrace.includePrompt).toBe(true);
      expect(result.data.cacheTrace.includeSystem).toBe(false); // PII-safe default: only systemDigest is recorded
      // configAudit defaults.
      expect(result.data.configAudit.enabled).toBe(true);
      expect(result.data.configAudit.rotateAtBytes).toBe(10 * 1024 * 1024);
      expect(result.data.configAudit.keepRotated).toBe(5);
    }
  });

  it("each subsection accepts an explicit empty object", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: {},
      cacheTrace: {},
      configAudit: {},
    });
    expect(result.success).toBe(true);
  });

  it("schema is forward-compatible: unknown keys are passed through (not a strictObject)", () => {
    // The placeholder subschemas use z.object({}) (NOT z.strictObject({}))
    // so a partially-configured YAML doesn't reject the whole diagnostics
    // block while new fields are still being added. This is the documented
    // contract for forward-compat placeholder subschemas.
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { enabled: true, dir: "/tmp/trj" },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trajectory subsection
// ---------------------------------------------------------------------------

describe("DiagnosticsConfigSchema.trajectory — fields and defaults", () => {
  it("defaults trajectory.enabled to true (writer is on by default)", () => {
    const result = DiagnosticsConfigSchema.safeParse({ trajectory: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.enabled).toBe(true);
    }
  });

  it("defaults trajectory.maxFileBytes to 50 MB", () => {
    const result = DiagnosticsConfigSchema.safeParse({ trajectory: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.maxFileBytes).toBe(50 * 1024 * 1024);
    }
  });

  it("allows operator override of enabled (false short-circuits the writer)", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.enabled).toBe(false);
    }
  });

  it("allows operator override of dir (overrides COMIS_TRAJECTORY_DIR env)", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { dir: "/var/log/comis/trj" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.dir).toBe("/var/log/comis/trj");
    }
  });

  it("allows operator override of maxFileBytes (positive int)", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { maxFileBytes: 10 * 1024 * 1024 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.maxFileBytes).toBe(10 * 1024 * 1024);
    }
  });

  it("rejects non-positive maxFileBytes", () => {
    const r1 = DiagnosticsConfigSchema.safeParse({ trajectory: { maxFileBytes: 0 } });
    const r2 = DiagnosticsConfigSchema.safeParse({ trajectory: { maxFileBytes: -1 } });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

  it("rejects non-integer maxFileBytes", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { maxFileBytes: 1024.5 },
    });
    expect(result.success).toBe(false);
  });

  it("allows operator-supplied eventTypes allowlist (consumer-side filter)", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { eventTypes: ["tool.call", "tool.result", "model.completed"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.eventTypes).toEqual([
        "tool.call",
        "tool.result",
        "model.completed",
      ]);
    }
  });

  it("defaults eventTypes to undefined when absent (writer records every bridge-mapped event)", () => {
    const result = DiagnosticsConfigSchema.safeParse({ trajectory: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.eventTypes).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// configAudit subsection
// ---------------------------------------------------------------------------

describe("DiagnosticsConfigSchema.configAudit — fields and defaults", () => {
  it("defaults configAudit.enabled to true (audit log is on by default)", () => {
    const result = DiagnosticsConfigSchema.safeParse({ configAudit: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configAudit.enabled).toBe(true);
    }
  });

  it("defaults configAudit.rotateAtBytes to 10 MB", () => {
    const result = DiagnosticsConfigSchema.safeParse({ configAudit: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configAudit.rotateAtBytes).toBe(10 * 1024 * 1024);
    }
  });

  it("defaults configAudit.keepRotated to 5", () => {
    const result = DiagnosticsConfigSchema.safeParse({ configAudit: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configAudit.keepRotated).toBe(5);
    }
  });

  it("allows operator override of all three configAudit fields", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      configAudit: {
        enabled: false,
        rotateAtBytes: 5 * 1024 * 1024,
        keepRotated: 3,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configAudit.enabled).toBe(false);
      expect(result.data.configAudit.rotateAtBytes).toBe(5 * 1024 * 1024);
      expect(result.data.configAudit.keepRotated).toBe(3);
    }
  });

  it("rejects non-positive configAudit.rotateAtBytes", () => {
    const r1 = DiagnosticsConfigSchema.safeParse({
      configAudit: { rotateAtBytes: 0 },
    });
    const r2 = DiagnosticsConfigSchema.safeParse({
      configAudit: { rotateAtBytes: -1 },
    });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

  it("rejects negative configAudit.keepRotated (0 is permitted — disable rotation retention)", () => {
    const okRes = DiagnosticsConfigSchema.safeParse({
      configAudit: { keepRotated: 0 },
    });
    expect(okRes.success).toBe(true);
    const failRes = DiagnosticsConfigSchema.safeParse({
      configAudit: { keepRotated: -1 },
    });
    expect(failRes.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cacheTrace subsection
// ---------------------------------------------------------------------------

describe("DiagnosticsConfigSchema.cacheTrace — fields and defaults", () => {
  it("cacheTrace defaults populate the full shape (on by default; includeMessages + includeSystem off; prompt on)", () => {
    const result = DiagnosticsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheTrace.enabled).toBe(true);
      expect(result.data.cacheTrace.includeMessages).toBe(false);
      expect(result.data.cacheTrace.includePrompt).toBe(true);
      expect(result.data.cacheTrace.includeSystem).toBe(false); // PII-safe default: only systemDigest is recorded
      expect(result.data.cacheTrace.filePath).toBeUndefined();
    }
  });

  it("cacheTrace.enabled=true with explicit overrides applies the merge", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      diagnostics: undefined,
      cacheTrace: { enabled: true, includeMessages: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheTrace.enabled).toBe(true);
      expect(result.data.cacheTrace.includeMessages).toBe(true);
      // Untouched fields keep their defaults.
      expect(result.data.cacheTrace.includePrompt).toBe(true);
      expect(result.data.cacheTrace.includeSystem).toBe(false); // PII-safe default: only systemDigest is recorded
    }
  });

  it("cacheTrace accepts an explicit filePath override (tilde expansion happens at runtime, not schema-parse)", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      cacheTrace: { filePath: "/var/log/comis/cache-trace.jsonl" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cacheTrace.filePath).toBe("/var/log/comis/cache-trace.jsonl");
    }
  });
});

// ---------------------------------------------------------------------------
// cacheTrace.maxFileBytes — operator-knob field
// ---------------------------------------------------------------------------
//
// `diagnostics.cacheTrace.maxFileBytes` is an operator-tunable file cap for
// the cache-trace JSONL artifact. Default is 50 MB — parity with
// `trajectory.maxFileBytes` so both diagnostics writers share a single
// mental model. The runtime fallback constant is 50 MB inside `runtime.ts`,
// and the sentinel state machine depends on the cap.

describe("cacheTrace.maxFileBytes config field", () => {
  it("default_is_50_mb_when_unset", () => {
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.diagnostics.cacheTrace.maxFileBytes).toBe(50 * 1024 * 1024);
  });

  it("override_persists_through_parse", () => {
    const result = AppConfigSchema.safeParse({
      diagnostics: { cacheTrace: { maxFileBytes: 100000 } },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.diagnostics.cacheTrace.maxFileBytes).toBe(100000);
  });

  it("negative_value_rejected_by_zod", () => {
    const result = AppConfigSchema.safeParse({
      diagnostics: { cacheTrace: { maxFileBytes: -1 } },
    });
    expect(result.success).toBe(false);
  });

  it("non_integer_value_rejected_by_zod", () => {
    const result = AppConfigSchema.safeParse({
      diagnostics: { cacheTrace: { maxFileBytes: 1.5 } },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recallTrace subsection
//
// `diagnostics.recallTrace` is the OPT-IN sibling of `cacheTrace` — it gates
// the per-recall ranking-preview JSONL recorder. Default OFF (distinct
// from cacheTrace's enabled:true digests) because it records ranking previews
// for a debug session. It has NO includeMessages/includeSystem slot: the
// recorder always full-sanitizes (no raw-content opt-in).
// ---------------------------------------------------------------------------

describe("DiagnosticsConfigSchema.recallTrace — fields and defaults", () => {
  it("empty parse populates recallTrace with enabled:false (opt-in) + 50 MB cap", () => {
    const result = DiagnosticsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Opt-IN: distinct from cacheTrace/trajectory which default enabled:true.
      expect(result.data.recallTrace.enabled).toBe(false);
      expect(result.data.recallTrace.maxFileBytes).toBe(50 * 1024 * 1024);
      expect(result.data.recallTrace.filePath).toBeUndefined();
    }
  });

  it("undefined input also yields a populated recallTrace (top-level sticky default)", () => {
    const result = DiagnosticsConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recallTrace.enabled).toBe(false);
      expect(result.data.recallTrace.maxFileBytes).toBe(50 * 1024 * 1024);
    }
  });

  it("a minimal AppConfig with NO diagnostics key still populates recallTrace (existing YAML parses unchanged)", () => {
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.diagnostics.recallTrace.enabled).toBe(false);
    expect(result.data.diagnostics.recallTrace.maxFileBytes).toBe(50 * 1024 * 1024);
  });

  it("an explicit { enabled:true, filePath } override round-trips with defaults preserved", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      recallTrace: { enabled: true, filePath: "~/x.jsonl" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recallTrace.enabled).toBe(true);
      expect(result.data.recallTrace.filePath).toBe("~/x.jsonl");
      // Untouched field keeps its default.
      expect(result.data.recallTrace.maxFileBytes).toBe(50 * 1024 * 1024);
    }
  });

  it("rejects a non-positive recallTrace.maxFileBytes (z.int().positive())", () => {
    const r1 = DiagnosticsConfigSchema.safeParse({ recallTrace: { maxFileBytes: 0 } });
    const r2 = DiagnosticsConfigSchema.safeParse({ recallTrace: { maxFileBytes: -1 } });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

  it("rejects a non-integer recallTrace.maxFileBytes", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      recallTrace: { maxFileBytes: 1024.5 },
    });
    expect(result.success).toBe(false);
  });

  it("recallTrace declares NO raw-content opt-in (no includeMessages/includeSystem field)", () => {
    // The recorder always full-sanitizes, so there is intentionally no
    // includeMessages / includeSystem / includePrompt slot (unlike cacheTrace).
    // Passthrough z.object() means unknown keys parse, but the parsed shape
    // must not surface those keys as populated defaults.
    const result = DiagnosticsConfigSchema.safeParse({ recallTrace: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      const rt = result.data.recallTrace as Record<string, unknown>;
      expect(rt.includeMessages).toBeUndefined();
      expect(rt.includeSystem).toBeUndefined();
      expect(rt.includePrompt).toBeUndefined();
    }
  });
});
