// SPDX-License-Identifier: Apache-2.0
/**
 * `obs.explain` handler acceptance tests.
 *
 * Drives the WIRED handler (resolver → readers → normalize → assemble →
 * heuristics → bound) against the two FROZEN fixtures via the
 * `incidentReader` injection seam (so the pipeline runs the REAL
 * `toIncidentSignals` + `assembleIncidentReport` + `rootCause` +
 * `boundIncidentReport` over real log-shaped records — only the file reads are
 * stubbed).
 *
 *   - the 678 fixture yields content_heuristic_misclassification + degraded +
 *     a non-empty breaker timeline + costUsd 1.320669; the 503 fixture yields
 *     breaker_opened_repeated_failure + web_fetch.
 *   - by-traceId == by-sessionKey: both 678 traceIds resolve (via the REAL
 *     resolveTraceToSession against a seeded session-index) to the one
 *     sessionKey → one assembler path → byte-identical reports.
 *   - depth:"summary" serializes ≤6144 bytes end-to-end and NEVER inlines the
 *     678 "SECURITY NOTICE" prompt-injection block (summary AND full).
 *
 * Plus the admin gate and the neither-id refine.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import type { IncidentReport } from "@comis/core";
import { systemDateFrom, systemNowMs } from "@comis/core";
import { bindObsExplainHandlers, assembleIncidentReportFromSources } from "./obs-explain.js";
import { assembleIncidentReport } from "./obs-explain-assemble.js";
import { toIncidentSignals } from "./obs-explain-signals.js";
import type { IncidentSourceReader } from "./obs-explain-readers.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";
// 5 levels up: obs-handlers → api → src → daemon → packages → repo-root.
import { loadFixture } from "../../../../../test/live/support/diagnosis-harness.js";

const FIXTURES = resolve(__dirname, "../../../../../test/live/fixtures/diagnosis");
const SESSION_678 = "default:678314278:678314278:peer:678314278";
const TRACE_678_A = "f942d38c-e372-43cc-99f1-ead4f0b8582f";
const TRACE_678_B = "058db0fe-651f-4362-908f-babd8208afa3";

// Minimal deps factory (mirrors obs-trace.test.ts) — only fields obs-explain reads.
function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return {
    agents: {},
    ...overrides,
  } as unknown as ObsHandlerDeps;
}

/**
 * A reader backed by a frozen fixture directory. `readSessionRecords` ignores
 * the sessionKey (returns the fixture's log lines for any key) so trace
 * resolution and direct-sessionKey paths exercise the SAME records.
 */
function makeFixtureReader(fixtureName: string): IncidentSourceReader {
  const { events, meta } = loadFixture(resolve(FIXTURES, fixtureName));
  return {
    readSessionRecords: async () => events,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => meta as Record<string, unknown>,
    readDiagnosticsRollup: async () => null,
  };
}

function todayKey(): string {
  return systemDateFrom(systemNowMs()).toISOString().slice(0, 10);
}

/**
 * Seed a `<dataDir>/logs/session-index.<today>.jsonl` mapping BOTH 678 traceIds
 * to the one sessionKey, so the REAL resolveTraceToSession canonicalizes either
 * traceId to SESSION_678 (the structural-identity proof).
 */
function seedSessionIndex(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-x1-"));
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `session-index.${todayKey()}.jsonl`);
  const rows = [
    JSON.stringify({ traceId: TRACE_678_A, sessionKey: SESSION_678, event: "session_started" }),
    JSON.stringify({ traceId: TRACE_678_B, sessionKey: SESSION_678, event: "turn_completed" }),
  ].join("\n");
  fs.writeFileSync(file, rows + "\n", "utf-8");
  return dataDir;
}

