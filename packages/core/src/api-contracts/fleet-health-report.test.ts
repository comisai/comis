// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-shape contract test for the fleet-health lens.
 *
 * Pins the bounded/digest-only/deterministic `FleetHealthReportSchema` shape so
 * the `obs.fleet.health` handler (bounding pass + heuristic registry +
 * coverage construction) targets a stable wire contract. MIRRORS the
 * `IncidentReport` schema-shape test discipline (a contract test that pins the
 * behavior) — but asserts DISTINCTNESS from `IncidentReport` (mirror,
 * not extend) and DETERMINISM (no wall-clock field in the report root).
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
    pipelineAuthoringGate: {
      buildAuthor: false,
      reason: "defer: insufficient telemetry (0 small-tier invocations < 20)",
    },
  };
}

describe("FleetHealthReportSchema (bounded/deterministic fleet wire shape)", () => {
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

  it("the pipelineAuthoringGate verdict SURVIVES .parse() (the round-trip proof)", () => {
    // Without the schema field, the non-strict z.object STRIPS this key on parse
    // -> the verdict never reaches the wire (the operator never sees the gate
    // decision). Declaring it in FleetHealthReportSchema is what makes .parse()
    // PRESERVE it (a tampering mitigation).
    const parsed = FleetHealthReportSchema.parse(validReport());
    expect(parsed.pipelineAuthoringGate).toBeDefined();
    expect(parsed.pipelineAuthoringGate?.buildAuthor).toBe(false);
    expect(parsed.pipelineAuthoringGate?.reason).toMatch(/insufficient telemetry/);

    // The build verdict round-trips intact too.
    const buildReport = {
      ...validReport(),
      pipelineAuthoringGate: { buildAuthor: true, reason: "build: 50 small-tier invocations, validity 45.0pp below frontier (>= 15pp)" },
    };
    const parsedBuild = FleetHealthReportSchema.parse(buildReport);
    expect(parsedBuild.pipelineAuthoringGate?.buildAuthor).toBe(true);
  });

  it("treats `pipelineAuthoringGate` as optional (additive — schemaVersion stays 1)", () => {
    const without = validReport() as Partial<FleetHealthReport>;
    delete without.pipelineAuthoringGate;
    const parsed = FleetHealthReportSchema.parse(without);
    expect(parsed.pipelineAuthoringGate).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The additive-optional `autonomy` block: the
  // cross-run AUTONOMY-health slice (run counts + degradedRate +
  // orphaned/resumed/revoked/killed + breakerTrips + budgetBreaches + costUsd +
  // the worst rootRunId to drill into via `comis explain`). Counts + an id ONLY.
  // Without the schema field, the non-strict
  // z.object STRIPS the block on .parse() and it never reaches the operator —
  // every assertion below fails without the schema field (the
  // pipelineAuthoringGate round-trip proof, one signal class over).
  // -------------------------------------------------------------------------
  it("the populated `autonomy` block SURVIVES .parse() (additive block round-trip)", () => {
    // Without the schema field, the non-strict z.object STRIPS this key on parse
    // → the autonomy slice never reaches the wire. Declaring it in
    // FleetHealthReportSchema is what makes .parse() PRESERVE it.
    const withAutonomy = {
      ...validReport(),
      autonomy: {
        runs: { total: 20, degraded: 3, degradedRate: 0.15 },
        orphaned: 2,
        resumed: 4,
        revoked: 1,
        killed: 1,
        breakerTrips: 2,
        // The capability-denial breaker count, separable
        // from the tool-failure `breakerTrips`.
        denialBreakerTrips: 3,
        budgetBreaches: 1,
        costUsd: 0.42,
        worstRootRunId: "root-run-abc123",
      },
    };
    const parsed = FleetHealthReportSchema.parse(withAutonomy);
    expect(parsed.autonomy).toBeDefined();
    expect(parsed.autonomy?.runs).toEqual({ total: 20, degraded: 3, degradedRate: 0.15 });
    expect(parsed.autonomy?.orphaned).toBe(2);
    expect(parsed.autonomy?.resumed).toBe(4);
    expect(parsed.autonomy?.revoked).toBe(1);
    expect(parsed.autonomy?.killed).toBe(1);
    expect(parsed.autonomy?.breakerTrips).toBe(2);
    // The separable denial-breaker count survives .parse() (a non-strict
    // z.object would STRIP it without the schema field).
    expect(parsed.autonomy?.denialBreakerTrips).toBe(3);
    expect(parsed.autonomy?.budgetBreaches).toBe(1);
    expect(parsed.autonomy?.costUsd).toBeCloseTo(0.42);
    expect(parsed.autonomy?.worstRootRunId).toBe("root-run-abc123");
    // schemaVersion stays the literal 1 (additive, not a version bump).
    expect(parsed.schemaVersion).toBe(1);
  });

  it("treats `autonomy` as optional (additive — a report WITHOUT it still parses, schemaVersion stays 1)", () => {
    const without = validReport() as Partial<FleetHealthReport>;
    expect(without).not.toHaveProperty("autonomy"); // validReport() omits it.
    const parsed = FleetHealthReportSchema.parse(without);
    expect(parsed.autonomy).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);

    // worstRootRunId is itself optional inside the block (a clean window has no
    // worst run) — a block without it still parses.
    const noWorstId = {
      ...validReport(),
      autonomy: {
        runs: { total: 5, degraded: 0, degradedRate: 0 },
        orphaned: 0,
        resumed: 0,
        revoked: 0,
        killed: 0,
        breakerTrips: 0,
        denialBreakerTrips: 0,
        budgetBreaches: 0,
        costUsd: 0,
      },
    };
    const parsedNoWorst = FleetHealthReportSchema.parse(noWorstId);
    expect(parsedNoWorst.autonomy?.worstRootRunId).toBeUndefined();
  });

  it("CONTENT-FREE: a smuggled free-text `reason` key inside the autonomy block is STRIPPED on parse", () => {
    // The block carries counts + an id ONLY. A caller who smuggles a body field
    // (a free-text reason / a lease bearer) must have it stripped by the
    // non-strict z.object — it can never reach the operator-facing report.
    const smuggled = {
      ...validReport(),
      autonomy: {
        runs: { total: 3, degraded: 1, degradedRate: 1 / 3 },
        orphaned: 1,
        resumed: 0,
        revoked: 0,
        killed: 0,
        breakerTrips: 0,
        denialBreakerTrips: 0,
        budgetBreaches: 0,
        costUsd: 0,
        worstRootRunId: "root-run-xyz",
        reason: "the lease holder dropped its heartbeat at /home/op/run", // smuggled body
        bearer: "secret-lease-token", // smuggled secret
      },
    } as Record<string, unknown>;
    const parsed = FleetHealthReportSchema.parse(smuggled) as {
      autonomy?: Record<string, unknown>;
    };
    expect(parsed.autonomy).toBeDefined();
    expect(parsed.autonomy).not.toHaveProperty("reason");
    expect(parsed.autonomy).not.toHaveProperty("bearer");
    // The declared keys survive; only the smuggled ones are dropped.
    expect(parsed.autonomy?.worstRootRunId).toBe("root-run-xyz");
  });

  // -------------------------------------------------------------------------
  // The additive-optional `cronWakeGate` block: the cross-session wake-gate
  // efficiency slice (per-agent skip-rate + turns-saved + tool-call cost). The
  // gate suppresses model turns; `skipRate == 1.0` per agent is the suppression
  // signal (a monitor that never fires), and `toolCalls` (the gate's cost)
  // beside `turnsSaved` (the benefit) is the net-cost legibility (a gate that
  // costs more than it saves). Counts + agent ids ONLY. Without the schema
  // field, the non-strict z.object STRIPS the block on .parse() and it never
  // reaches the operator — the round-trip proof, one signal class over.
  // -------------------------------------------------------------------------
  it("the populated `cronWakeGate` block SURVIVES .parse() (round-trip; a 100%-skip agent is visible + net-cost legible)", () => {
    // Without the schema field, the non-strict z.object STRIPS this key on parse
    // → the wake-gate slice never reaches the wire. Declaring it in
    // FleetHealthReportSchema is what makes .parse() PRESERVE it.
    const withGate = {
      ...validReport(),
      cronWakeGate: {
        fires: { total: 5, skipped: 4, skipRate: 0.8 },
        turnsSaved: 4,
        toolCalls: 7,
        perAgent: [
          { agentId: "agent-a", fires: 4, skipped: 3, skipRate: 0.75, turnsSaved: 3, toolCalls: 7 },
          // A 100%-skip gate — the suppression signal. skipRate === 1.0 MUST be
          // visible (a monitor that never wakes the model is either working hard
          // OR silently poisoned; either way the operator must see it).
          { agentId: "agent-b", fires: 1, skipped: 1, skipRate: 1, turnsSaved: 1, toolCalls: 0 },
        ],
      },
    };
    const parsed = FleetHealthReportSchema.parse(withGate);
    expect(parsed.cronWakeGate).toBeDefined();
    expect(parsed.cronWakeGate?.fires).toEqual({ total: 5, skipped: 4, skipRate: 0.8 });
    // Net-cost legibility: BOTH the benefit (turnsSaved) and the cost (toolCalls)
    // survive .parse(), so an operator can compare a gate that costs more than it saves.
    expect(parsed.cronWakeGate?.turnsSaved).toBe(4);
    expect(parsed.cronWakeGate?.toolCalls).toBe(7);
    // The 100%-skip agent survives with skipRate === 1.0 (the suppression signal is visible).
    const agentB = parsed.cronWakeGate?.perAgent.find((a) => a.agentId === "agent-b");
    expect(agentB?.skipRate).toBe(1);
    // schemaVersion stays the literal 1 (additive, not a version bump).
    expect(parsed.schemaVersion).toBe(1);
  });

  it("treats `cronWakeGate` as optional (additive — a report WITHOUT it still parses, schemaVersion stays 1)", () => {
    const without = validReport() as Partial<FleetHealthReport>;
    expect(without).not.toHaveProperty("cronWakeGate"); // validReport() omits it.
    const parsed = FleetHealthReportSchema.parse(without);
    expect(parsed.cronWakeGate).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);
  });

  it("CONTENT-FREE: a smuggled gate script/payload key inside the cronWakeGate block is STRIPPED on parse", () => {
    // The block carries counts + agent ids ONLY. A caller who smuggles the gate's
    // gathered payload / script source must have it stripped by the non-strict
    // z.object — it can never reach the operator-facing report.
    const smuggled = {
      ...validReport(),
      cronWakeGate: {
        fires: { total: 1, skipped: 1, skipRate: 1 },
        turnsSaved: 1,
        toolCalls: 0,
        perAgent: [{ agentId: "agent-a", fires: 1, skipped: 1, skipRate: 1, turnsSaved: 1, toolCalls: 0 }],
        script: "gather the inbox then decide whether to wake", // smuggled gate script
        payload: "the gathered message body", // smuggled gathered payload
      },
    } as Record<string, unknown>;
    const parsed = FleetHealthReportSchema.parse(smuggled) as {
      cronWakeGate?: Record<string, unknown>;
    };
    expect(parsed.cronWakeGate).toBeDefined();
    expect(parsed.cronWakeGate).not.toHaveProperty("script");
    expect(parsed.cronWakeGate).not.toHaveProperty("payload");
    // The declared keys survive; only the smuggled ones are dropped.
    expect(parsed.cronWakeGate?.turnsSaved).toBe(1);
  });

  it("carries degradedByCause — a required bounded Record<cause, count> of named causes", () => {
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
    // pinning that FleetHealthReport is a DISTINCT shape, not an IncidentReport alias.
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
 * Contract-shape pins: the `obs.fleet.health` RPC contract is the
 * admin-scoped sibling of `obs.explain`. Without `ObsFleetHealthContract`
 * the import fails to compile and every case below fails (an absent symbol
 * IS the failure). GREEN once the `defineContract`
 * lands in this module and is registered in `OBSERVABILITY_CONTRACTS`.
 */
describe("ObsFleetHealthContract (admin-scoped fleet RPC contract)", () => {
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
