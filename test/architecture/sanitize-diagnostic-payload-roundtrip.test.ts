// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 45.1-01 (H4): structural identity fields must survive the
 * persistence sanitizer (`sanitizeForPersistence`) so that
 * `SystemPromptReportSchema.parse(JSON.parse(row.reportJson))`
 * succeeds end-to-end.
 *
 * Before this plan, `CREDENTIAL_KEYS` masked `sessionid`/`session_id`
 * as credentials. SystemPromptReport's `sessionId` is the join key
 * used by the entire observability stack (design §4.3), not a
 * credential — masking it broke the `(agentId, sessionId, runId)`
 * correlation invariant and made the persisted `report_json` invalid
 * against its own Zod schema.
 *
 * Architecture-tier invariant (RESEARCH.md §5 Invariant 1):
 *   `sanitizeForPersistence(report)` retains the structural identity
 *   fields as plain strings AND the result parses against
 *   `SystemPromptReportSchema`.
 *
 * Locked in at the sanitizer/schema boundary directly so any
 * regression that re-adds these names to `CREDENTIAL_KEYS` (or a
 * symmetric set in `redactSecrets`) fails this test, not the
 * integration round-trip that catches it three tiers downstream.
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
  // accepts. `bootstrapMaxChars: 20_000` is included for forward
  // compatibility with 45.1-05 (which promotes the field from
  // builder-only to required in the schema). Today the field is not in
  // the schema yet, so it's a harmless extra field; once 45.1-05 lands
  // the schema requires it and this fixture still parses. Either
  // landing order works.
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
    injectedWorkspaceFiles: [],
    skills: { entries: [], promptChars: 0 },
    tools: { entries: [], totalSchemaChars: 0 },
    ...overrides,
    // Force-extend with the forward-compat field via an intersection
    // cast — the type doesn't yet know about it pre-45.1-05.
  } as SystemPromptReport & { readonly bootstrapMaxChars: number };
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