describe("bindObsExplainHandlers", () => {
  it("returns exactly one handler keyed obs.explain", () => {
    const handlers = bindObsExplainHandlers(makeDeps());
    expect(Object.keys(handlers)).toEqual(["obs.explain"]);
  });

  // ------------------------------------------------------------------------
  // The two frozen fixtures (the centerpiece acceptance).
  // ------------------------------------------------------------------------

  it("X3 (678): content_heuristic_misclassification + degraded + breaker timeline + costUsd 1.320669", async () => {
    const reader = makeFixtureReader("session-678314278");
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      _trustLevel: "admin",
    })) as IncidentReport;

    expect(r.outcome.degraded).toBe(true);
    expect(r.likelyRootCause?.code).toBe("content_heuristic_misclassification");
    expect(r.likelyRootCause?.detail).toMatch(/web_fetch/);
    expect(r.breakerTimeline.length).toBeGreaterThan(0);
    expect(r.cost.costUsd).toBeCloseTo(1.320669, 4);
  });

  it("X3 (503): breaker_opened_repeated_failure + offending toolName web_fetch", async () => {
    // The injected reader returns the 503 records for ANY sessionKey, so trace
    // resolution is bypassed (the 503 fixture has no real session-index row).
    const reader = makeFixtureReader("live-503-breaker");
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      traceId: "synthetic-live-503-breaker",
      _trustLevel: "admin",
    })) as IncidentReport;

    expect(r.likelyRootCause?.code).toBe("breaker_opened_repeated_failure");
    expect(r.likelyRootCause?.detail).toMatch(/web_fetch/);
    expect(r.outcome.degraded).toBe(true);
  });

  // ------------------------------------------------------------------------
  // The named degradation causes surface END-TO-END through the handler: the
  // metadata endReason flows to outcome.endReason AND drives likelyRootCause
  // (the handler threads it into signals before rootCause).
  // ------------------------------------------------------------------------

  it("QT2: a context_exhausted session (no tool failures) → outcome.endReason + likelyRootCause name the cause", async () => {
    const reader: IncidentSourceReader = {
      readSessionRecords: async () => [],
      readCacheTraceRecords: async () => [],
      readSessionMetadata: async () => ({
        agentId: "a1",
        sessionEnd: { type: "session_end", endReason: "context_exhausted", degraded: true },
      }),
      readDiagnosticsRollup: async () => null,
    };
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: "tenant_a:user_a:chan",
      _trustLevel: "admin",
    })) as IncidentReport;

    // The named cause shows in the outcome (free z.string passthrough)…
    expect(r.outcome.endReason).toBe("context_exhausted");
    expect(r.outcome.degraded).toBe(true);
    // …AND drives the deterministic verdict (handler threads endReason → rootCause).
    expect(r.likelyRootCause?.code).toBe("context_exhausted");
  });

  it("QT3: an output_starved session → likelyRootCause names output_starved", async () => {
    const reader: IncidentSourceReader = {
      readSessionRecords: async () => [],
      readCacheTraceRecords: async () => [],
      readSessionMetadata: async () => ({
        agentId: "a1",
        sessionEnd: { type: "session_end", endReason: "output_starved", degraded: true },
      }),
      readDiagnosticsRollup: async () => null,
    };
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: "tenant_a:user_a:chan",
      _trustLevel: "admin",
    })) as IncidentReport;

    expect(r.outcome.endReason).toBe("output_starved");
    expect(r.likelyRootCause?.code).toBe("output_starved");
  });

  // ------------------------------------------------------------------------
  // by-traceId == by-sessionKey (both 678 traceIds → one report).
  // ------------------------------------------------------------------------

  it("X1: by-sessionKey == by-traceId(A) == by-traceId(B) — identical reports", async () => {
    const dataDir = seedSessionIndex();
    const reader = makeFixtureReader("session-678314278");
    const handlers = bindObsExplainHandlers(makeDeps({ dataDir, incidentReader: reader }));

    const bySession = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      _trustLevel: "admin",
    })) as IncidentReport;
    const byTraceA = (await handlers["obs.explain"]!({
      traceId: TRACE_678_A,
      _trustLevel: "admin",
    })) as IncidentReport;
    const byTraceB = (await handlers["obs.explain"]!({
      traceId: TRACE_678_B,
      _trustLevel: "admin",
    })) as IncidentReport;

    expect(byTraceA).toEqual(bySession);
    expect(byTraceB).toEqual(bySession);
    // Sanity: the resolver actually produced the canonical sessionKey.
    expect(byTraceA.sessionKey).toBe(SESSION_678);
  });

  // ------------------------------------------------------------------------
  // depth:summary ≤6 KB, no raw body (end-to-end over a real fixture).
  // ------------------------------------------------------------------------

  it("X2 (summary): ≤6144 bytes, no SECURITY NOTICE inlined, errorPreview ≤200 chars", async () => {
    const reader = makeFixtureReader("session-678314278");
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      depth: "summary",
      _trustLevel: "admin",
    })) as IncidentReport;

    const serialized = JSON.stringify(r);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(6 * 1024);
    expect(serialized).not.toContain("SECURITY NOTICE");
    for (const f of r.failures) {
      expect(f.errorPreview.length).toBeLessThanOrEqual(200);
    }
  });

  it("X2 (full): SECURITY NOTICE still never inlined (digest-only is depth-independent)", async () => {
    const reader = makeFixtureReader("session-678314278");
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      depth: "full",
      _trustLevel: "admin",
    })) as IncidentReport;
    expect(JSON.stringify(r)).not.toContain("SECURITY NOTICE");
  });

  it("X2: default depth (omitted) behaves as summary (≤6144 bytes)", async () => {
    const reader = makeFixtureReader("session-678314278");
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      _trustLevel: "admin",
    })) as IncidentReport;
    expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBeLessThanOrEqual(6 * 1024);
  });

  // ------------------------------------------------------------------------
  // Trust boundary — admin gate + neither-id refine.
  // ------------------------------------------------------------------------

  it("admin gate: missing _trustLevel:admin throws", async () => {
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: makeFixtureReader("session-678314278") }));
    await expect(handlers["obs.explain"]!({ sessionKey: SESSION_678 })).rejects.toThrow(/Admin/i);
    await expect(handlers["obs.explain"]!({ sessionKey: SESSION_678, _trustLevel: "user" })).rejects.toThrow(/Admin/i);
  });

  it("refine: neither sessionKey nor traceId throws (request.parse refine)", async () => {
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: makeFixtureReader("session-678314278") }));
    await expect(handlers["obs.explain"]!({ _trustLevel: "admin" })).rejects.toThrow();
  });

  it("stripInternalFields: _trustLevel never reaches the parsed params", async () => {
    // A smuggled internal field must not appear in the report (it is stripped
    // before parse). The handler succeeds and the report has no _trustLevel.
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: makeFixtureReader("session-678314278") }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      _trustLevel: "admin",
    })) as IncidentReport & { _trustLevel?: unknown };
    expect(r._trustLevel).toBeUndefined();
  });

  // ------------------------------------------------------------------------
  // Production default reader (no injected reader) — exercises makeRealReader.
  // ------------------------------------------------------------------------

  it("default reader (no injection): missing session soft-fails to an empty report (no throw)", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-empty-"));
    const handlers = bindObsExplainHandlers(makeDeps({ dataDir }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: "default:nope:nope:peer:nope",
      _trustLevel: "admin",
    })) as IncidentReport;
    // No data on disk → a well-formed empty post-mortem, not an exception.
    expect(r.failures).toEqual([]);
    expect(r.likelyRootCause).toBeNull();
  });

  // ------------------------------------------------------------------------
  // An unresolvable traceId must be DISTINGUISHABLE from a clean, empty
  // session. Pre-fix both yielded the same empty report keyed on "".
  // ------------------------------------------------------------------------

  it("WR-04: an unresolvable traceId yields a session_not_found marker, not a silent empty report", async () => {
    // Empty dataDir → no session-index files → resolveTraceToSession returns "".
    // The report must SIGNAL the unresolvability rather than masquerade as a
    // healthy zero-activity session.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-unresolved-"));
    const handlers = bindObsExplainHandlers(makeDeps({ dataDir }));
    const r = (await handlers["obs.explain"]!({
      traceId: "no-such-trace-id-deadbeef",
      _trustLevel: "admin",
    })) as IncidentReport;
    // No throw (no-throw posture preserved), but an explicit not-found signal.
    expect(r.likelyRootCause).not.toBeNull();
    expect(r.likelyRootCause?.code).toBe("session_not_found");
    expect(r.likelyRootCause?.detail).toMatch(/trace/i);
    // And an honest truncations[] note so a consumer scanning the ledger sees it.
    expect(
      r.truncations.some(
        (t) => t.field === "traceId" && /not\s*found|unresolv/i.test(t.reason),
      ),
    ).toBe(true);
    // The empty session report is still well-formed (no leak, no crash).
    expect(r.failures).toEqual([]);
  });

  it("WR-04: an EMPTY but RESOLVED session keeps the no-throw, null-rootCause behavior (only the UNRESOLVED case is marked)", async () => {
    // A real sessionKey that simply has no telemetry on disk must NOT be tagged
    // session_not_found — it resolved fine; it is just empty. Only the
    // unresolved-traceId case gets the marker.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-clean-empty-"));
    const handlers = bindObsExplainHandlers(makeDeps({ dataDir }));
    const r = (await handlers["obs.explain"]!({
      sessionKey: "default:clean:clean:peer:clean",
      _trustLevel: "admin",
    })) as IncidentReport;
    expect(r.likelyRootCause).toBeNull();
    expect(r.truncations.some((t) => t.field === "traceId")).toBe(false);
  });
});

