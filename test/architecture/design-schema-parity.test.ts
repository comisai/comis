// SPDX-License-Identifier: Apache-2.0
/**
 * Design ↔ schema default parity for diagnostics.* fields.
 *
 * Asserts field-by-field default parity between the Zod block in the
 * observability-stack design notes and the runtime
 * `DiagnosticsConfigSchema` in
 * `packages/core/src/config/schema-diagnostics.ts`.
 *
 * Implementation strategy: hard-coded expected-defaults table approach.
 * Simpler than parsing the Markdown fence; equally effective at the
 * acceptance criterion ("flipping a default in code
 * without updating the design doc fails the test"). The table itself
 * documents the expected-value contract — a code-only flip will fail
 * the assertion against the table, and updating the table requires a
 * same-PR edit to the design doc (enforced by code review per the
 * threat-model mitigation).
 *
 * The 10 fields covered are exactly the 10 documented defaults in
 * diagnostics defaults:
 *   trajectory:  enabled, maxFileBytes
 *   cacheTrace:  enabled, maxFileBytes, includeMessages, includePrompt, includeSystem
 *   configAudit: enabled, rotateAtBytes, keepRotated
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { AppConfigSchema } from "@comis/core";

/**
 * Expected defaults — must match the observability-stack design notes.
 *
 * The DESIGN doc is the contract; this table mirrors it. The runtime
 * `DiagnosticsConfigSchema` (in
 * `packages/core/src/config/schema-diagnostics.ts`) is the
 * implementation; this test asserts the two stay in sync.
 *
 * Any change to a default value here MUST be accompanied by the same
 * change to the design doc Zod block. The CHANGELOG entry must
 * surface the operator-visible change.
 *
 * Byte sizes use the same `N * 1024 * 1024` shape as the runtime
 * schema (grep-able against schema-diagnostics.ts). Final integer
 * values: 50 MiB = 52428800; 10 MiB = 10485760.
 */
const EXPECTED_DEFAULTS = {
  trajectory: {
    enabled: true,
    maxFileBytes: 50 * 1024 * 1024,
  },
  cacheTrace: {
    enabled: true,
    maxFileBytes: 50 * 1024 * 1024,
    includeMessages: false,
    includePrompt: true,
    includeSystem: false,
  },
  configAudit: {
    enabled: true,
    rotateAtBytes: 10 * 1024 * 1024,
    keepRotated: 5,
  },
} as const;

describe("design-schema-parity for diagnostics.*", () => {
  // Parse once; reuse across all 10 field assertions.
  const parsed = AppConfigSchema.parse({});
  const diag = parsed.diagnostics;

  it("trajectory_enabled_default_true_in_both_design_and_schema", () => {
    expect(diag.trajectory.enabled).toBe(EXPECTED_DEFAULTS.trajectory.enabled);
  });

  it("trajectory_maxFileBytes_default_52428800_in_both_design_and_schema", () => {
    expect(diag.trajectory.maxFileBytes).toBe(
      EXPECTED_DEFAULTS.trajectory.maxFileBytes,
    );
  });

  it("cacheTrace_enabled_default_true_in_both_design_and_schema", () => {
    expect(diag.cacheTrace.enabled).toBe(EXPECTED_DEFAULTS.cacheTrace.enabled);
  });

  it("cacheTrace_maxFileBytes_default_52428800_in_both_design_and_schema", () => {
    expect(diag.cacheTrace.maxFileBytes).toBe(
      EXPECTED_DEFAULTS.cacheTrace.maxFileBytes,
    );
  });

  it("cacheTrace_includeMessages_default_false_in_both_design_and_schema", () => {
    expect(diag.cacheTrace.includeMessages).toBe(
      EXPECTED_DEFAULTS.cacheTrace.includeMessages,
    );
  });

  it("cacheTrace_includePrompt_default_true_in_both_design_and_schema", () => {
    expect(diag.cacheTrace.includePrompt).toBe(
      EXPECTED_DEFAULTS.cacheTrace.includePrompt,
    );
  });

  it("cacheTrace_includeSystem_default_false_in_both_design_and_schema", () => {
    expect(diag.cacheTrace.includeSystem).toBe(
      EXPECTED_DEFAULTS.cacheTrace.includeSystem,
    );
  });

  it("configAudit_enabled_default_true_in_both_design_and_schema", () => {
    expect(diag.configAudit.enabled).toBe(
      EXPECTED_DEFAULTS.configAudit.enabled,
    );
  });

  it("configAudit_rotateAtBytes_default_10485760_in_both_design_and_schema", () => {
    expect(diag.configAudit.rotateAtBytes).toBe(
      EXPECTED_DEFAULTS.configAudit.rotateAtBytes,
    );
  });

  it("configAudit_keepRotated_default_5_in_both_design_and_schema", () => {
    expect(diag.configAudit.keepRotated).toBe(
      EXPECTED_DEFAULTS.configAudit.keepRotated,
    );
  });
});
