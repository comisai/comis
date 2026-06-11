// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { DiagnosticRow, ObservabilityStore } from "@comis/memory";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { buildConfigPostureRecord } from "./build-config-posture-record.js";

// ---------------------------------------------------------------------------
// buildConfigPostureRecord (I3 — boot-time config_posture snapshot row)
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
    // EXACTLY the four closed keys — counts + booleans + closed labels only.
    // WR-01: the canary field is an HONEST boolean (0|N presence proxy keyed on
    // CANARY_SECRET in env-or-store), NOT a misleading per-agent tally.
    expect(details).toEqual({
      tlsOff: true,
      allowInsecureHttp: false,
      stranded: [{ stranded: "encrypted:secrets", entryCount: 2 }],
      canaryFallbackActive: true,
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
    });
  });

  it("flips severity to warning when ANY single posture issue is present", () => {
    const clock = createFakeClock(1);

    // tlsOff alone
    {
      const { obsStore, insertDiagnostic } = createSpiedObsStore();
      buildConfigPostureRecord(
        obsStore,
        { tlsOff: true, allowInsecureHttp: false, strandedFindings: [], canaryFallbackActive: false },
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
        { tlsOff: false, allowInsecureHttp: false, strandedFindings: [], canaryFallbackActive: true },
        clock,
      );
      expect((insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow).severity).toBe("warning");
    }
  });

  it("no-ops without throwing when persistence is disabled (obsStore undefined)", () => {
    const clock = createFakeClock(3000);

    // The ?.-chained call must silently no-op — a disabled-persistence boot
    // cannot crash shutdown (Pitfall 5).
    expect(() =>
      buildConfigPostureRecord(
        undefined,
        {
          tlsOff: true,
          allowInsecureHttp: false,
          strandedFindings: [{ stranded: "encrypted:secrets", entryCount: 5 }],
          canaryFallbackActive: true,
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
      { tlsOff: false, allowInsecureHttp: false, strandedFindings: [], canaryFallbackActive: false },
      clock,
    );

    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    // 42 + 8 = 50 — the fake clock's value, proving no Date.now() leak.
    expect(row.timestamp).toBe(50);
  });

  // -------------------------------------------------------------------------
  // KNOB-03 (Phase 176): servedBelowConfiguredCount — providers whose
  // Ollama-served window < configured at the latest boot. A COUNT, never
  // provider names (the record's counts/booleans-only contract). The count
  // alone must flip severity to "warning" (Pitfall 10: forget the hasIssue OR
  // and severity stays "info" while the fleet finding fires).
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
});
