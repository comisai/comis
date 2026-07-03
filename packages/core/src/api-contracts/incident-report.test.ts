// SPDX-License-Identifier: Apache-2.0
/**
 * Schema assertions for the IncidentReport optional `audit?` + `cacheBreaks?`
 * sections.
 *
 * Pins the two additive, content-free,
 * presence-conditional sections (the `recall?`/`image?` mold) and the invariant
 * that `schemaVersion` STAYS `1` (additive optional sections, NOT a compat shim).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { IncidentReportSchema, ObsExplainContract } from "./observability.js";

/** A minimal-but-valid IncidentReport (no optional sections) — the base fixture. */
function baseReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionKey: "default:user:telegram:1",
    traceId: "t-1",
    agentId: "default",
    channel: { type: "telegram", id: "user" },
    outcome: { endReason: "stop", degraded: false, severity: "ok" },
    cost: { costUsd: 0, totalTokens: 0, cacheReadRatio: 0 },
    timing: { durationMs: 0, turnCount: 1 },
    toolStats: {},
    failures: [],
    breakerTimeline: [],
    offloads: [],
    summary: "clean session",
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
  };
}

describe("IncidentReportSchema audit? + cacheBreaks? sections", () => {
  it("parses a report WITHOUT the new optional sections (additive — pre-existing constructors)", () => {
    const parsed = IncidentReportSchema.parse(baseReport());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.audit).toBeUndefined();
    expect(parsed.cacheBreaks).toBeUndefined();
  });

  it("accepts a cacheBreaks section ([{reason,count,estCostUsd}]); schemaVersion stays 1", () => {
    const report = {
      ...baseReport(),
      cacheBreaks: [
        { reason: "system_changed", count: 3, estCostUsd: 0.01 },
        { reason: "tools_changed", count: 1, estCostUsd: 0 },
      ],
    };
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.cacheBreaks).toHaveLength(2);
    expect(parsed.cacheBreaks?.[0]).toEqual({
      reason: "system_changed",
      count: 3,
      estCostUsd: 0.01,
    });
  });

  it("accepts an audit section ({total, byKind}) — counts-by-kind, content-free", () => {
    const report = {
      ...baseReport(),
      audit: { total: 5, byKind: { secret_access: 2, injection_detected: 3 } },
    };
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.audit?.total).toBe(5);
    expect(parsed.audit?.byKind).toEqual({ secret_access: 2, injection_detected: 3 });
  });

  it("strips a planted value-shaped field from the audit section (content-free)", () => {
    // z.object strips unknown keys on parse — a `value`/`secret` field can never
    // ride the audit? section even if a caller tries to smuggle one.
    const report = {
      ...baseReport(),
      audit: {
        total: 1,
        byKind: { secret_access: 1 },
        value: "sk-leaked-secret",
        secret: "nope",
      },
    };
    const parsed = IncidentReportSchema.parse(report);
    const audit = parsed.audit as Record<string, unknown> | undefined;
    expect(audit).toBeDefined();
    expect("value" in (audit ?? {})).toBe(false);
    expect("secret" in (audit ?? {})).toBe(false);
    expect(Object.keys(audit ?? {}).sort()).toEqual(["byKind", "total"]);
  });

  it("rejects a cacheBreaks entry missing estCostUsd (the shape is enforced)", () => {
    const report = {
      ...baseReport(),
      cacheBreaks: [{ reason: "system_changed", count: 3 }],
    };
    expect(() => IncidentReportSchema.parse(report)).toThrow();
  });
});

describe("IncidentReportSchema spend? section", () => {
  it("parses a report WITHOUT spend (additive — present only on a spend-killed session)", () => {
    const parsed = IncidentReportSchema.parse(baseReport());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.spend).toBeUndefined();
  });

  it("accepts a spend section ({scope, totalUsd, capUsd}); schemaVersion stays 1", () => {
    const report = {
      ...baseReport(),
      spend: { scope: "agent", totalUsd: 1.25, capUsd: 1.0 },
    };
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.spend).toEqual({ scope: "agent", totalUsd: 1.25, capUsd: 1.0 });
  });

  it("strips a planted value-shaped field from the spend section (content-free)", () => {
    const report = {
      ...baseReport(),
      spend: { scope: "tenant", totalUsd: 2, capUsd: 1, value: "sk-leaked", body: "private" },
    };
    const parsed = IncidentReportSchema.parse(report);
    const spend = parsed.spend as Record<string, unknown> | undefined;
    expect(spend).toBeDefined();
    expect("value" in (spend ?? {})).toBe(false);
    expect("body" in (spend ?? {})).toBe(false);
    expect(Object.keys(spend ?? {}).sort()).toEqual(["capUsd", "scope", "totalUsd"]);
  });

  it("rejects a spend section missing capUsd (the shape is enforced)", () => {
    const report = { ...baseReport(), spend: { scope: "global", totalUsd: 5 } };
    expect(() => IncidentReportSchema.parse(report)).toThrow();
  });
});

describe("ObsExplainContract.request rootRunId arm", () => {
  // The rootRunId arm widens obs.explain from a TWO-ref (sessionKey | traceId) request to a
  // THREE-ref one (+ rootRunId), so the fleet→explain drill-down can paste an
  // autonomy run's rootRunId straight in. The widen is ADDITIVE-OPTIONAL: the
  // .object stays non-strict, the .refine requires "one of three", and an existing
  // sessionKey/traceId caller is unaffected.

  it("accepts a rootRunId-only request and the rootRunId SURVIVES the parse (the field is declared, not stripped)", () => {
    // A non-strict z.object STRIPS an undeclared key — so an undeclared rootRunId
    // would silently vanish through .parse and mis-resolve downstream. Proving it
    // round-trips proves the field is actually declared on the request shape.
    const parsed = ObsExplainContract.request.parse({ rootRunId: "root-session-default:u:c:1" });
    expect(parsed.rootRunId).toBe("root-session-default:u:c:1");
  });

  it("accepts a real (non-synthetic) rootRunId ref", () => {
    const parsed = ObsExplainContract.request.parse({ rootRunId: "run-abc-123", depth: "summary" });
    expect(parsed.rootRunId).toBe("run-abc-123");
    expect(parsed.depth).toBe("summary");
  });

  it("still rejects an empty request via the widened .refine, naming all three refs", () => {
    // The neither-id guard must still fire — but now the message names rootRunId too,
    // so an operator who passes none of the three sees the full set.
    const result = ObsExplainContract.request.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/sessionKey/);
      expect(msg).toMatch(/traceId/);
      expect(msg).toMatch(/rootRunId/);
    }
  });

  it("rejects an empty-string rootRunId (min(1) — the same guard as sessionKey/traceId)", () => {
    expect(() => ObsExplainContract.request.parse({ rootRunId: "" })).toThrow();
  });

  it("still accepts a sessionKey-only and a traceId-only request (the widen is additive — no existing caller breaks)", () => {
    expect(ObsExplainContract.request.parse({ sessionKey: "default:u:c:1" }).sessionKey).toBe(
      "default:u:c:1",
    );
    expect(ObsExplainContract.request.parse({ traceId: "t-1" }).traceId).toBe("t-1");
  });
});