// ===========================================================================
// assembleIncidentReportFromSources — the extracted shared assembler.
// ===========================================================================
//
// The post-gate assembler body (resolve → read → signals → assemble →
// rootCause + not-found marker → bound) is extracted so the admin RPC handler (which keeps
// its admin gate) AND the operator-allowlisted obs_explain MCP tool (which has
// NO admin gate — its authorization is the per-client allowlist) share ONE
// frozen pipeline. The extracted fn takes ALREADY-VALIDATED params and contains
// NO admin check and NO contract.request.parse — it is reachable under daemon
// authority directly. These tests pin that seam: the fn produces the SAME
// report as the RPC handler for the SAME inputs, WITHOUT any _trustLevel param.
describe("assembleIncidentReportFromSources", () => {
  it("X3 (678): produces content_heuristic_misclassification + degraded + breaker timeline WITHOUT any admin/_trustLevel param", async () => {
    // The seam the obs_explain MCP path uses: call the EXTRACTED assembler
    // DIRECTLY (no admin gate, no contract parse, no _trustLevel) with the SAME
    // 678 fixture reader the admin RPC test uses, and prove it yields the SAME
    // verdict. This is the byte-identical-behavior proof for the extraction.
    const reader = makeFixtureReader("session-678314278");
    const report = await assembleIncidentReportFromSources(reader, ".", {
      sessionKey: SESSION_678,
    });

    expect(report.likelyRootCause?.code).toBe("content_heuristic_misclassification");
    expect(report.likelyRootCause?.detail).toMatch(/web_fetch/);
    expect(report.outcome.degraded).toBe(true);
    expect(report.breakerTimeline.length).toBeGreaterThan(0);
    expect(report.cost.costUsd).toBeCloseTo(1.320669, 4);
  });

  it("parity: the extracted assembler equals the admin RPC handler output for the same 678 inputs", async () => {
    // Defense against drift: the admin RPC path (Step 1 gate → Step 2 parse →
    // assembler) and the direct assembler call MUST yield byte-identical reports
    // for the same fixture + sessionKey. The only difference between the two
    // paths is the gate/parse the RPC handler adds BEFORE delegating.
    const reader = makeFixtureReader("session-678314278");
    const handlers = bindObsExplainHandlers(makeDeps({ incidentReader: reader }));
    const viaRpc = (await handlers["obs.explain"]!({
      sessionKey: SESSION_678,
      depth: "summary",
      _trustLevel: "admin",
    })) as IncidentReport;
    const viaAssembler = await assembleIncidentReportFromSources(
      makeFixtureReader("session-678314278"),
      ".",
      { sessionKey: SESSION_678, depth: "summary" },
    );
    expect(viaAssembler).toEqual(viaRpc);
  });

  it("WR-04: an unresolvable traceId yields session_not_found via the extracted fn (no admin needed)", async () => {
    // The not-found marker logic lives INSIDE the extracted fn, so the MCP
    // path inherits the honest not-found verdict. Empty dataDir → resolve "".
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-explain-asm-unresolved-"));
    const report = await assembleIncidentReportFromSources(
      makeDeps({ dataDir }).incidentReader ??
        // No injected reader → exercise the production makeRealReader over the
        // empty dataDir (mirrors the RPC handler's default-reader path).
        (await import("./obs-explain-readers.js")).makeRealReader(dataDir),
      dataDir,
      { traceId: "no-such-trace-id-deadbeef" },
    );
    expect(report.likelyRootCause?.code).toBe("session_not_found");
    expect(
      report.truncations.some(
        (t) => t.field === "traceId" && /not\s*found|unresolv/i.test(t.reason),
      ),
    ).toBe(true);
    expect(report.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// proxyPosture — IncidentReport additive field.
//
// Two surfaces:
//  1. assembleIncidentReport: spreads signals.proxyPosture presence-conditionally
//     (the voice/learning precedent — no proxyPosture key when undefined).
//  2. assembleIncidentReportFromSources: reads config_posture obsStore row,
//     populates signals.proxyPosture before assembly (the handler did not
//     previously read config_posture rows). Optional obsStore dep: absent → no
//     proxyPosture. maskedUrl + booleans only — never a raw proxy URL.
// ---------------------------------------------------------------------------

describe("DIAG-03 — proxyPosture on IncidentReport (assembler spread + handler read)", () => {
  /** Minimal IncidentSignals fixture for assembler tests (only required fields). */
  function makeMinimalSignals(
    overrides: Partial<Parameters<typeof toIncidentSignals>[0][0]> = {},
  ) {
    return toIncidentSignals([]);
  }

  it("assembleIncidentReport spreads proxyPosture when signals.proxyPosture is defined", () => {
    const signals = makeMinimalSignals();
    signals.proxyPosture = {
      configured: true,
      maskedUrl: "http://proxy.example.com",
      loopbackMode: "gateway-only",
      source: "config",
      installerOk: true,
    };
    const report = assembleIncidentReport(signals, null, null, "test-session-key", 0);
    expect((report as Record<string, unknown>)["proxyPosture"]).toEqual({
      configured: true,
      maskedUrl: "http://proxy.example.com",
      loopbackMode: "gateway-only",
      source: "config",
      installerOk: true,
    });
  });

  it("assembleIncidentReport does NOT include proxyPosture key when signals.proxyPosture is undefined", () => {
    const signals = makeMinimalSignals();
    // signals.proxyPosture is undefined (no proxy)
    const report = assembleIncidentReport(signals, null, null, "test-session-key", 0);
    expect(Object.prototype.hasOwnProperty.call(report, "proxyPosture")).toBe(false);
  });

  it("assembleIncidentReportFromSources populates report.proxyPosture from obsStore config_posture row", async () => {
    const configPostureRow = {
      timestamp: 1000,
      category: "config_posture",
      severity: "info" as const,
      message: "config_posture",
      details: JSON.stringify({
        tlsOff: false,
        allowInsecureHttp: false,
        stranded: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        chimericModelCount: 0,
        pricingGapCount: 0,
        proxyInstallerStatus: { installerError: null, effectiveLoopbackMode: "gateway-only" },
      }),
    };
    const mockObsStore = {
      insertDiagnostic: vi.fn(),
      queryDiagnostics: vi.fn().mockReturnValue([configPostureRow]),
    };
    const emptyReader: IncidentSourceReader = {
      readSessionRecords: async () => [],
      readCacheTraceRecords: async () => [],
      readSessionMetadata: async () => null,
      readDiagnosticsRollup: async () => null,
    };
    const report = await assembleIncidentReportFromSources(
      emptyReader,
      ".",
      { sessionKey: "test-key", depth: "summary" },
      mockObsStore as unknown as import("@comis/memory").ObservabilityStore,
    );
    // Proxy was configured (proxyInstallerStatus present) → proxyPosture should appear
    expect((report as Record<string, unknown>)["proxyPosture"]).toBeDefined();
    // SECURITY: must not expose raw URL
    expect(JSON.stringify(report)).not.toMatch(/https?:\/\/.*@/);
  });

  it("assembleIncidentReportFromSources leaves proxyPosture absent when no config_posture row (zero-config)", async () => {
    const mockObsStore = {
      insertDiagnostic: vi.fn(),
      queryDiagnostics: vi.fn().mockReturnValue([]),
    };
    const emptyReader: IncidentSourceReader = {
      readSessionRecords: async () => [],
      readCacheTraceRecords: async () => [],
      readSessionMetadata: async () => null,
      readDiagnosticsRollup: async () => null,
    };
    const report = await assembleIncidentReportFromSources(
      emptyReader,
      ".",
      { sessionKey: "test-key", depth: "summary" },
      mockObsStore as unknown as import("@comis/memory").ObservabilityStore,
    );
    expect(Object.prototype.hasOwnProperty.call(report, "proxyPosture")).toBe(false);
  });

  it("assembleIncidentReportFromSources leaves proxyPosture absent when obsStore is undefined (no persistence)", async () => {
    const emptyReader: IncidentSourceReader = {
      readSessionRecords: async () => [],
      readCacheTraceRecords: async () => [],
      readSessionMetadata: async () => null,
      readDiagnosticsRollup: async () => null,
    };
    const report = await assembleIncidentReportFromSources(
      emptyReader,
      ".",
      { sessionKey: "test-key", depth: "summary" },
      // no obsStore
    );
    expect(Object.prototype.hasOwnProperty.call(report, "proxyPosture")).toBe(false);
  });
});
