// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { DiagnosticRow, ObservabilityStore } from "@comis/memory";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { buildConfigPostureRecord, countPricingGaps } from "./build-config-posture-record.js";

// ---------------------------------------------------------------------------
// buildConfigPostureRecord — boot-time config_posture snapshot row
//
// A one-shot direct insertDiagnostic at boot capturing the three log-file-only
// posture FINDINGS (TLS-off / stranded-secret COUNTS / canary-fallback) as a
// point-in-time snapshot. NOT an event. `details` carries booleans + counts +
// closed stranded labels ONLY — NEVER a secret value.
// ---------------------------------------------------------------------------

/**
 * Minimal ObservabilityStore stub exposing only the method the SUT calls
 * (insertDiagnostic), with that method spied. Everything else is a never —
 * buildConfigPostureRecord must touch nothing but insertDiagnostic.
 */
function createSpiedObsStore(): {
  obsStore: ObservabilityStore;
  insertDiagnostic: ReturnType<typeof vi.fn>;
} {
  const insertDiagnostic = vi.fn<(entry: DiagnosticRow) => void>();
  const obsStore = { insertDiagnostic } as unknown as ObservabilityStore;
  return { obsStore, insertDiagnostic };
}

describe("buildConfigPostureRecord", () => {
  it("writes a config_posture row (severity warning) with stranded COUNTS and no secret value when any posture issue is present", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(2000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: true,
        allowInsecureHttp: false,
        strandedFindings: [{ stranded: "encrypted:secrets", entryCount: 2 }],
        canaryFallbackActive: true,
        servedBelowConfiguredCount: 0,
      },
      clock,
    );

    expect(insertDiagnostic).toHaveBeenCalledTimes(1);
    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.timestamp).toBe(2000);
    expect(row.category).toBe("config_posture");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("config_posture");

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // EXACTLY the five closed keys — counts + booleans + closed labels only.
    // The canary field is an HONEST boolean (0|N presence proxy keyed on
    // CANARY_SECRET in env-or-store), NOT a misleading per-agent tally.
    // servedBelowConfiguredCount is a COUNT, never provider names.
    expect(details).toEqual({
      tlsOff: true,
      allowInsecureHttp: false,
      stranded: [{ stranded: "encrypted:secrets", entryCount: 2 }],
      canaryFallbackActive: true,
      servedBelowConfiguredCount: 0,
      chimericModelCount: 0, // always present (0 default), count-only
      pricingGapCount: 0, // always present (0 default), count-only
    });
    // SECURITY: the stranded entry is a {label, count} — no value-bearing key.
    const strandedJson = JSON.stringify(details["stranded"]);
    expect(strandedJson).not.toMatch(/value|secret"\s*:|password|token"\s*:/i);
  });

  it("uses severity info when posture is clean (no tlsOff, no stranded, no canary fallback)", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(1000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: true,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("info");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({
      tlsOff: false,
      allowInsecureHttp: true,
      stranded: [],
      canaryFallbackActive: false,
      servedBelowConfiguredCount: 0,
      chimericModelCount: 0,
      pricingGapCount: 0,
    });
  });

  it("RESOLVE-01: flips severity to warning and carries the count when a chimeric provider/model is configured", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(1);
    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        chimericModelCount: 2,
      },
      clock,
    );
    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("warning");
    const details = JSON.parse(row.details ?? "{}") as { chimericModelCount?: number };
    expect(details.chimericModelCount).toBe(2);
  });

  it("flips severity to warning when ANY single posture issue is present", () => {
    const clock = createFakeClock(1);

    // tlsOff alone
    {
      const { obsStore, insertDiagnostic } = createSpiedObsStore();
      buildConfigPostureRecord(
        obsStore,
        { tlsOff: true, allowInsecureHttp: false, strandedFindings: [], canaryFallbackActive: false, servedBelowConfiguredCount: 0 },
        clock,
      );
      expect((insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow).severity).toBe("warning");
    }
    // stranded alone
    {
      const { obsStore, insertDiagnostic } = createSpiedObsStore();
      buildConfigPostureRecord(
        obsStore,
        {
          tlsOff: false,
          allowInsecureHttp: false,
          strandedFindings: [{ stranded: "file:secrets", entryCount: 1 }],
          canaryFallbackActive: false,
          servedBelowConfiguredCount: 0,
        },
        clock,
      );
      expect((insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow).severity).toBe("warning");
    }
    // canaryFallbackActive true alone
    {
      const { obsStore, insertDiagnostic } = createSpiedObsStore();
      buildConfigPostureRecord(
        obsStore,
        { tlsOff: false, allowInsecureHttp: false, strandedFindings: [], canaryFallbackActive: true, servedBelowConfiguredCount: 0 },
        clock,
      );
      expect((insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow).severity).toBe("warning");
    }
  });

  it("no-ops without throwing when persistence is disabled (obsStore undefined)", () => {
    const clock = createFakeClock(3000);

    // The ?.-chained call must silently no-op — a disabled-persistence boot
    // cannot crash shutdown.
    expect(() =>
      buildConfigPostureRecord(
        undefined,
        {
          tlsOff: true,
          allowInsecureHttp: false,
          strandedFindings: [{ stranded: "encrypted:secrets", entryCount: 5 }],
          canaryFallbackActive: true,
          servedBelowConfiguredCount: 0,
        },
        clock,
      ),
    ).not.toThrow();
  });

  it("reads the timestamp from the injected clock, not wall-clock (no Date.now)", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(42);
    // Advance the fake clock so its value is unmistakably not a wall-clock epoch.
    clock.advance(8);

    buildConfigPostureRecord(
      obsStore,
      { tlsOff: false, allowInsecureHttp: false, strandedFindings: [], canaryFallbackActive: false, servedBelowConfiguredCount: 0 },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    // 42 + 8 = 50 — the fake clock's value, proving no Date.now() leak.
    expect(row.timestamp).toBe(50);
  });

  // -------------------------------------------------------------------------
  // servedBelowConfiguredCount — providers whose Ollama-served window <
  // configured at the latest boot. A COUNT, never provider names (the record's
  // counts/booleans-only contract). The count alone must flip severity to
  // "warning" (forget the hasIssue OR and severity stays "info" while the fleet
  // finding fires).
  // -------------------------------------------------------------------------

  it("KNOB-03-1: flips severity to warning when ONLY servedBelowConfiguredCount is non-zero, and carries the count in details", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(7000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 1,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("warning");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details["servedBelowConfiguredCount"]).toBe(1);
  });

  it("KNOB-03-2: keeps severity info when servedBelowConfiguredCount is 0 and all else is healthy, and details carries the 0", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(8000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("info");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details["servedBelowConfiguredCount"]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // pricingGapCount — configured agents burning tokens on remote-unknown-priced
  // models (resolvePricingState == "unknown"). A COUNT, never agent ids / model
  // names (the no-free-text contract). The count alone must flip severity to
  // "warning" (the served-below/chimeric hasIssue precedent).
  // -------------------------------------------------------------------------

  it("SPEND-05-1: flips severity to warning when ONLY pricingGapCount is non-zero, and carries the count in details", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(9000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        pricingGapCount: 2,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("warning");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details["pricingGapCount"]).toBe(2);
  });

  it("SPEND-05-2: keeps severity info when pricingGapCount is 0 and all else is healthy, and details carries the 0", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(10_000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        pricingGapCount: 0,
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("info");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details["pricingGapCount"]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // proxyInstallerStatus — additive field in config_posture details JSON
  // surfacing the proxy boot outcome for fleet/explain diagnosability.
  // -------------------------------------------------------------------------

  it("DIAG-03-1: proxyInstallerStatus appears in details JSON when provided (installer failed with configKey)", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(5000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        proxyInstallerStatus: {
          installerError: "proxy.proxyUrl",
          effectiveLoopbackMode: "gateway-only",
        },
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details["proxyInstallerStatus"]).toEqual({
      installerError: "proxy.proxyUrl",
      effectiveLoopbackMode: "gateway-only",
    });
    // SECURITY: raw proxy URL must never appear in details
    expect(JSON.stringify(details)).not.toMatch(/https?:\/\//);
  });

  it("DIAG-03-2: proxyInstallerStatus key is ABSENT from details JSON when input is undefined (zero-config path)", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(6000);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        // proxyInstallerStatus intentionally absent
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(details, "proxyInstallerStatus")).toBe(false);
  });

  it("DIAG-03-3: proxyInstallerStatus with installerError null (success case) appears in details without altering severity", () => {
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(7500);

    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        proxyInstallerStatus: {
          installerError: null,
          effectiveLoopbackMode: "proxy",
        },
      },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    // Severity: no other posture issue → info (proxy success doesn't flip to warning)
    expect(row.severity).toBe("info");
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details["proxyInstallerStatus"]).toEqual({
      installerError: null,
      effectiveLoopbackMode: "proxy",
    });
  });
});

