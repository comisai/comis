// SPDX-License-Identifier: Apache-2.0
/**
 * R1 schema-shape contract test (v2.15 Fleet Health Lens).
 *
 * Pins the bounded/digest-only/deterministic `FleetHealthReportSchema` shape so
 * the Phase-161 `obs.fleet.health` handler (bounding pass + heuristic registry +
 * coverage construction) targets a stable wire contract. MIRRORS the
 * `IncidentReport` schema-shape test discipline (a contract test that pins the
 * new behavior, §2.10) — but asserts DISTINCTNESS from `IncidentReport` (mirror,
 * not extend) and DETERMINISM (no wall-clock field in the report root).
 *
 * RED on pre-patch code: `./fleet-health-report.js` does not exist, so the import
 * throws and every case fails. GREEN once the schema module lands.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { FleetHealthReportSchema, ObsFleetHealthContract } from "./fleet-health-report.js";
import type { FleetHealthReport } from "./fleet-health-report.js";
import { OBSERVABILITY_CONTRACTS } from "./observability.js";

/**
 * A fully-populated, well-formed fleet report (every required field present,
 * including the optional `coverage` honesty block). The canonical valid fixture.
 */
function validReport(): FleetHealthReport {
  return {
    schemaVersion: 1,
    windowHours: 24,
    sessions: { total: 42, degraded: 7, degradedRate: 0.1667 },
    topErrorKinds: [
      { kind: "tool_timeout", count: 9 },
      { kind: "rate_limit", count: 4 },
    ],
    degradedByCause: { context_exhausted: 4, output_starved: 2, error: 1 },
    breakerTripTotal: 3,
    toolStats: {
      web_search: { ok: 30, failed: 5 },
      shell: { ok: 12, failed: 1 },
    },
    cost: { costUsd: 1.23, totalTokens: 456_789 },
    activity: {
      activeAgents: ["agent-a", "agent-b"],
      activeChannels: ["discord:123", "telegram:456"],
      exitReasons: { completed: 35, error: 7 },
      turnTotal: 210,
      tokenTotal: 456_789,
    },
    findings: [
      {
        code: "high_degraded_rate",
        detail: "16.7% of sessions degraded over the window",
        count: 7,
        hint: "Inspect the top error kinds; check provider rate limits.",
      },
    ],
    likelyRootCause: {
      code: "provider_rate_limiting",
      detail: "rate_limit dominates the merged errorKinds",
      suggestedNextSteps: ["Raise the provider quota", "Stagger agent dispatch"],
    },
    suggestedNextSteps: ["Run `comis explain` on the worst session"],
    truncations: [
      { field: "findings", reason: "capped to top-N", pointer: "findings[10..]" },
    ],
    coverage: {
      sessionSummary: { found: true, rows: 42 },
      sessionIndex: { daysRead: 1, daysMissing: 0 },
      billing: { present: true },
    },
  };
}

