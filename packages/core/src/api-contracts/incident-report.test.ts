// SPDX-License-Identifier: Apache-2.0
/**
 * Schema assertions for the IncidentReport optional `audit?` + `cacheBreaks?`
 * sections.
 *
 * This file is NEW — there is no `incident-report.test.ts` on pre-patch HEAD (no
 * core test imports `IncidentReportSchema`). It pins the two additive, content-free,
 * presence-conditional sections (the `recall?`/`image?` mold) and the invariant
 * that `schemaVersion` STAYS `1` (additive optional sections, NOT a compat shim).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { IncidentReportSchema } from "./observability.js";

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

describe("IncidentReportSchema audit? + cacheBreaks? sections (176-05)", () => {
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

  it("strips a planted value-shaped field from the audit section (content-free — T-176-19)", () => {
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

describe("IncidentReportSchema spend? section (WEBUI-04, 179-04 — locked A2)", () => {
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

  // -------------------------------------------------------------------------
  // Optional proxyPosture field — additive, schemaVersion 1.
  // -------------------------------------------------------------------------

  it("DIAG-03: accepts a report WITH proxyPosture (proxy configured + success)", () => {
    const report = {
      ...baseReport(),
      proxyPosture: {
        configured: true,
        maskedUrl: "http://proxy.example.com",
        loopbackMode: "gateway-only",
        source: "config" as const,
        installerOk: true,
      },
    };
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.proxyPosture).toEqual({
      configured: true,
      maskedUrl: "http://proxy.example.com",
      loopbackMode: "gateway-only",
      source: "config",
      installerOk: true,
    });
  });

  it("DIAG-03: accepts a report WITH proxyPosture (proxy failed — installerError present)", () => {
    const report = {
      ...baseReport(),
      proxyPosture: {
        configured: true,
        installerOk: false,
        installerError: "proxy.proxyUrl",
        source: "config" as const,
      },
    };
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.proxyPosture?.installerOk).toBe(false);
    expect(parsed.proxyPosture?.installerError).toBe("proxy.proxyUrl");
  });

  it("DIAG-03: report WITHOUT proxyPosture still validates — existing reports are unchanged", () => {
    const report = baseReport(); // no proxyPosture key at all
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.proxyPosture).toBeUndefined();
  });

  it("DIAG-03: schemaVersion stays 1 when proxyPosture is present", () => {
    const report = {
      ...baseReport(),
      proxyPosture: { configured: false, installerOk: true },
    };
    const parsed = IncidentReportSchema.parse(report);
    expect(parsed.schemaVersion).toBe(1);
  });
});
