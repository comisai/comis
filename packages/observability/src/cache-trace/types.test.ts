// SPDX-License-Identifier: Apache-2.0
/**
 * CacheTraceEvent schema / type-sync invariant tests.
 *
 * Mirrors the trajectory `types.test.ts:19-41` shape: the closed-union
 * `CACHE_TRACE_STAGES` tuple constrains the Zod enum on `stage`, and
 * the inferred type and the exported `CacheTraceEvent` Type must stay
 * in lock-step.
 *
 * @module
 */
import { expectTypeOf, describe, it, expect } from "vitest";
import {
  CACHE_TRACE_STAGES,
  CacheTraceEventSchema,
  type CacheTraceEvent,
  type CacheTraceStage,
} from "./types.js";
import type { z } from "zod";

describe("CacheTraceEvent — type ⇄ schema sync invariant", () => {
  it("CACHE_TRACE_STAGES is a closed const-tuple of stage names", () => {
    expectTypeOf(CACHE_TRACE_STAGES).toEqualTypeOf<readonly CacheTraceStage[]>();
  });

  it("CacheTraceEvent Type is identical to z.infer<typeof CacheTraceEventSchema>", () => {
    expectTypeOf<z.infer<typeof CacheTraceEventSchema>>().toEqualTypeOf<CacheTraceEvent>();
  });

  it("schema accepts a minimal valid event (with traceId)", () => {
    const ev: CacheTraceEvent = CacheTraceEventSchema.parse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "session:start",
      ts: "2026-05-19T00:00:00.000Z",
      seq: 0,
      agentId: "a",
      sessionId: "s",
      traceId: "trace-1",
    });
    expect(ev.stage).toBe("session:start");
    expect(ev.traceId).toBe("trace-1");
  });

  it("schema rejects an unknown stage", () => {
    expect(() =>
      CacheTraceEventSchema.parse({
        traceSchema: "comis-cache-trace",
        schemaVersion: 1,
        stage: "not_a_real_stage",
        ts: "2026-05-19T00:00:00.000Z",
        seq: 0,
        agentId: "a",
        sessionId: "s",
        traceId: "trace-1",
      }),
    ).toThrow();
  });

  it("schema rejects an event missing the required `traceId` field", () => {
    const r = CacheTraceEventSchema.safeParse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "session:start",
      ts: "2026-05-19T00:00:00.000Z",
      seq: 0,
      agentId: "a",
      sessionId: "s",
      // traceId intentionally omitted
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual(["traceId"]);
    }
  });

  it("schema accepts the 5 optional envelope fields when present", () => {
    const ev = CacheTraceEventSchema.parse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "stream:context",
      ts: "2026-05-19T00:00:00.000Z",
      seq: 0,
      agentId: "a",
      sessionId: "s",
      traceId: "trace-1",
      runId: "run-1",
      sessionKey: "key-1",
      tenantId: "tenant-1",
      workspaceDir: "/work",
      modelApi: "messages",
    });
    expect(ev.runId).toBe("run-1");
    expect(ev.sessionKey).toBe("key-1");
    expect(ev.tenantId).toBe("tenant-1");
    expect(ev.workspaceDir).toBe("/work");
    expect(ev.modelApi).toBe("messages");
  });

  it("schema accepts modelApi as null", () => {
    const ev = CacheTraceEventSchema.parse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "session:start",
      ts: "2026-05-19T00:00:00.000Z",
      seq: 0,
      agentId: "a",
      sessionId: "s",
      traceId: "trace-1",
      modelApi: null,
    });
    expect(ev.modelApi).toBeNull();
  });

  it("schema accepts session:after with cacheReadInputTokens + cacheCreationInputTokens", () => {
    const ev = CacheTraceEventSchema.parse({
      traceSchema: "comis-cache-trace",
      schemaVersion: 1,
      stage: "session:after",
      ts: "2026-05-19T00:00:00.000Z",
      seq: 1,
      agentId: "a",
      sessionId: "s",
      traceId: "trace-1",
      cacheReadInputTokens: 1234,
      cacheCreationInputTokens: 56,
    });
    expect(ev.cacheReadInputTokens).toBe(1234);
  });
});
