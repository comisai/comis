// SPDX-License-Identifier: Apache-2.0
/**
 * Structural identity fields must survive the persistence sanitizer
 * (`sanitizeForPersistence`) so that
 * `SystemPromptReportSchema.parse(JSON.parse(row.reportJson))` succeeds
 * end-to-end.
 *
 * SystemPromptReport's `sessionId` is the join key used by the entire
 * observability stack, not a credential — masking it would break the
 * `(agentId, sessionId, runId)` correlation invariant and make the
 * persisted `report_json` invalid against its own Zod schema.
 *
 * Architecture-tier invariant:
 *   `sanitizeForPersistence(report)` retains the structural identity
 *   fields as plain strings AND the result parses against
 *   `SystemPromptReportSchema`.
 *
 * Locked in at the sanitizer/schema boundary directly so any regression
 * that re-adds these names to `CREDENTIAL_KEYS` (or a symmetric set in
 * `redactSecrets`) fails this test, not the integration round-trip that
 * catches it three tiers downstream.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeForPersistence,
  SystemPromptReportSchema,
  type SystemPromptReport,
} from "@comis/observability";

function makeValidReport(
  overrides?: Partial<SystemPromptReport>,
): SystemPromptReport {
  // Minimum-valid SystemPromptReport shape that SystemPromptReportSchema
  // accepts. `bootstrapMaxChars: 20_000` is required by the schema. The
  // fixture below includes the field as a literal value so the schema
  // parse succeeds regardless of the credential-filter outcome (the
  // invariant under test is about sessionId being preserved, not about
  // the bootstrap budget knobs).
  return {
    traceSchema: "comis-system-prompt-report",
    schemaVersion: 1,
    source: "run",
    generatedAt: 1_715_000_000_000,
    agentId: "agent-1",
    sessionId: "session-1",
    runId: "run-a",
    tenantId: "tenant-x",
    traceId: "trace-y",
    systemPrompt: {
      sha256: "deadbeef",
      chars: 100,
      projectContextChars: 10,
      nonProjectContextChars: 90,
    },
    bootstrapMaxChars: 20_000,
    injectedWorkspaceFiles: [],
    skills: { entries: [], promptChars: 0 },
    tools: { entries: [], totalSchemaChars: 0 },
    ...overrides,
  };
}

describe("sanitizeForPersistence — SystemPromptReport invariant", () => {
  it("sanitized payload still parses against SystemPromptReportSchema", () => {
    const report = makeValidReport();
    const sanitized = sanitizeForPersistence(report);
    expect(() => SystemPromptReportSchema.parse(sanitized)).not.toThrow();
  });

  it("structural identity fields are NOT dropped by the credential filter", () => {
    const report = makeValidReport({
      sessionId: "session-with-id",
      agentId: "agent-with-id",
      runId: "run-with-id",
      tenantId: "tenant-with-id",
      traceId: "trace-with-id",
    });
    const sanitized = sanitizeForPersistence(report) as SystemPromptReport;
    expect(sanitized.sessionId).toBe("session-with-id");
    expect(sanitized.agentId).toBe("agent-with-id");
    expect(sanitized.runId).toBe("run-with-id");
    expect(sanitized.tenantId).toBe("tenant-with-id");
    expect(sanitized.traceId).toBe("trace-with-id");
  });
});
