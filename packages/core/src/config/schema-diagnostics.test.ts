// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { DiagnosticsConfigSchema } from "./schema-diagnostics.js";

describe("DiagnosticsConfigSchema — parse semantics", () => {
  it("empty parse populates all four subsection defaults", () => {
    const result = DiagnosticsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Plan 45-03: trajectory now has populated defaults (enabled +
      // maxFileBytes); other subsections remain empty pending their
      // owning plans.
      expect(result.data.trajectory.enabled).toBe(true);
      expect(result.data.trajectory.maxFileBytes).toBe(50 * 1024 * 1024);
      expect(result.data.cacheTrace).toEqual({});
      expect(result.data.configAudit).toEqual({});
      expect(result.data.redact).toEqual({});
    }
  });

  it("undefined input also produces fully-defaulted DiagnosticsConfig (top-level .default)", () => {
    const result = DiagnosticsConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory.enabled).toBe(true);
      expect(result.data.trajectory.maxFileBytes).toBe(50 * 1024 * 1024);
      expect(result.data.cacheTrace).toEqual({});
      expect(result.data.configAudit).toEqual({});
      expect(result.data.redact).toEqual({});
    }
  });

  it("each subsection accepts an explicit empty object", () => {
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: {},
      cacheTrace: {},
      configAudit: {},
      redact: {},
    });
    expect(result.success).toBe(true);
  });

  it("schema is forward-compatible: unknown keys are passed through (not a strictObject)", () => {
    // Future plans add fields inside each subsection. The placeholder
    // subschemas use z.object({}) (NOT z.strictObject({})) so a partially-
    // configured YAML doesn't reject the whole diagnostics block during
    // the milestone-spanning rollout. This is the documented contract for
    // forward-compat placeholder subschemas.
    const result = DiagnosticsConfigSchema.safeParse({
      trajectory: { enabled: true, dir: "/tmp/trj" },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan 45-03: trajectory subsection
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