// ---------------------------------------------------------------------------
// countPricingGaps — the boot producer counting configured agents whose
// provider+model resolves to the "unknown" pricing state (a NATIVE provider with
// no catalog entry — the ffe11736 fail-open). A "free" local/gateway agent
// (honest $0) is NOT counted; a "priced" agent is NOT counted. Co-located with
// countChimericModels (keeps daemon.ts under its 3000-line cap). Uses the shipped
// 3-state `resolvePricingState`, never a catalog-presence boolean.
// ---------------------------------------------------------------------------

describe("countPricingGaps — boot count of remote-unknown-priced agents (resolvePricingState == 'unknown')", () => {
  it("counts a NATIVE provider + an off-catalog model (the unknown / ffe11736 case)", () => {
    // anthropic is a native single-family provider; a non-claude model id has no
    // catalog rate → resolvePricingState returns "unknown".
    const agents = {
      a: { provider: "anthropic", model: "qwen3-32b" },
    };
    expect(countPricingGaps(agents)).toBe(1);
  });

  it("does NOT count a 'free' local/gateway provider (honest $0 is correct, not a gap)", () => {
    // ollama is NOT in NATIVE_PROVIDER_FAMILY → "free", never "unknown".
    const agents = {
      a: { provider: "ollama", model: "qwen3:32b" },
    };
    expect(countPricingGaps(agents)).toBe(0);
  });

  it("does NOT count a 'priced' agent (a real catalog rate)", () => {
    // anthropic + a real claude model has a catalog rate → "priced".
    const agents = {
      a: { provider: "anthropic", model: "claude-sonnet-4-5" },
    };
    expect(countPricingGaps(agents)).toBe(0);
  });

  it("counts only the unknown-priced agents in a mixed fleet (no false-flag of free/priced)", () => {
    const agents = {
      free: { provider: "ollama", model: "qwen3:32b" }, // free
      priced: { provider: "anthropic", model: "claude-sonnet-4-5" }, // priced
      gap1: { provider: "anthropic", model: "qwen3-32b" }, // unknown
      gap2: { provider: "openai", model: "some-uncatalogued-model-xyz" }, // unknown (native, off-catalog)
    };
    expect(countPricingGaps(agents)).toBe(2);
  });

  it("ignores an agent missing provider or model (cannot resolve a state → not a gap)", () => {
    const agents = {
      noModel: { provider: "anthropic" },
      noProvider: { model: "qwen3-32b" },
      empty: {},
    };
    expect(countPricingGaps(agents)).toBe(0);
  });
});