describe("FleetHealthReportSchema (R1 — bounded/deterministic fleet wire shape)", () => {
  it("parses a fully-populated, well-formed fleet report", () => {
    const parsed = FleetHealthReportSchema.parse(validReport());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.windowHours).toBe(24);
    expect(parsed.sessions.degradedRate).toBeCloseTo(0.1667);
    expect(parsed.likelyRootCause?.code).toBe("provider_rate_limiting");
  });

  it("pins schemaVersion to the literal 1 (a future version is rejected)", () => {
    const wrongVersion = { ...validReport(), schemaVersion: 2 };
    const result = FleetHealthReportSchema.safeParse(wrongVersion);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "schemaVersion")).toBe(
        true,
      );
    }
  });

  it("rejects a fixture missing a required field on that field's path", () => {
    const fixture = validReport() as Record<string, unknown>;
    delete fixture.sessions;
    const result = FleetHealthReportSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "sessions")).toBe(true);
    }
  });

  it("treats `coverage` as optional (additive — schemaVersion stays 1)", () => {
    const withoutCoverage = validReport() as Partial<FleetHealthReport>;
    delete withoutCoverage.coverage;
    const parsed = FleetHealthReportSchema.parse(withoutCoverage);
    expect(parsed.coverage).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);

    // A well-formed coverage block still parses (the honesty block round-trips).
    const withCoverage = FleetHealthReportSchema.parse(validReport());
    expect(withCoverage.coverage?.sessionIndex.daysMissing).toBe(0);
  });

  it("allows a nullable likelyRootCause (no deterministic verdict found)", () => {
    const noVerdict = { ...validReport(), likelyRootCause: null };
    const parsed = FleetHealthReportSchema.parse(noVerdict);
    expect(parsed.likelyRootCause).toBeNull();
  });

  it("QT2/QT3: carries degradedByCause — a required bounded Record<cause, count> of named causes", () => {
    // The fleet-level degradation detector. Required (the assembler always emits
    // it, possibly {}). Each value is a count (bounded, no raw bodies).
    const parsed = FleetHealthReportSchema.parse(validReport());
    expect(parsed.degradedByCause).toEqual({ context_exhausted: 4, output_starved: 2, error: 1 });
    for (const count of Object.values(parsed.degradedByCause)) {
      expect(typeof count).toBe("number");
    }
    // Missing degradedByCause is rejected on its own path (required field).
    const fixture = validReport() as Record<string, unknown>;
    delete fixture.degradedByCause;
    const result = FleetHealthReportSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "degradedByCause")).toBe(true);
    }
  });

  it("is DISTINCT from IncidentReport (mirror, not extend): a per-session shape is rejected", () => {
    // A shape resembling a per-session IncidentReport (no fleet `sessions`
    // rollup; carries the session-only `failures`/`breakerTimeline`/`offloads`).
    // Because `sessions` (required) is absent, it must NOT parse as a fleet report —
    // pinning that R1 is a DISTINCT shape, not an IncidentReport alias.
    const sessionShaped = {
      schemaVersion: 1,
      sessionKey: "tenant/discord/abc",
      traceId: "t-1",
      agentId: "agent-a",
      channel: { type: "discord", id: "123" },
      failures: [],
      breakerTimeline: [],
      offloads: [],
      summary: "one session",
    };
    expect(FleetHealthReportSchema.safeParse(sessionShaped).success).toBe(false);

    // The inferred type exposes the FLEET keys, NOT the session-only ones.
    const report = validReport();
    expect(report).toHaveProperty("sessions");
    expect(report).toHaveProperty("activity");
    expect(report).not.toHaveProperty("failures");
    expect(report).not.toHaveProperty("breakerTimeline");
  });

  it("is bounded by construction: arrays-of-bounded-records + a truncations[] ledger", () => {
    const parsed = FleetHealthReportSchema.parse(validReport());
    // findings / topErrorKinds are capped-top-N arrays of {counts + hints}, not
    // unbounded free-text — every entry carries a count, no raw WARN-body field.
    for (const f of parsed.findings) {
      expect(typeof f.count).toBe("number");
      expect(typeof f.hint).toBe("string");
    }
    for (const e of parsed.topErrorKinds) {
      expect(typeof e.count).toBe("number");
    }
    // The honest truncations[] ledger is present and shaped {field, reason, pointer?}.
    expect(Array.isArray(parsed.truncations)).toBe(true);
    expect(parsed.truncations[0]).toMatchObject({ field: "findings", reason: "capped to top-N" });
  });

  it("is DETERMINISTIC: the report root carries NO wall-clock field", () => {
    const report = validReport() as Record<string, unknown>;
    // No generatedAtMs / timestamp / createdAt anywhere in the root — `windowHours`
    // is the only time reference (same window → same verdict, byte-identical).
    expect(report).not.toHaveProperty("generatedAtMs");
    expect(report).not.toHaveProperty("timestamp");
    expect(report).not.toHaveProperty("createdAt");
    // Even if a caller smuggles one in, z.object strips unknown keys — the parsed
    // report never surfaces a wall-clock field.
    const smuggled = { ...validReport(), generatedAtMs: Date.now() } as Record<
      string,
      unknown
    >;
    const parsed = FleetHealthReportSchema.parse(smuggled) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("generatedAtMs");
  });
});

/**
 * R2 contract-shape pins (Phase 161): the `obs.fleet.health` RPC contract is the
 * admin-scoped sibling of `obs.explain`. RED on pre-patch code: `ObsFleetHealthContract`
 * does not exist, so the import fails to compile and every case below fails (the
 * 159/160 precedent: an absent symbol IS the RED). GREEN once the `defineContract`
 * lands in this module and is registered in `OBSERVABILITY_CONTRACTS`.
 */
describe("ObsFleetHealthContract (R2 — admin-scoped fleet RPC contract)", () => {
  it("declares the method `obs.fleet.health`", () => {
    expect(ObsFleetHealthContract.method).toBe("obs.fleet.health");
  });

  it("is admin-scoped (scopes deep-equals [\"admin\"])", () => {
    expect(ObsFleetHealthContract.scopes).toEqual(["admin"]);
  });

  it("has a refine-free, default-free request: `{}` and `{sinceHours:24}` parse, `{sinceHours:-1}` fails", () => {
    // sinceHours is optional — an empty request parses (the 24h default is applied
    // in the HANDLER body, NOT via .default() which is off the 12-shape allowlist).
    expect(ObsFleetHealthContract.request.parse({})).toEqual({});
    expect(ObsFleetHealthContract.request.parse({ sinceHours: 24 })).toEqual({ sinceHours: 24 });
    // .positive() rejects a non-positive window — proves the field validates without
    // a cross-field .refine (the fleet request has one optional field, no neither-id guard).
    expect(ObsFleetHealthContract.request.safeParse({ sinceHours: -1 }).success).toBe(false);
  });

  it("is registered in OBSERVABILITY_CONTRACTS (an entry whose method is obs.fleet.health)", () => {
    const methods = OBSERVABILITY_CONTRACTS.map((c) => c.method);
    expect(methods).toContain("obs.fleet.health");
  });
});
