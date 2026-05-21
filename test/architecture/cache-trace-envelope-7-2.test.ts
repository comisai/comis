// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariant — `CacheTraceEventSchema` honors design §7.2.
 *
 * The cache-trace event envelope is the per-line correlation surface
 * that downstream replay/diff/analysis tools depend on to join across
 * the trajectory, cache-trace, and audit-log JSONL streams. Design §7.2
 * enumerates the required envelope keys (`traceId` + 7 identity / model
 * fields) plus the 5 optional contextual fields (`tenantId`,
 * `sessionKey`, `runId`, `modelApi`, `workspaceDir`).
 *
 * This test pins both sets to the Zod schema shape so a casual schema
 * shrink can't silently drop a required envelope key or remove the
 * optional accommodation for a contextual field.
 *
 * Semantic correctness (traceId derivation from AsyncLocalStorage,
 * envelope-field passthrough from the executor) is gated by
 * `packages/observability/src/cache-trace/runtime.test.ts`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { CacheTraceEventSchema } from "@comis/observability";

/** §7.2 required envelope keys. */
const DESIGN_72_REQUIRED = [
  "traceSchema",
  "schemaVersion",
  "ts",
  "seq",
  "stage",
  "traceId",
  "agentId",
  "sessionId",
] as const;

/** §7.2 optional contextual envelope fields. */
const DESIGN_72_OPTIONAL = [
  "tenantId",
  "sessionKey",
  "runId",
  "provider",
  "modelId",
  "modelApi",
  "workspaceDir",
] as const;

describe("cache-trace event envelope honors design §7.2", () => {
  it("required fields are present in the schema shape", () => {
    const shape = CacheTraceEventSchema.shape;
    for (const field of DESIGN_72_REQUIRED) {
      expect(
        shape,
        `CacheTraceEventSchema is missing required §7.2 field: ${field}`,
      ).toHaveProperty(field);
    }
  });

  it("schema rejects an event missing `traceId`", () => {
    // Sanity check: traceId is required, not optional. Catches the
    // regression of an accidental `.optional()` addition.
    const r = CacheTraceEventSchema.safeParse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "session:after",
      ts: "2026-05-20T00:00:00Z",
      seq: 0,
      agentId: "a",
      sessionId: "s",
      // traceId intentionally omitted
    });
    expect(r.success).toBe(false);
  });

  it("optional envelope fields parse when present", () => {
    const shape = CacheTraceEventSchema.shape;
    for (const field of DESIGN_72_OPTIONAL) {
      expect(
        shape,
        `CacheTraceEventSchema lacks accommodation for §7.2 optional field: ${field}`,
      ).toHaveProperty(field);
    }
    // Round-trip through safeParse to confirm the 5 contextual fields
    // are accepted as optional strings.
    const r = CacheTraceEventSchema.safeParse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "session:after",
      ts: "2026-05-20T00:00:00Z",
      seq: 0,
      agentId: "a",
      sessionId: "s",
      traceId: "trace-xyz",
      tenantId: "tenant-1",
      sessionKey: "session-1",
      runId: "run-1",
      modelApi: null, // §7.2 explicitly allows null
      workspaceDir: "/work",
    });
    expect(r.success).toBe(true);
  });
});
