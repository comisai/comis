// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { DiagnosticRow, ObservabilityStore } from "@comis/memory";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { buildConfigPostureRecord, countPricingGaps, countUnresolvedModels, countMediaCredentialGaps, isLoopbackHost } from "./build-config-posture-record.js";
import { unresolvedModelFromRow } from "../api/obs-handlers/fleet-findings-extractors.js";

describe("isLoopbackHost (TLS-off is benign on a loopback bind)", () => {
  it("treats 127.0.0.1 / ::1 / localhost / 127.x as loopback (TLS-off suppressed)", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", "127.0.1.1", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });
  it("treats 0.0.0.0 / a routable IP / undefined as NON-loopback (TLS-off still flags)", () => {
    for (const h of ["0.0.0.0", "10.0.0.5", "2.25.210.60", "example.com", undefined]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildConfigPostureRecord (boot-time config_posture snapshot row)
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
      unresolvedModelCount: 0, // always present (0 default), count-only
      pricingGapCount: 0, // always present (0 default), count-only
      sandboxNoDowngradeDisabled: false, // always present (false default)
      mediaCredentialGapCount: 0, // always present (0 default), count-only
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
      unresolvedModelCount: 0,
      pricingGapCount: 0,
      sandboxNoDowngradeDisabled: false,
      mediaCredentialGapCount: 0,
    });
  });

  it("flips severity to warning and carries the count when a chimeric provider/model is configured", () => {
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

  it("RELAX-SURFACE: flips severity to warning and surfaces the flag when sandboxNoDowngrade is disabled", () => {
    // security.agentToAgent.sandboxNoDowngrade:false is a RELAXED security default
    // (a child may run with a weaker sandbox posture than its parent). Track-M wants
    // a relaxed default SURFACED at boot, not silent. Pre-fix there was no signal.
    const { obsStore, insertDiagnostic } = createSpiedObsStore();
    const clock = createFakeClock(7);
    buildConfigPostureRecord(
      obsStore,
      {
        tlsOff: false,
        allowInsecureHttp: false,
        strandedFindings: [],
        canaryFallbackActive: false,
        servedBelowConfiguredCount: 0,
        sandboxNoDowngradeDisabled: true,
      },
      clock,
    );
    const row = insertDiagnostic.mock.calls[0]?.[0] as DiagnosticRow;
    expect(row.severity).toBe("warning");
    const details = JSON.parse(row.details ?? "{}") as { sandboxNoDowngradeDisabled?: boolean };
    expect(details.sandboxNoDowngradeDisabled).toBe(true);
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
  // servedBelowConfiguredCount — providers whose
  // Ollama-served window < configured at the latest boot. A COUNT, never
  // provider names (the record's counts/booleans-only contract). The count
  // alone must flip severity to "warning" (if the hasIssue OR forgets this
  // count, severity stays "info" while the fleet finding fires).
  // -------------------------------------------------------------------------

  it("flips severity to warning when ONLY servedBelowConfiguredCount is non-zero, and carries the count in details", () => {
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

  it("keeps severity info when servedBelowConfiguredCount is 0 and all else is healthy, and details carries the 0", () => {
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
  // pricingGapCount — configured agents burning tokens on
  // remote-unknown-priced models (resolvePricingState == "unknown"). A COUNT,
  // never agent ids / model names (the no-free-text contract). The count alone
  // must flip severity to "warning" (the served-below/chimeric hasIssue precedent).
  // -------------------------------------------------------------------------

  it("flips severity to warning when ONLY pricingGapCount is non-zero, and carries the count in details", () => {
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

  it("keeps severity info when pricingGapCount is 0 and all else is healthy, and details carries the 0", () => {
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
});

// ---------------------------------------------------------------------------
// countPricingGaps — the boot producer counting configured
// agents whose provider+model resolves to the "unknown" pricing state (a NATIVE
// provider with no catalog entry — the fail-open). A "free" local/gateway
// agent (honest $0) is NOT counted; a "priced" agent is NOT counted. Co-located
// with countChimericModels (keeps daemon.ts under its 3000-line cap). Uses the
// shipped 3-state `resolvePricingState`, never a catalog-presence boolean.
// ---------------------------------------------------------------------------

describe("countUnresolvedModels — boot count of agents whose model id does NOT resolve (fail-closed-to-nano, IB-17)", () => {
  it("counts an unresolved model id on a registered provider (the live gpt-5.6 case)", () => {
    // openai-codex has NO bare 'gpt-5.6' (real ids: gpt-5.6-terra/luna/sol). Neither
    // the chimeric nor the pricing detector catches this (openai-codex resolves 'free').
    const agents = { a: { provider: "openai-codex", model: "gpt-5.6" } };
    expect(countUnresolvedModels(agents, undefined)).toBe(1);
  });

  it("does NOT count a resolved catalog model id", () => {
    const agents = {
      sol: { provider: "openai-codex", model: "gpt-5.6-sol" },
      g54: { provider: "openai-codex", model: "gpt-5.4" },
    };
    expect(countUnresolvedModels(agents, undefined)).toBe(0);
  });

  it("EXEMPTS an operator-declared custom model (providers.entries.<p>.models) — no false-flag", () => {
    const agents = { a: { provider: "my-ollama", model: "qwen3.6:35b" } };
    const providers = { "my-ollama": { models: [{ id: "qwen3.6:35b" }] } };
    // Without the exemption this would count (not in the static catalog); with it → 0.
    expect(countUnresolvedModels(agents, providers)).toBe(0);
    // And a DIFFERENT model on that custom provider (not declared) still counts.
    expect(countUnresolvedModels({ a: { provider: "my-ollama", model: "not-declared" } }, providers)).toBe(1);
  });

  it("counts only the unresolved agents in a mixed fleet", () => {
    const agents = {
      ok: { provider: "openai-codex", model: "gpt-5.6-sol" }, // resolves
      bad1: { provider: "openai-codex", model: "gpt-5.6" }, // unresolved
      bad2: { provider: "anthropic", model: "totally-made-up-model-xyz" }, // unresolved
    };
    expect(countUnresolvedModels(agents, undefined)).toBe(2);
  });

  it("ignores an agent missing provider or model", () => {
    expect(countUnresolvedModels({ noModel: { provider: "openai-codex" }, noProvider: { model: "x" }, empty: {} }, undefined)).toBe(0);
  });

  it("unresolvedModelFromRow parses the count from a config_posture row (fleet surfacing)", () => {
    expect(unresolvedModelFromRow({ details: JSON.stringify({ unresolvedModelCount: 2 }) } as never)).toBe(2);
    expect(unresolvedModelFromRow({ details: JSON.stringify({ unresolvedModelCount: 0 }) } as never)).toBe(0);
    expect(unresolvedModelFromRow({ details: "not json" } as never)).toBe(0);
    expect(unresolvedModelFromRow({ details: undefined } as never)).toBe(0);
  });
});

describe("countPricingGaps — boot count of remote-unknown-priced agents (resolvePricingState == 'unknown')", () => {
  it("counts a NATIVE provider + an off-catalog model (the unknown-pricing case)", () => {
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

// ---------------------------------------------------------------------------
// countMediaCredentialGaps — a configured media provider whose credential is
// absent will FAIL at first use, but the chimeric/credential detector only
// watched the main completion pipeline, so the media gap was invisible to
// `comis fleet` (the incident-day image-gen unavailability, 2026-07-08). This
// makes it a boot-time posture COUNT.
// ---------------------------------------------------------------------------
describe("countMediaCredentialGaps — configured media provider missing its credential", () => {
  const hasNone = () => false;
  const hasAll = () => true;

  it("flags an env-key media provider whose key is absent (per pipeline)", () => {
    const media = {
      imageGeneration: { provider: "openai" },
      transcription: { provider: "groq" },
      tts: { provider: "elevenlabs" },
      videoGeneration: { provider: "xai" },
    };
    expect(countMediaCredentialGaps(media, hasNone, false)).toBe(4);
    expect(countMediaCredentialGaps(media, hasAll, true)).toBe(0);
  });

  it("checks the RIGHT env key per provider", () => {
    const present = new Set(["OPENAI_API_KEY"]); // only openai present
    const has = (k: string) => present.has(k);
    // image openai (present) → ok; tts elevenlabs (absent) → gap.
    expect(countMediaCredentialGaps(
      { imageGeneration: { provider: "openai" }, tts: { provider: "elevenlabs" } },
      has, false,
    )).toBe(1);
  });

  it("openai-codex uses the store-aware image availability, not an env key", () => {
    const media = { imageGeneration: { provider: "openai-codex" } };
    expect(countMediaCredentialGaps(media, hasNone, /* imageCodexAvailable */ true)).toBe(0);
    expect(countMediaCredentialGaps(media, hasNone, /* imageCodexAvailable */ false)).toBe(1);
  });

  it("keyless / follow-main providers never count (auto, local, edge, piper)", () => {
    const media = {
      imageGeneration: { provider: "auto" },
      transcription: { provider: "local" },
      tts: { provider: "edge" },
      videoGeneration: { provider: "auto" },
    };
    expect(countMediaCredentialGaps(media, hasNone, false)).toBe(0);
  });

  it("undefined media / unknown provider is a safe zero (no false flag)", () => {
    expect(countMediaCredentialGaps(undefined, hasNone, false)).toBe(0);
    expect(countMediaCredentialGaps({ tts: { provider: "piper" } }, hasNone, false)).toBe(0);
  });
});
