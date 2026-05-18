// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { DiagnosticsConfigSchema } from "./schema-diagnostics.js";

describe("DiagnosticsConfigSchema — parse semantics", () => {
  it("empty parse populates all four subsection defaults", () => {
    const result = DiagnosticsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory).toEqual({});
      expect(result.data.cacheTrace).toEqual({});
      expect(result.data.configAudit).toEqual({});
      expect(result.data.redact).toEqual({});
    }
  });

  it("undefined input also produces fully-defaulted DiagnosticsConfig (top-level .default)", () => {
    const result = DiagnosticsConfigSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory).toEqual({});
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
