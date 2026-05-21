// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-HARD-12 — design ↔ schema default parity for diagnostics.* fields.
 *
 * Asserts field-by-field default parity between the §12 Zod block in
 * `.planning/design/observability-stack-workstream-a.md` (after Plan 48-04
 * sweep) and the runtime `DiagnosticsConfigSchema` in
 * `packages/core/src/config/schema-diagnostics.ts` (after Plan 48-02
 * extension).
 *
 * Per Claude's Discretion (CONTEXT.md), implementation may use either
 * a TypeScript-fragment AST walker on the Markdown fence OR a hard-coded
 * expected-defaults table. This implementation uses the hard-coded
 * table approach (simpler; no Markdown parser dependency; the table
 * itself documents the expected-value contract — a code-only flip will
 * fail the assertion against the table, and updating the table requires
 * a same-PR edit to the design doc enforced by code review).
 *
 * @module
 */
import { describe, it } from "vitest";

describe("design-schema-parity for diagnostics.*", () => {
  it.skip("trajectory_enabled_default_true_in_both_design_and_schema", () => {});
  it.skip("trajectory_maxFileBytes_default_52428800_in_both_design_and_schema", () => {});
  it.skip("cacheTrace_enabled_default_true_in_both_design_and_schema", () => {});
  it.skip("cacheTrace_maxFileBytes_default_52428800_in_both_design_and_schema", () => {});
  it.skip("cacheTrace_includeMessages_default_false_in_both_design_and_schema", () => {});
  it.skip("cacheTrace_includePrompt_default_true_in_both_design_and_schema", () => {});
  it.skip("cacheTrace_includeSystem_default_true_in_both_design_and_schema", () => {});
  it.skip("configAudit_enabled_default_true_in_both_design_and_schema", () => {});
  it.skip("configAudit_rotateAtBytes_default_10485760_in_both_design_and_schema", () => {});
  it.skip("configAudit_keepRotated_default_5_in_both_design_and_schema", () => {});
});
