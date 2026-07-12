// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DiagnosticRow } from "@comis/memory";
import { buildFindings, pipelineAuthoringAggregateFromRows } from "./fleet-findings.js";
import { orchestrateEfficiencyFromRow, pricingGapFromRow } from "./fleet-findings-extractors.js";

// ---------------------------------------------------------------------------
// The dedicated multilingual fleet advisory (standing state).
//
// buildFindings is a PURE rows -> findings transform. The advisory reads
// the LATEST (max-timestamp) `model_health` row's details JSON and emits ONE
// finding per non-multilingual lane (embedder / reranker). It is STANDING STATE,
// not a count over rows (a daemon that rebooted N times must NOT show
// "N non-multilingual signals"; mirrors the served-below-configured latest-row
// pattern). The parse is defensive (malformed/missing folds to no-advisory, never
// throws, never echoes a body). ADVISORY ONLY — buildFindings touches no
// recall/search path.
// ---------------------------------------------------------------------------

const EMBED_CODE = "model_health:embedder_not_multilingual";
const RERANK_CODE = "model_health:reranker_not_multilingual";

/** A model_health row at `ts` carrying the given multilingual flags in details. */
function modelHealthRow(
  ts: number,
  flags: { embeddingMultilingual?: unknown; rerankerMultilingual?: unknown },
): DiagnosticRow {
  return {
    timestamp: ts,
    category: "model_health",
    severity: "info",
    message: "model_health",
    details: JSON.stringify({
      embeddingAvailable: true,
      rerankerModelPresent: true,
      rerankerBuilt: true,
      ...flags,
    }),
  };
}

/** A DEGRADED model_health row: severity "warning", embeddingAvailable=false
 *  (recordModelHealth sets severity "warning" exactly when the embedding
 *  provider is absent — the primary degraded-recall cause). */
function degradedModelHealthRow(ts: number): DiagnosticRow {
  return {
    timestamp: ts,
    category: "model_health",
    severity: "warning",
    message: "model_health",
    details: JSON.stringify({
      embeddingAvailable: false,
      rerankerModelPresent: false,
      rerankerBuilt: false,
      embeddingMultilingual: "unknown",
      rerankerMultilingual: "unknown",
    }),
  };
}

describe("buildFindings — multilingual advisory (standing state)", () => {
  it("emits ONE embedder advisory from the LATEST row when a newer model_health row reports embeddingMultilingual=false (older true is superseded)", () => {
    const older = modelHealthRow(1_000, { embeddingMultilingual: true, rerankerMultilingual: true });
    const newer = modelHealthRow(5_000, { embeddingMultilingual: false, rerankerMultilingual: true });
    // Insert newer FIRST so any insertion-order shortcut picks the wrong row.
    const findings = buildFindings([], [newer, older], []);

    const embedder = findings.filter((f) => f.code === EMBED_CODE);
    expect(embedder).toHaveLength(1);
    expect(embedder[0]?.count).toBe(1);
    // The latest row wins: reranker is multilingual, so NO reranker advisory.
    expect(findings.some((f) => f.code === RERANK_CODE)).toBe(false);
  });

  it("surfaces a reranker advisory when the latest row reports rerankerMultilingual \"unknown\" or false, and none when it is true", () => {
    const unknownReranker = buildFindings(
      [],
      [modelHealthRow(2_000, { embeddingMultilingual: true, rerankerMultilingual: "unknown" })],
      [],
    );
    expect(unknownReranker.filter((f) => f.code === RERANK_CODE)).toHaveLength(1);
    expect(unknownReranker.some((f) => f.code === EMBED_CODE)).toBe(false);

    const goodReranker = buildFindings(
      [],
      [modelHealthRow(2_000, { embeddingMultilingual: true, rerankerMultilingual: true })],
      [],
    );
    expect(goodReranker.some((f) => f.code === RERANK_CODE)).toBe(false);
  });

  it("surfaces an embedder advisory when the latest row reports embeddingMultilingual \"unknown\" (honest unknown, default install)", () => {
    const findings = buildFindings(
      [],
      [modelHealthRow(3_000, { embeddingMultilingual: "unknown", rerankerMultilingual: true })],
      [],
    );
    expect(findings.filter((f) => f.code === EMBED_CODE)).toHaveLength(1);
  });

  it("reports the advisory as STANDING STATE — five reboot rows with latest multilingual=false yield count 1, NOT 5", () => {
    // Five model_health rows from five reboots; the latest (max ts) is false.
    const rows: DiagnosticRow[] = [
      modelHealthRow(1_000, { embeddingMultilingual: false, rerankerMultilingual: false }),
      modelHealthRow(2_000, { embeddingMultilingual: false, rerankerMultilingual: false }),
      modelHealthRow(3_000, { embeddingMultilingual: false, rerankerMultilingual: false }),
      modelHealthRow(4_000, { embeddingMultilingual: false, rerankerMultilingual: false }),
      modelHealthRow(5_000, { embeddingMultilingual: false, rerankerMultilingual: false }),
    ];
    const findings = buildFindings([], rows, []);

    const embedder = findings.find((f) => f.code === EMBED_CODE);
    const reranker = findings.find((f) => f.code === RERANK_CODE);
    // A naive count-over-rows would assert 5 — standing state is 1.
    expect(embedder?.count).toBe(1);
    expect(reranker?.count).toBe(1);
  });

  it("does NOT fire either advisory when the latest row reports both multilingual=true (no false-fire)", () => {
    const findings = buildFindings(
      [],
      [modelHealthRow(9_000, { embeddingMultilingual: true, rerankerMultilingual: true })],
      [],
    );
    expect(findings.some((f) => f.code === EMBED_CODE)).toBe(false);
    expect(findings.some((f) => f.code === RERANK_CODE)).toBe(false);
  });

  it("folds malformed / missing details to no-advisory without throwing (defensive parse)", () => {
    const malformed: DiagnosticRow = {
      timestamp: 1_000,
      category: "model_health",
      severity: "info",
      message: "model_health",
      details: "not json {",
    };
    const missing: DiagnosticRow = {
      timestamp: 2_000,
      category: "model_health",
      severity: "info",
      message: "model_health",
      // details absent entirely
    };
    expect(() => buildFindings([], [malformed, missing], [])).not.toThrow();
    const findings = buildFindings([], [malformed, missing], []);
    // The latest row (missing details) yields no multilingual flags -> no advisory.
    expect(findings.some((f) => f.code === EMBED_CODE)).toBe(false);
    expect(findings.some((f) => f.code === RERANK_CODE)).toBe(false);
  });

  it("never echoes a raw model-id / path body — the advisory detail+hint carry no GGUF/URI substring (digest-only)", () => {
    // Even though details only ever holds booleans, pin that the FINDING text is
    // a fixed digest string, never a row body.
    const findings = buildFindings(
      [],
      [modelHealthRow(1_000, { embeddingMultilingual: false, rerankerMultilingual: "unknown" })],
      [],
    );
    for (const f of findings) {
      expect(f.detail).not.toContain("hf:");
      expect(f.detail).not.toContain(".gguf");
      expect(f.hint).not.toContain("hf:");
    }
  });

  it("emits no multilingual advisory at all when there are zero model_health rows", () => {
    const findings = buildFindings([], [], []);
    expect(findings.some((f) => f.code === EMBED_CODE || f.code === RERANK_CODE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The generic config_posture rollup NAMES the specific flagged keys
// (closed labels only) instead of "the flagged config keys", so an operator does
// not have to grep daemon.log to learn it was gateway.tls + CANARY_SECRET.
// ---------------------------------------------------------------------------

/** A config_posture row at `ts` carrying the given posture flags in its details JSON. */
function configPostureRow(ts: number, details: Record<string, unknown>): DiagnosticRow {
  return {
    timestamp: ts,
    category: "config_posture",
    severity: "warning",
    message: "config_posture",
    details: JSON.stringify(details),
  };
}

describe("buildFindings — config_posture rollup names the flagged keys", () => {
  it("names gateway.tls + CANARY_SECRET + stranded secrets in the rollup detail", () => {
    const findings = buildFindings(
      [],
      [],
      [
        configPostureRow(1_000, {
          tlsOff: true,
          canaryFallbackActive: true,
          strandedFindings: [{ stranded: "anthropic", entryCount: 2 }],
        }),
      ],
    );
    const cp = findings.find((f) => f.code === "config_posture");
    expect(cp).toBeDefined();
    expect(cp!.detail).toMatch(/gateway\.tls/);
    expect(cp!.detail).toMatch(/CANARY_SECRET/);
    expect(cp!.detail).toMatch(/stranded secrets \(1\)/);
    expect(cp!.hint).not.toBe("review the gateway TLS / token posture and the flagged config keys");
  });

  it("names security.agentToAgent.sandboxNoDowngrade when the no-downgrade invariant is disabled", () => {
    const findings = buildFindings(
      [],
      [],
      [configPostureRow(1_000, { sandboxNoDowngradeDisabled: true })],
    );
    const cp = findings.find((f) => f.code === "config_posture");
    expect(cp).toBeDefined();
    expect(cp!.detail).toMatch(/sandboxNoDowngrade/);
  });

  it("names browser.noSandbox when Chromium runs without its sandbox", () => {
    const findings = buildFindings(
      [],
      [],
      [configPostureRow(1_000, { browserNoSandbox: true })],
    );
    const cp = findings.find((f) => f.code === "config_posture");
    expect(cp).toBeDefined();
    expect(cp!.detail).toMatch(/noSandbox/);
  });

  it("names keys from the LATEST posture row only (standing state — a healthy newer boot supersedes)", () => {
    const findings = buildFindings(
      [],
      [],
      [
        configPostureRow(1_000, { tlsOff: true, canaryFallbackActive: true }),
        configPostureRow(2_000, { tlsOff: false, canaryFallbackActive: false }),
      ],
    );
    const cp = findings.find((f) => f.code === "config_posture");
    expect(cp).toBeDefined();
    expect(cp!.detail).not.toMatch(/gateway\.tls|CANARY_SECRET/);
  });

  it("never echoes a raw details body — only closed labels appear (no secret values / paths)", () => {
    const findings = buildFindings(
      [],
      [],
      [configPostureRow(1_000, { tlsOff: true, certPath: "/etc/ssl/private/key.pem", apiKey: "sk-leak" })],
    );
    const cp = findings.find((f) => f.code === "config_posture");
    expect(cp!.detail).not.toMatch(/key\.pem|sk-leak|certPath/);
  });
});

// ---------------------------------------------------------------------------
// The voice_health fleet finding.
//
// A degraded STT/TTS turn emits a `health_signal` diagnostic row labelled
// `voice_degraded` (emitted at the obs layer). buildFindings rolls those rows up
// into ONE
// counts+hints-only `voice_health` finding beside `model_health`/`config_posture`:
// the degraded count + the dominant voice errorKind (the domain SttErrorKind, a
// CLOSED label — never a raw provider body or a secret). The finding rides the
// existing `count desc, code asc` sort and is guarded on zero voice traffic
// (mirrors `if (modelHealth.length > 0)`).
// ---------------------------------------------------------------------------

const VOICE_CODE = "voice_health";

/** A `health_signal` row at `ts` labelled `voice_degraded`, carrying the closed
 *  domain `errorKind` (+ the `kind` family) in its details JSON. */
function voiceDegradedRow(ts: number, errorKind: string, kind: "stt" | "tts" = "stt"): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "health_signal",
    details: JSON.stringify({ signal: "voice_degraded", errorKind, kind }),
  };
}

describe("buildFindings — voice_health finding", () => {
  it("emits ONE voice_health finding with the degraded count + the dominant voice errorKind", () => {
    const findings = buildFindings(
      [
        voiceDegradedRow(1_000, "model_load_failed", "stt"),
        voiceDegradedRow(2_000, "model_load_failed", "stt"),
        voiceDegradedRow(3_000, "auth_required", "tts"),
      ],
      [],
      [],
    );
    const voice = findings.filter((f) => f.code === VOICE_CODE);
    expect(voice).toHaveLength(1);
    expect(voice[0]!.count).toBe(3);
    // The dominant errorKind (highest count) is named in the detail.
    expect(voice[0]!.detail).toMatch(/3 degraded STT\/TTS turn\(s\)/);
    expect(voice[0]!.detail).toMatch(/model_load_failed/);
    // The hint points at comis explain + the whisper model cache.
    expect(voice[0]!.hint).toMatch(/comis explain/);
    expect(voice[0]!.hint).toMatch(/model_load_failed|model_download_failed|whisper/);
  });

  it("does NOT emit a voice_health finding when there are zero voice_degraded rows (zero-traffic guard)", () => {
    // Other health signals present, but no voice_degraded.
    const findings = buildFindings(
      [
        {
          timestamp: 1_000,
          category: "health_signal",
          severity: "warning",
          message: "health_signal",
          details: JSON.stringify({ signal: "lcd_divergence" }),
        },
      ],
      [],
      [],
    );
    expect(findings.some((f) => f.code === VOICE_CODE)).toBe(false);
  });

  it("is SAFE TO PASTE — the detail+hint carry no raw provider body, no URL, no secret", () => {
    // Even though the row only ever holds a closed errorKind, pin that the FINDING
    // text is a fixed digest naming only the count + the closed label.
    const findings = buildFindings(
      [
        voiceDegradedRow(1_000, "auth_required", "stt"),
        voiceDegradedRow(2_000, "network", "tts"),
      ],
      [],
      [],
    );
    const voice = findings.find((f) => f.code === VOICE_CODE);
    expect(voice).toBeDefined();
    for (const text of [voice!.detail, voice!.hint]) {
      expect(text).not.toMatch(/https?:\/\//); // no URL
      expect(text).not.toMatch(/Bearer|sk-|ollama-no-auth/i); // no credential / sentinel
      expect(text).not.toMatch(/Error:|at .*\.ts:|\bstack\b/i); // no raw message / stack
    }
  });

  it("folds a malformed / missing voice_degraded details to no-throw and ignores it (defensive parse)", () => {
    const malformed: DiagnosticRow = {
      timestamp: 1_000,
      category: "health_signal",
      severity: "warning",
      message: "health_signal",
      details: "not json {",
    };
    const good = voiceDegradedRow(2_000, "timeout", "stt");
    expect(() => buildFindings([malformed, good], [], [])).not.toThrow();
    const findings = buildFindings([malformed, good], [], []);
    const voice = findings.find((f) => f.code === VOICE_CODE);
    // The malformed row never parses to voice_degraded → only the good row counts.
    expect(voice?.count).toBe(1);
    expect(voice!.detail).toMatch(/timeout/);
  });

  it("falls back to a generic detail when no errorKind is recorded on the voice_degraded rows", () => {
    const noKind: DiagnosticRow = {
      timestamp: 1_000,
      category: "health_signal",
      severity: "warning",
      message: "health_signal",
      details: JSON.stringify({ signal: "voice_degraded" }), // errorKind absent
    };
    const findings = buildFindings([noKind], [], []);
    const voice = findings.find((f) => f.code === VOICE_CODE);
    expect(voice?.count).toBe(1);
    // No dominant kind → the detail still renders, naming the count.
    expect(voice!.detail).toMatch(/1 degraded STT\/TTS turn\(s\)/);
  });

  it("rides the deterministic count-desc/code-asc sort beside other findings", () => {
    // 5 voice_degraded + 2 model_health: voice_health (count 5) must sort before
    // model_health (count 2). Insert in an order that a stable sort would NOT fix
    // by itself.
    const voiceRows: DiagnosticRow[] = [
      voiceDegradedRow(1_000, "model_load_failed"),
      voiceDegradedRow(2_000, "model_load_failed"),
      voiceDegradedRow(3_000, "model_load_failed"),
      voiceDegradedRow(4_000, "network"),
      voiceDegradedRow(5_000, "network"),
    ];
    // WARNING-severity (embeddingAvailable=false) rows — the only ones that count
    // as "provider degradation"; healthy info boots must not inflate the count.
    const modelRows: DiagnosticRow[] = [
      degradedModelHealthRow(1_000),
      degradedModelHealthRow(2_000),
    ];
    const findings = buildFindings(voiceRows, modelRows, []);
    const voiceIdx = findings.findIndex((f) => f.code === VOICE_CODE);
    const modelIdx = findings.findIndex((f) => f.code === "model_health");
    expect(voiceIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(voiceIdx).toBeLessThan(modelIdx); // count 5 before count 2
  });
});

// ---------------------------------------------------------------------------
// The dedicated pipeline_authoring finding + the pure
// pipelineAuthoringAggregateFromRows reducer.
//
// pipeline:authored persists a `health_signal` row with
// signal:"pipeline_authoring" + {tier, schemaValid}. buildFindings rolls the
// SMALL-TIER (small|nano) invalid rate into ONE dedicated finding (the
// small-model-authorable-DAGs gate metric). The pure reducer computes the
// aggregate the authoring gate
// consumes: {smallTierInvocations, smallTierValidRate, frontierValidRate}.
// ---------------------------------------------------------------------------

const PIPELINE_CODE = "pipeline_authoring";

/** A `health_signal` row at `ts` labelled `pipeline_authoring`. */
function pipelineAuthoringRow(
  ts: number,
  tier: string,
  schemaValid: boolean,
  action: "define" | "execute" = "define",
): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: schemaValid ? "info" : "warning",
    message: "pipeline:authored",
    details: JSON.stringify({ signal: "pipeline_authoring", action, tier, schemaValid, repaired: false }),
  };
}

describe("pipelineAuthoringAggregateFromRows", () => {
  it("groups small|nano as the small tier and computes the small + frontier valid rates", () => {
    const rows = [
      pipelineAuthoringRow(1, "small", true),
      pipelineAuthoringRow(2, "small", false),
      pipelineAuthoringRow(3, "nano", false), // nano folds into the small tier
      pipelineAuthoringRow(4, "frontier", true),
      pipelineAuthoringRow(5, "frontier", true),
      pipelineAuthoringRow(6, "frontier", false),
      pipelineAuthoringRow(7, "mid", false), // mid: counted in NEITHER cohort
      pipelineAuthoringRow(8, "unknown", true), // unknown: counted in NEITHER cohort
    ];
    const agg = pipelineAuthoringAggregateFromRows(rows);
    expect(agg.smallTierInvocations).toBe(3); // 2 small + 1 nano
    expect(agg.smallTierValidRate).toBeCloseTo(1 / 3, 10); // 1 of 3 small-tier valid
    expect(agg.frontierValidRate).toBeCloseTo(2 / 3, 10); // 2 of 3 frontier valid
  });

  it("returns {0,0,0} on empty rows (no-data → the gate defers)", () => {
    expect(pipelineAuthoringAggregateFromRows([])).toEqual({
      smallTierInvocations: 0,
      smallTierValidRate: 0,
      frontierValidRate: 0,
    });
  });

  it("rates are 0 when the cohort is empty (no small-tier rows, no frontier rows)", () => {
    const onlyFrontier = pipelineAuthoringAggregateFromRows([
      pipelineAuthoringRow(1, "frontier", true),
    ]);
    expect(onlyFrontier.smallTierInvocations).toBe(0);
    expect(onlyFrontier.smallTierValidRate).toBe(0); // empty small cohort → 0, not NaN
    expect(onlyFrontier.frontierValidRate).toBe(1);

    const onlySmall = pipelineAuthoringAggregateFromRows([pipelineAuthoringRow(1, "small", true)]);
    expect(onlySmall.frontierValidRate).toBe(0); // empty frontier cohort → 0, not NaN
  });

  it("folds a malformed / non-pipeline row out of both cohorts (defensive parse, never throws)", () => {
    const malformed: DiagnosticRow = {
      timestamp: 1,
      category: "health_signal",
      severity: "warning",
      message: "health_signal",
      details: "not json {",
    };
    const otherSignal: DiagnosticRow = {
      timestamp: 2,
      category: "health_signal",
      severity: "warning",
      message: "health_signal",
      details: JSON.stringify({ signal: "voice_degraded", errorKind: "timeout" }),
    };
    const good = pipelineAuthoringRow(3, "small", false);
    expect(() => pipelineAuthoringAggregateFromRows([malformed, otherSignal, good])).not.toThrow();
    const agg = pipelineAuthoringAggregateFromRows([malformed, otherSignal, good]);
    expect(agg.smallTierInvocations).toBe(1); // only the good small row counts
    expect(agg.smallTierValidRate).toBe(0);
  });
});

describe("buildFindings — pipeline_authoring finding", () => {
  it("emits ONE dedicated finding reporting the small-tier invalid count/total + rate percent", () => {
    const findings = buildFindings(
      [
        pipelineAuthoringRow(1, "small", false),
        pipelineAuthoringRow(2, "small", false),
        pipelineAuthoringRow(3, "nano", true),
        pipelineAuthoringRow(4, "frontier", true), // not a small-tier row
      ],
      [],
      [],
    );
    const finding = findings.filter((f) => f.code === PIPELINE_CODE);
    expect(finding).toHaveLength(1);
    // 2 invalid of 3 small-tier rows.
    expect(finding[0]!.count).toBe(2);
    expect(finding[0]!.detail).toMatch(/2\/3/);
    expect(finding[0]!.detail).toMatch(/66\.7%|67%|66/); // rate percent named
    // The hint names the small-model-authoring gate metric + the knob.
    expect(finding[0]!.hint).toMatch(/Phase-?174|orchestration\.authoring/i);
  });

  it("does NOT emit the finding when there are zero small-tier rows (zero small-tier guard)", () => {
    const findings = buildFindings(
      [
        pipelineAuthoringRow(1, "frontier", false),
        pipelineAuthoringRow(2, "mid", false),
        pipelineAuthoringRow(3, "unknown", true),
      ],
      [],
      [],
    );
    expect(findings.some((f) => f.code === PIPELINE_CODE)).toBe(false);
  });

  it("no double-report: pipeline_authoring does NOT also appear in the generic health_signal rollup", () => {
    const findings = buildFindings(
      [pipelineAuthoringRow(1, "small", false), pipelineAuthoringRow(2, "small", false)],
      [],
      [],
    );
    // At most one finding mentions pipeline_authoring — the dedicated one.
    const mentions = findings.filter(
      (f) => f.code === PIPELINE_CODE || f.code === "health_signal:pipeline_authoring",
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.code).toBe(PIPELINE_CODE);
    // The generic `health_signal:pipeline_authoring` rollup must NOT exist.
    expect(findings.some((f) => f.code === "health_signal:pipeline_authoring")).toBe(false);
  });

  it("folds a malformed pipeline_authoring details to no-throw and excludes it from the counts (defensive parse)", () => {
    const malformed: DiagnosticRow = {
      timestamp: 1,
      category: "health_signal",
      severity: "warning",
      message: "pipeline:authored",
      details: "not json {",
    };
    const good = pipelineAuthoringRow(2, "small", false);
    expect(() => buildFindings([malformed, good], [], [])).not.toThrow();
    const findings = buildFindings([malformed, good], [], []);
    const finding = findings.find((f) => f.code === PIPELINE_CODE);
    // The malformed row never parses → only the good small row counts.
    expect(finding?.count).toBe(1);
    expect(finding!.detail).toMatch(/1\/1/);
  });

  it("is SAFE TO PASTE — the detail+hint carry no graph/task/type_config body, no secret", () => {
    const findings = buildFindings(
      [pipelineAuthoringRow(1, "small", false), pipelineAuthoringRow(2, "nano", false)],
      [],
      [],
    );
    const finding = findings.find((f) => f.code === PIPELINE_CODE);
    expect(finding).toBeDefined();
    for (const text of [finding!.detail, finding!.hint]) {
      expect(text).not.toMatch(/type_config|typeConfig|"nodes"|"task"|"label"/);
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/Bearer|sk-/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Orchestration observability — three dedicated fleet findings for the
// previously-dark daemon-side orchestration health_signals. Each mirrors the
// voice_health pattern: a closed `signal` label, a zero-traffic if-guard, counts +
// closed labels ONLY (safe to paste), defensive parse.
// ---------------------------------------------------------------------------

/** A `health_signal` row labelled `sandbox_downgrade_refused`, carrying the closed
 *  violated-dimension labels. */
function sandboxRefusedRow(ts: number, dimensions: string[]): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "security:sandbox_downgrade_refused",
    details: JSON.stringify({ signal: "sandbox_downgrade_refused", dimensions }),
  };
}

describe("buildFindings — sandbox_downgrade_refused finding", () => {
  const CODE = "sandbox_downgrade_refused";

  it("emits ONE finding with the refusal count + the violated dimensions named", () => {
    const findings = buildFindings(
      [sandboxRefusedRow(1_000, ["exec"]), sandboxRefusedRow(2_000, ["exec", "network"])],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === CODE);
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(2);
    expect(f[0]!.detail).toMatch(/2 sub-agent spawn\(s\) refused/);
    // The dimensions an operator must reconcile are named (closed labels).
    expect(f[0]!.detail).toMatch(/exec/);
    // The hint points at the sandbox-posture knob.
    expect(f[0]!.hint).toMatch(/execSandbox|sandbox|posture/i);
  });

  it("does NOT emit when there are zero sandbox_downgrade_refused rows (zero-traffic guard)", () => {
    const findings = buildFindings(
      [{ timestamp: 1, category: "health_signal", severity: "warning", message: "health_signal", details: JSON.stringify({ signal: "lcd_divergence" }) }],
      [],
      [],
    );
    expect(findings.some((x) => x.code === CODE)).toBe(false);
  });

  it("is SAFE TO PASTE + folds malformed details to no-throw", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "warning", message: "x", details: "not json {" };
    expect(() => buildFindings([malformed, sandboxRefusedRow(2, ["uid"])], [], [])).not.toThrow();
    const f = buildFindings([sandboxRefusedRow(1, ["filesystem"])], [], []).find((x) => x.code === CODE)!;
    for (const text of [f.detail, f.hint]) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/Bearer|sk-/i);
      expect(text).not.toMatch(/\/home\/|\/tmp\/|uid=\d/); // no path/host/uid-number topology
    }
  });
});

/** A `health_signal` row labelled `delivery_deadlettered`. */
function deadletterRow(ts: number, channelType: string, transient: boolean): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "subagent:delivery_deadlettered",
    details: JSON.stringify({ signal: "delivery_deadlettered", channelType, transient }),
  };
}

describe("buildFindings — delivery_deadlettered finding", () => {
  const CODE = "delivery_deadlettered";

  it("emits ONE finding with the dropped count + the transient/permanent split", () => {
    const findings = buildFindings(
      [deadletterRow(1, "telegram", true), deadletterRow(2, "discord", true), deadletterRow(3, "slack", false)],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === CODE);
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(3);
    expect(f[0]!.detail).toMatch(/3 sub-agent completion\(s\) dead-lettered/);
    // 2 after-retries (transient) + 1 permanent (immediate) split is named.
    expect(f[0]!.detail).toMatch(/2 .*retr/i);
    expect(f[0]!.detail).toMatch(/1 permanent/i);
    expect(f[0]!.hint).toMatch(/comis explain|deliver/i);
  });

  it("does NOT emit on zero deadletter rows (zero-traffic guard)", () => {
    const findings = buildFindings(
      [{ timestamp: 1, category: "health_signal", severity: "warning", message: "h", details: JSON.stringify({ signal: "lcd_divergence" }) }],
      [],
      [],
    );
    expect(findings.some((x) => x.code === CODE)).toBe(false);
  });

  it("is SAFE TO PASTE — no runId, no announcement body, no error string", () => {
    const f = buildFindings([deadletterRow(1, "telegram", false)], [], []).find((x) => x.code === CODE)!;
    for (const text of [f.detail, f.hint]) {
      expect(text).not.toMatch(/run-|Error:|at .*\.ts:/);
      expect(text).not.toMatch(/https?:\/\//);
    }
  });
});

/** A `health_signal` row labelled `node_budget_exceeded`, carrying the closed capSource. */
function budgetRow(ts: number, capSource: string): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "subagent:budget_exceeded",
    details: JSON.stringify({ signal: "node_budget_exceeded", capSource }),
  };
}

// ---------------------------------------------------------------------------
// Three dedicated AUTONOMY findings over the persisted
// `health_signal` rows (signal labels durable_orphaned /
// autonomy_revoked / autonomy_killed). Each clones the node_budget_exceeded mold:
// a closed `signal` label, a zero-traffic if-guard, counts + a STATIC knob-naming
// hint ONLY (safe to paste), defensive parse. The kill-vs-revoke SEPARATION is
// the whole point — the daemon emits DISTINCT events (both flip durable status to
// 'revoked' in the table), so two separate findings are the only count separator.
// ---------------------------------------------------------------------------

/** A `health_signal` row labelled `durable_orphaned` (the persisted details shape:
 *  closed reason enum + rootRunId — never the engine free-text reason). */
function durableOrphanedRow(ts: number, reason: string, rootRunId = "root-orphan"): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "durable:orphaned",
    details: JSON.stringify({ signal: "durable_orphaned", reason, rootRunId }),
  };
}

/** A `health_signal` row labelled `autonomy_revoked` (revoked COUNT + rootRunId only). */
function autonomyRevokedRow(ts: number, revoked: number, rootRunId = "root-revoke"): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "autonomy:revoked",
    details: JSON.stringify({ signal: "autonomy_revoked", revoked, rootRunId }),
  };
}

/** A `health_signal` row labelled `autonomy_killed` (killed COUNT + rootRunId only). */
function autonomyKilledRow(ts: number, killed: number, rootRunId = "root-kill"): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "warning",
    message: "autonomy:killed",
    details: JSON.stringify({ signal: "autonomy_killed", killed, rootRunId }),
  };
}

describe("buildFindings — durable_orphaned finding", () => {
  const CODE = "durable_orphaned";

  it("emits ONE finding counting the orphaned rows, naming the top reason + comis explain + the heartbeat knob", () => {
    const findings = buildFindings(
      [
        durableOrphanedRow(1_000, "not_resumable", "r1"),
        durableOrphanedRow(2_000, "not_resumable", "r2"),
        durableOrphanedRow(3_000, "resume_failed", "r3"),
      ],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === CODE);
    expect(f).toHaveLength(1);
    // 3 orphaned rows → count 3.
    expect(f[0]!.count).toBe(3);
    expect(f[0]!.detail).toMatch(/3 run\(s\) orphaned on restart/);
    // The TOP closed reason (not_resumable, 2 of 3) is named — a closed enum, no free text.
    expect(f[0]!.detail).toMatch(/not_resumable/);
    // The hint names comis explain <rootRunId> + the heartbeat knob.
    expect(f[0]!.hint).toMatch(/comis explain <rootRunId>/);
    expect(f[0]!.hint).toMatch(/heartbeatStaleMs|heartbeat/);
  });

  it("does NOT emit when there are zero durable_orphaned rows (zero-traffic guard)", () => {
    const findings = buildFindings(
      [{ timestamp: 1, category: "health_signal", severity: "warning", message: "h", details: JSON.stringify({ signal: "lcd_divergence" }) }],
      [],
      [],
    );
    expect(findings.some((x) => x.code === CODE)).toBe(false);
  });

  it("CONTENT-FREE: the detail/hint carry no free-text reason / path / secret — only the closed enum + counts", () => {
    // The persisted row only ever holds a closed reason enum + an id, but pin that
    // the FINDING text is a fixed digest (no engine free-text reason ever leaks).
    const findings = buildFindings([durableOrphanedRow(1_000, "invalid_caps", "r9")], [], []);
    const f = findings.find((x) => x.code === CODE)!;
    for (const text of [f.detail, f.hint]) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/Bearer|sk-/i);
      expect(text).not.toMatch(/\/home\/|\/tmp\//); // no filesystem path
      // No free-text orphan-reason sentence (only the closed enum token).
      expect(text).not.toMatch(/lease holder|dropped its heartbeat at/i);
    }
  });

  it("folds malformed details to no-throw and ignores it (defensive parse)", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "warning", message: "x", details: "not json {" };
    expect(() => buildFindings([malformed, durableOrphanedRow(2_000, "reread_failed", "r2")], [], [])).not.toThrow();
    const f = buildFindings([malformed, durableOrphanedRow(2_000, "reread_failed", "r2")], [], []).find((x) => x.code === CODE)!;
    // The malformed row never parses to durable_orphaned → only the good row counts.
    expect(f.count).toBe(1);
  });
});

describe("buildFindings — autonomy_revoked + autonomy_killed findings (kill≠revoke separable)", () => {
  it("emits SEPARATE autonomy_revoked and autonomy_killed findings — kill is separable from revoke", () => {
    const findings = buildFindings(
      [
        autonomyRevokedRow(1_000, 2, "r-rev1"),
        autonomyRevokedRow(2_000, 1, "r-rev2"),
        autonomyKilledRow(3_000, 1, "r-kill1"),
      ],
      [],
      [],
    );
    const revoked = findings.filter((x) => x.code === "autonomy_revoked");
    const killed = findings.filter((x) => x.code === "autonomy_killed");
    // Two distinct findings — proving kill is separable from revoke.
    expect(revoked).toHaveLength(1);
    expect(killed).toHaveLength(1);
    // Counts SUM the per-row revoked/killed counts (2 + 1 = 3 revoked; 1 killed).
    expect(revoked[0]!.count).toBe(3);
    expect(killed[0]!.count).toBe(1);
    expect(revoked[0]!.detail).toMatch(/revoked/i);
    expect(killed[0]!.detail).toMatch(/kill/i);
    // Static hints — no body.
    expect(revoked[0]!.hint.length).toBeGreaterThan(0);
    expect(killed[0]!.hint.length).toBeGreaterThan(0);
  });

  it("emits a revoked finding but NO killed finding when only revoke rows are present (and vice-versa)", () => {
    const onlyRevoked = buildFindings([autonomyRevokedRow(1_000, 1, "r1")], [], []);
    expect(onlyRevoked.some((x) => x.code === "autonomy_revoked")).toBe(true);
    expect(onlyRevoked.some((x) => x.code === "autonomy_killed")).toBe(false);

    const onlyKilled = buildFindings([autonomyKilledRow(1_000, 1, "r1")], [], []);
    expect(onlyKilled.some((x) => x.code === "autonomy_killed")).toBe(true);
    expect(onlyKilled.some((x) => x.code === "autonomy_revoked")).toBe(false);
  });

  it("CONTENT-FREE: neither finding's detail/hint carries a lease bearer / selector / body", () => {
    const findings = buildFindings(
      [autonomyRevokedRow(1_000, 1, "r-rev"), autonomyKilledRow(2_000, 1, "r-kill")],
      [],
      [],
    );
    for (const code of ["autonomy_revoked", "autonomy_killed"]) {
      const f = findings.find((x) => x.code === code)!;
      for (const text of [f.detail, f.hint]) {
        expect(text).not.toMatch(/https?:\/\//);
        expect(text).not.toMatch(/Bearer|sk-|secret-lease/i);
      }
    }
  });

  it("folds malformed revoke/kill details to no-throw (defensive parse)", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "warning", message: "x", details: "not json {" };
    expect(() => buildFindings([malformed, autonomyRevokedRow(2_000, 1), autonomyKilledRow(3_000, 1)], [], [])).not.toThrow();
  });

  it("no double-report: revoked/killed do NOT also appear in the generic health_signal rollup", () => {
    const findings = buildFindings(
      [autonomyRevokedRow(1_000, 1, "r1"), autonomyKilledRow(2_000, 1, "r2"), durableOrphanedRow(3_000, "not_resumable", "r3")],
      [],
      [],
    );
    // None of the three labels leak into the generic `health_signal:<label>` rollup.
    expect(findings.some((f) => f.code === "health_signal:autonomy_revoked")).toBe(false);
    expect(findings.some((f) => f.code === "health_signal:autonomy_killed")).toBe(false);
    expect(findings.some((f) => f.code === "health_signal:durable_orphaned")).toBe(false);
  });
});

describe("buildFindings — node_budget_exceeded finding", () => {
  const CODE = "node_budget_exceeded";

  it("emits ONE finding with the breach count + the dominant cap source named", () => {
    const findings = buildFindings(
      [budgetRow(1, "node"), budgetRow(2, "node"), budgetRow(3, "inherit-share")],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === CODE);
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(3);
    expect(f[0]!.detail).toMatch(/3 node\(s\) exceeded their token budget/);
    // The dominant capSource (node, 2 of 3) is named so the operator knows WHICH knob.
    expect(f[0]!.detail).toMatch(/node/);
    expect(f[0]!.hint).toMatch(/tokenBudget|budget\.maxTokens|agentToAgent\.tokenBudget/);
  });

  it("does NOT emit on zero budget rows (zero-traffic guard)", () => {
    const findings = buildFindings([{ timestamp: 1, category: "health_signal", severity: "warning", message: "h", details: JSON.stringify({ signal: "lcd_divergence" }) }], [], []);
    expect(findings.some((x) => x.code === CODE)).toBe(false);
  });

  it("is SAFE TO PASTE + folds malformed details (defensive parse)", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "warning", message: "x", details: "not json {" };
    expect(() => buildFindings([malformed, budgetRow(2, "operator-default")], [], [])).not.toThrow();
    const f = buildFindings([budgetRow(1, "operator-default")], [], []).find((x) => x.code === CODE)!;
    for (const text of [f.detail, f.hint]) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/Bearer|sk-/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The generic `model_health` "provider degradation" rollup must NOT count the
// once-per-boot HEALTHY
// snapshot (severity "info", embeddingAvailable=true). recordModelHealth writes
// ONE row per boot with severity "info" when the embedding provider is present
// and "warning" only when it is absent (the primary degraded-recall cause). A
// keyless daemon with a working local embedder that rebooted 8× would otherwise
// show "8 model-health signal(s) (provider degradation)" — 8 benign healthy
// boots mislabeled as degradation (the BENIGN_*_REASONS anti-pattern: routine
// events inflating warning counts). Only severity "warning" rows are real
// degradation; the multilingual advisory (read from the latest row) is
// severity-independent and must keep firing.
// ---------------------------------------------------------------------------
describe("buildFindings — health_signal rollup counts only degraded (warning) rows", () => {
  it("does NOT surface a severity-info session_rebase row as an lcd_divergence finding (benign continuation, not degradation)", () => {
    // The ingest layer deliberately stamps benign context:dag_degraded reasons
    // (session_rebase / serialized_wait) severity "info" so they do not inflate
    // the fleet lens — but the findings rollup ignored severity and folded
    // them anyway. Observed live: a fresh session's once-per-start rebase
    // (reason session_rebase, 5ms) surfaced as an actionable-looking
    // "health_signal:lcd_divergence" finding whose hint ("inspect the
    // recurring health WARNs") dead-ended — no such WARNs exist.
    const findings = buildFindings(
      [
        {
          timestamp: 1_000,
          category: "health_signal",
          severity: "info",
          message: "context:dag_degraded",
          details: JSON.stringify({ signal: "lcd_divergence", reason: "session_rebase", durationMs: 5 }),
        },
      ],
      [],
      [],
    );
    expect(findings.some((f) => f.code === "health_signal:lcd_divergence")).toBe(false);
  });

  it("still surfaces a severity-warning lcd_divergence row (a genuine live/store shrink)", () => {
    const findings = buildFindings(
      [
        {
          timestamp: 1_000,
          category: "health_signal",
          severity: "warning",
          message: "context:dag_degraded",
          details: JSON.stringify({ signal: "lcd_divergence", reason: "live_store_divergence", durationMs: 5 }),
        },
      ],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === "health_signal:lcd_divergence");
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(1);
  });

  it("breaks the lcd_divergence finding down by reason so the operator sees WHICH failure class recurred", () => {
    // Grouping by signal label alone forced a per-session explain to learn
    // whether the divergences were fail_closed_rollover (a security refusal) or
    // live_store_divergence (a heal/compaction shrink). details.reason is right
    // there in the rows — surface a per-reason breakdown in the detail.
    const row = (reason: string, ts: number): DiagnosticRow => ({
      timestamp: ts,
      category: "health_signal",
      severity: "warning",
      message: "context:dag_degraded",
      details: JSON.stringify({ signal: "lcd_divergence", reason, durationMs: 5 }),
    });
    const findings = buildFindings(
      [
        row("fail_closed_rollover", 1_000),
        row("fail_closed_rollover", 2_000),
        row("live_store_divergence", 3_000),
      ],
      [],
      [],
    );
    const f = findings.find((x) => x.code === "health_signal:lcd_divergence");
    expect(f).toBeDefined();
    expect(f!.count).toBe(3);
    // Deterministic order (count desc, then reason asc) with per-reason counts.
    expect(f!.detail).toContain("fail_closed_rollover=2");
    expect(f!.detail).toContain("live_store_divergence=1");
  });
});

describe("buildFindings — model_health 'provider degradation' counts only degraded (warning) rows", () => {
  const MH_CODE = "model_health";

  it("emits NO provider-degradation finding when every model_health row is a healthy info-severity boot (8-reboot keyless case)", () => {
    const rows: DiagnosticRow[] = Array.from({ length: 8 }, (_v, i) =>
      modelHealthRow(1_000 * (i + 1), { embeddingMultilingual: true, rerankerMultilingual: true }),
    );
    const findings = buildFindings([], rows, []);
    expect(findings.some((f) => f.code === MH_CODE)).toBe(false);
  });

  it("counts ONLY warning-severity (embeddingAvailable=false) rows as provider degradation", () => {
    const rows: DiagnosticRow[] = [
      modelHealthRow(1_000, { embeddingMultilingual: true, rerankerMultilingual: true }), // info
      degradedModelHealthRow(2_000), // warning
      modelHealthRow(3_000, { embeddingMultilingual: true, rerankerMultilingual: true }), // info
    ];
    const mh = buildFindings([], rows, []).find((f) => f.code === MH_CODE);
    expect(mh).toBeDefined();
    expect(mh?.count).toBe(1);
  });

  it("keeps the multilingual advisory firing on a healthy info row while NOT emitting a degradation finding", () => {
    // Latest row: healthy (info) but English-leaning embedder.
    const rows: DiagnosticRow[] = [
      modelHealthRow(5_000, { embeddingMultilingual: false, rerankerMultilingual: true }),
    ];
    const findings = buildFindings([], rows, []);
    expect(findings.some((f) => f.code === EMBED_CODE)).toBe(true); // advisory: severity-independent
    expect(findings.some((f) => f.code === MH_CODE)).toBe(false); // but no "provider degradation" for a healthy boot
  });
});

// ---------------------------------------------------------------------------
// The config_posture:pricing_gap fleet finding.
//
// The kill-switch is only honest if an operator can SEE its pricing-coverage gap:
// how many configured agents burn tokens on remote-unknown-priced models (a NATIVE
// provider with no catalog entry — the fail-open where spend is silently
// under-counted as $0). The count is produced at boot from `resolvePricingState`
// (== "unknown") into the config_posture row's `details` JSON; buildFindings reads
// it defensively (the chimericModelFromRow mold) and emits ONE counts+hint-only
// finding beside `config_posture:chimeric_model`. STANDING STATE (latest row only),
// content-free (counts + remediation, never a model id / config value as a body).
// ---------------------------------------------------------------------------

const PRICING_GAP_CODE = "config_posture:pricing_gap";

describe("pricingGapFromRow — defensive pricingGapCount extractor (chimericModelFromRow clone)", () => {
  it("reads a valid positive pricingGapCount from the row's details JSON", () => {
    expect(pricingGapFromRow(configPostureRow(1_000, { pricingGapCount: 3 }))).toBe(3);
  });

  it("folds a missing details field to 0", () => {
    const row: DiagnosticRow = { timestamp: 1, category: "config_posture", severity: "info", message: "config_posture" };
    expect(pricingGapFromRow(row)).toBe(0);
  });

  it("folds malformed details JSON to 0 (caught, never throws)", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "config_posture", severity: "warning", message: "x", details: "not json {" };
    expect(pricingGapFromRow(malformed)).toBe(0);
  });

  it("folds a non-positive / non-finite / non-number count to 0", () => {
    expect(pricingGapFromRow(configPostureRow(1_000, { pricingGapCount: 0 }))).toBe(0);
    expect(pricingGapFromRow(configPostureRow(1_000, { pricingGapCount: -2 }))).toBe(0);
    expect(pricingGapFromRow(configPostureRow(1_000, { pricingGapCount: Number.NaN }))).toBe(0);
    expect(pricingGapFromRow(configPostureRow(1_000, { pricingGapCount: "5" }))).toBe(0);
    expect(pricingGapFromRow(configPostureRow(1_000, {}))).toBe(0);
  });
});

describe("buildFindings — config_posture:pricing_gap finding (standing state, content-free)", () => {
  it("emits the pricing_gap finding with the count from the latest posture row when pricingGapCount > 0", () => {
    const findings = buildFindings([], [], [configPostureRow(1_000, { pricingGapCount: 3 })]);
    const finding = findings.find((f) => f.code === PRICING_GAP_CODE);
    expect(finding).toBeDefined();
    expect(finding?.count).toBe(3);
    expect(finding?.detail).toMatch(/remote-unknown-priced|under-counted|burning tokens/i);
    expect(finding?.hint).toMatch(/priced provider|local\/free|comis explain/i);
  });

  it("does NOT emit the pricing_gap finding when pricingGapCount is 0", () => {
    const findings = buildFindings([], [], [configPostureRow(1_000, { pricingGapCount: 0 })]);
    expect(findings.some((f) => f.code === PRICING_GAP_CODE)).toBe(false);
  });

  it("does NOT emit the pricing_gap finding when there is no config_posture row", () => {
    const findings = buildFindings([], [], []);
    expect(findings.some((f) => f.code === PRICING_GAP_CODE)).toBe(false);
  });

  it("reads the LATEST row only (standing state — a newer 0 suppresses an older 5)", () => {
    const findings = buildFindings(
      [],
      [],
      [
        configPostureRow(1_000, { pricingGapCount: 5 }),
        configPostureRow(2_000, { pricingGapCount: 0 }),
      ],
    );
    expect(findings.some((f) => f.code === PRICING_GAP_CODE)).toBe(false);
  });

  it("is content-free — the detail/hint never echo a raw model id or config value (only counts + remediation)", () => {
    const findings = buildFindings(
      [],
      [],
      [configPostureRow(1_000, { pricingGapCount: 2, modelId: "claude-opus-4", apiKey: "sk-leak" })],
    );
    const finding = findings.find((f) => f.code === PRICING_GAP_CODE);
    expect(finding).toBeDefined();
    expect(`${finding?.detail} ${finding?.hint}`).not.toMatch(/claude-opus-4|sk-leak/);
  });

  it("rides the existing count-desc / code-asc sort (no new sort logic)", () => {
    const findings = buildFindings(
      [],
      [],
      [configPostureRow(1_000, { pricingGapCount: 9, chimericModelCount: 1 })],
    );
    const idxGap = findings.findIndex((f) => f.code === PRICING_GAP_CODE);
    const idxChimera = findings.findIndex((f) => f.code === "config_posture:chimeric_model");
    expect(idxGap).toBeGreaterThanOrEqual(0);
    expect(idxChimera).toBeGreaterThanOrEqual(0);
    // count 9 (pricing_gap) sorts before count 1 (chimeric_model) under count-desc.
    expect(idxGap).toBeLessThan(idxChimera);
  });
});

// ---------------------------------------------------------------------------
// The learning_health finding — the
// reflection funnel rolled up over the window (daemon-wide "is learning admitting").
// ---------------------------------------------------------------------------

describe("buildFindings — learning_health (reflection funnel rollup)", () => {
  function learningHealthRow(
    ts: number,
    fields: { admissionOutcome: string; admitted?: number; untrustedDrops?: number },
  ): DiagnosticRow {
    return {
      timestamp: ts,
      category: "learning_health",
      severity: "info",
      agentId: "default",
      message: "reflect:funnel",
      details: JSON.stringify({
        signal: "reflect_funnel",
        admissionOutcome: fields.admissionOutcome,
        admitted: fields.admitted ?? 0,
        untrustedDrops: fields.untrustedDrops ?? 0,
        sourceTrajectoryCount: 0,
        totalSourceChars: 0,
      }),
    };
  }

  it("emits a learning_health finding: run count + LATEST outcome + summed admitted/untrustedDrops", () => {
    const older = learningHealthRow(1_000, { admissionOutcome: "uncorroborated", admitted: 0 });
    const newer = learningHealthRow(5_000, { admissionOutcome: "admitted", admitted: 1 });
    // newer FIRST → a latest-row scan (max timestamp), not insertion order.
    const findings = buildFindings([], [], [], [newer, older]);
    const lh = findings.filter((f) => f.code === "learning_health");
    expect(lh).toHaveLength(1);
    expect(lh[0]!.count).toBe(2); // 2 reflection runs in the window
    expect(lh[0]!.detail).toContain("latest outcome=admitted"); // the ts-5000 row wins
    expect(lh[0]!.detail).toContain("admitted=1");
  });

  it("surfaces untrusted_origin magnitude (summed) + folds an off-vocabulary outcome to unknown (digest-only)", () => {
    const rows: DiagnosticRow[] = [
      learningHealthRow(2_000, { admissionOutcome: "untrusted_origin", untrustedDrops: 2 }),
      {
        timestamp: 3_000, category: "learning_health", severity: "info", message: "reflect:funnel",
        details: JSON.stringify({ admissionOutcome: "BOGUS_NOT_IN_ENUM", admitted: 0, untrustedDrops: 0 }),
      },
    ];
    const lh = buildFindings([], [], [], rows).filter((f) => f.code === "learning_health");
    expect(lh).toHaveLength(1);
    expect(lh[0]!.detail).toContain("untrustedDrops=2");
    expect(lh[0]!.detail).toContain("latest outcome=unknown"); // off-vocabulary → unknown, never echoed
  });

  it("no learning_health finding when there are no reflection rows (callers omitting the argument are unchanged)", () => {
    expect(buildFindings([], [], []).some((f) => f.code === "learning_health")).toBe(false);
  });

  it("never echoes a doc body even if one is smuggled into details (content-free)", () => {
    const row: DiagnosticRow = {
      timestamp: 1, category: "learning_health", severity: "info", message: "reflect:funnel",
      details: JSON.stringify({ admissionOutcome: "admitted", admitted: 1, body: "## the reflected procedure\nrm -rf /" }),
    };
    const lh = buildFindings([], [], [], [row]).filter((f) => f.code === "learning_health");
    expect(JSON.stringify(lh)).not.toContain("rm -rf");
    expect(JSON.stringify(lh)).not.toContain("procedure");
  });
});

describe("buildFindings — memory_lifecycle (forget sweep rollup)", () => {
  function lifecycleRow(ts: number, fields: { evicted?: number; demoted?: number }): DiagnosticRow {
    return {
      timestamp: ts,
      category: "memory_lifecycle",
      severity: "info",
      agentId: "default",
      message: "learning:lifecycle_swept",
      details: JSON.stringify({
        signal: "lifecycle_sweep",
        scanned: 6,
        promoted: 0,
        demoted: fields.demoted ?? 0,
        evicted: fields.evicted ?? 0,
      }),
    };
  }

  it("emits a memory_lifecycle finding: sweep count + summed evicted/demoted", () => {
    const findings = buildFindings([], [], [], [], [lifecycleRow(1_000, { evicted: 1, demoted: 0 }), lifecycleRow(2_000, { evicted: 2, demoted: 1 })]);
    const ml = findings.filter((f) => f.code === "memory_lifecycle");
    expect(ml).toHaveLength(1);
    expect(ml[0]!.count).toBe(2); // 2 sweeps in the window
    expect(ml[0]!.detail).toContain("evicted=3"); // 1 + 2
    expect(ml[0]!.detail).toContain("demoted=1");
  });

  it("no memory_lifecycle finding when there are no sweep rows (callers omitting the argument are unchanged)", () => {
    expect(buildFindings([], [], [], []).some((f) => f.code === "memory_lifecycle")).toBe(false);
  });

  it("never echoes a memory body even if smuggled into details (content-free)", () => {
    const row: DiagnosticRow = {
      timestamp: 1, category: "memory_lifecycle", severity: "info", message: "learning:lifecycle_swept",
      details: JSON.stringify({ evicted: 1, body: "the secret memory content", id: "memory-deadbeef" }),
    };
    const ml = buildFindings([], [], [], [], [row]).filter((f) => f.code === "memory_lifecycle");
    expect(JSON.stringify(ml)).not.toContain("secret memory content");
    expect(JSON.stringify(ml)).not.toContain("deadbeef");
  });
});

// ---------------------------------------------------------------------------
// The dedicated orchestrate_efficiency fleet finding + its defensive extractor.
//
// A completed orchestrate run emits a `health_signal` row labelled
// `orchestrate_efficiency` carrying counts + token ESTIMATES (the measured
// counterfactual savings from materializing large tool results as ResultRefs
// instead of re-entering them into context) + the closed failureClass only.
// buildFindings folds those rows into ONE counts+estimates-only finding: the run
// count + the summed est. tokens saved (+ a degraded-run count). Content-free
// (INV-5), deduped via DEDICATED_SCRIPT_SIGNALS (never ALSO in the generic
// health_signal:<label> rollup), and zero-traffic-guarded.
// ---------------------------------------------------------------------------

const ORCH_CODE = "orchestrate_efficiency";

/** A `health_signal` row labelled `orchestrate_efficiency` (the content-free
 *  run-summary details shape: counts + estimates + the closed failureClass only). */
function orchestrateEfficiencyRow(
  ts: number,
  estSavedTokens: number,
  opts: { failureClass?: string; savedRatio?: number; resultRefCount?: number } = {},
): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity: "info",
    sessionKey: "t:u:c",
    message: "orchestrate:run_summary",
    details: JSON.stringify({
      signal: "orchestrate_efficiency",
      ...(opts.failureClass !== undefined ? { failureClass: opts.failureClass } : {}),
      estSavedTokens,
      savedRatio: opts.savedRatio ?? 0.9,
      resultRefCount: opts.resultRefCount ?? 1,
    }),
  };
}

describe("orchestrateEfficiencyFromRow — defensive extractor (pipelineAuthoringFromRow clone)", () => {
  it("reads estSavedTokens + the closed failureClass from an orchestrate_efficiency row", () => {
    const row = orchestrateEfficiencyRow(1_000, 30208, { failureClass: "nonzero_exit" });
    expect(orchestrateEfficiencyFromRow(row)).toEqual({ estSavedTokens: 30208, failureClass: "nonzero_exit" });
  });

  it("coerces a missing / non-finite / non-positive estSavedTokens to 0 (a run that materialized nothing still counts)", () => {
    const noSave: DiagnosticRow = {
      timestamp: 1, category: "health_signal", severity: "info", message: "orchestrate:run_summary",
      details: JSON.stringify({ signal: "orchestrate_efficiency", resultRefCount: 0 }),
    };
    expect(orchestrateEfficiencyFromRow(noSave)).toEqual({ estSavedTokens: 0, failureClass: undefined });
    expect(orchestrateEfficiencyFromRow(orchestrateEfficiencyRow(2, Number.NaN))).toEqual({ estSavedTokens: 0, failureClass: undefined });
    expect(orchestrateEfficiencyFromRow(orchestrateEfficiencyRow(3, -5))).toEqual({ estSavedTokens: 0, failureClass: undefined });
  });

  it("returns null for a wrong-signal row (never counts another signal's numbers)", () => {
    const row: DiagnosticRow = {
      timestamp: 1, category: "health_signal", severity: "warning", message: "h",
      details: JSON.stringify({ signal: "lcd_divergence", estSavedTokens: 99999 }),
    };
    expect(orchestrateEfficiencyFromRow(row)).toBeNull();
  });

  it("returns null for malformed details JSON and for absent details (caught, never throws)", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "info", message: "x", details: "not json {" };
    const absent: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "info", message: "x" };
    expect(orchestrateEfficiencyFromRow(malformed)).toBeNull();
    expect(orchestrateEfficiencyFromRow(absent)).toBeNull();
  });
});

describe("buildFindings — orchestrate_efficiency finding", () => {
  it("emits ONE finding with the run count + the summed est. tokens saved", () => {
    const findings = buildFindings(
      [orchestrateEfficiencyRow(1_000, 30208), orchestrateEfficiencyRow(2_000, 15000)],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === ORCH_CODE);
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(2); // 2 runs
    expect(f[0]!.detail).toMatch(/2 orchestrate run\(s\)/);
    expect(f[0]!.detail).toMatch(/45208/); // 30208 + 15000 total est. tokens saved
    expect(f[0]!.hint.length).toBeGreaterThan(0);
  });

  it("names the degraded-run count when a run carried a failureClass (closed enum, content-free)", () => {
    const findings = buildFindings(
      [
        orchestrateEfficiencyRow(1_000, 10000),
        orchestrateEfficiencyRow(2_000, 0, { failureClass: "nonzero_exit" }),
      ],
      [],
      [],
    );
    const f = findings.find((x) => x.code === ORCH_CODE)!;
    expect(f.count).toBe(2);
    expect(f.detail).toMatch(/1 degraded/);
  });

  it("EXCLUDES hard-killed runs (timeout / stdout_cap) from the summed savings but still counts them as (degraded) runs", () => {
    // A hard kill SIGKILLs the child mid-materialization: runAggregate reports the
    // bytes materialized BEFORE the kill, but the run never sliced/consumed them —
    // those "savings" were never actually kept out of any context. They must NOT
    // inflate the headline measured savings; the run still counts (degraded).
    const findings = buildFindings(
      [
        orchestrateEfficiencyRow(1_000, 5000), // clean run — real savings
        orchestrateEfficiencyRow(2_000, 10_000_000, { failureClass: "timeout" }), // hard-killed → phantom
        orchestrateEfficiencyRow(3_000, 8_000_000, { failureClass: "stdout_cap" }), // hard-killed → phantom
      ],
      [],
      [],
    );
    const f = findings.find((x) => x.code === ORCH_CODE)!;
    // All three runs count toward the run total...
    expect(f.count).toBe(3);
    // ...two of them degraded (the hard kills)...
    expect(f.detail).toMatch(/2 degraded/);
    // ...but ONLY the clean run's 5000 tokens enter the summed savings — the 18M
    // phantom tokens from the two hard-killed runs are excluded.
    expect(f.detail).toMatch(/~5000 est\. tokens saved/);
    expect(f.detail).not.toMatch(/10000000|8000000|18005000/);
  });

  it("KEEPS a completed-but-degraded run's savings (nonzero_exit / lease_absent ran to completion — real savings)", () => {
    // nonzero_exit and lease_absent runs ran to COMPLETION, so their materialized
    // bytes really were kept out of context — their savings are real and summed
    // (only the interrupted timeout/stdout_cap classes are phantom). spawn_fail
    // materializes nothing (empty results/), so it does not inflate either.
    const findings = buildFindings(
      [
        orchestrateEfficiencyRow(1_000, 6000, { failureClass: "nonzero_exit" }),
        orchestrateEfficiencyRow(2_000, 4000, { failureClass: "lease_absent" }),
      ],
      [],
      [],
    );
    const f = findings.find((x) => x.code === ORCH_CODE)!;
    expect(f.count).toBe(2);
    expect(f.detail).toMatch(/2 degraded/);
    expect(f.detail).toMatch(/~10000 est\. tokens saved/); // 6000 + 4000, both real
  });

  it("does NOT emit when there are zero orchestrate_efficiency rows (zero-traffic guard)", () => {
    const findings = buildFindings(
      [{ timestamp: 1, category: "health_signal", severity: "warning", message: "h", details: JSON.stringify({ signal: "lcd_divergence" }) }],
      [],
      [],
    );
    expect(findings.some((x) => x.code === ORCH_CODE)).toBe(false);
  });

  it("no double-report: orchestrate_efficiency does NOT also appear in the generic health_signal rollup (DEDICATED_SCRIPT_SIGNALS dedup)", () => {
    const findings = buildFindings(
      [orchestrateEfficiencyRow(1_000, 100), orchestrateEfficiencyRow(2_000, 200)],
      [],
      [],
    );
    // Exactly one finding mentions orchestrate_efficiency — the dedicated one.
    const mentions = findings.filter(
      (x) => x.code === ORCH_CODE || x.code === "health_signal:orchestrate_efficiency",
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.code).toBe(ORCH_CODE);
    expect(findings.some((x) => x.code === "health_signal:orchestrate_efficiency")).toBe(false);
  });

  it("folds a malformed / wrong-signal row out (defensive parse, never throws; foreign numbers never enter the sum)", () => {
    const malformed: DiagnosticRow = { timestamp: 1, category: "health_signal", severity: "info", message: "x", details: "not json {" };
    const wrongSignal: DiagnosticRow = {
      timestamp: 2, category: "health_signal", severity: "warning", message: "h",
      details: JSON.stringify({ signal: "lcd_divergence", estSavedTokens: 99999 }),
    };
    const good = orchestrateEfficiencyRow(3_000, 5000);
    expect(() => buildFindings([malformed, wrongSignal, good], [], [])).not.toThrow();
    const f = buildFindings([malformed, wrongSignal, good], [], []).find((x) => x.code === ORCH_CODE)!;
    expect(f.count).toBe(1); // only the good row counts
    expect(f.detail).toMatch(/5000/);
    expect(f.detail).not.toMatch(/99999/); // the wrong-signal's number never entered the sum
  });

  it("is SAFE TO PASTE — the detail+hint carry no runId, stdout body, URL, or secret (counts + estimates only)", () => {
    const findings = buildFindings(
      [orchestrateEfficiencyRow(1_000, 12345, { failureClass: "timeout" })],
      [],
      [],
    );
    const f = findings.find((x) => x.code === ORCH_CODE)!;
    for (const text of [f.detail, f.hint]) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/Bearer|sk-/i);
      expect(text).not.toMatch(/orch-|run-|Error:|at .*\.ts:/);
    }
  });

  it("rides the deterministic count-desc / code-asc sort beside other findings", () => {
    // 3 orchestrate runs (count 3) vs 1 degraded model_health (count 1): the
    // orchestrate finding sorts before model_health under count-desc.
    const findings = buildFindings(
      [orchestrateEfficiencyRow(1_000, 100), orchestrateEfficiencyRow(2_000, 200), orchestrateEfficiencyRow(3_000, 300)],
      [degradedModelHealthRow(1_000)],
      [],
    );
    const orchIdx = findings.findIndex((x) => x.code === ORCH_CODE);
    const modelIdx = findings.findIndex((x) => x.code === "model_health");
    expect(orchIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(orchIdx).toBeLessThan(modelIdx); // count 3 before count 1
  });
});

// ---------------------------------------------------------------------------
// channel_ingress_auth_rejected surfaces via the GENERIC health_signal rollup
// (no dedicated extractor / DEDICATED_SCRIPT_SIGNALS entry) — a rejected-ingress
// auth flood becomes a counted `comis fleet` finding, symmetric with the
// channel_ingress_silent path.
// ---------------------------------------------------------------------------
describe("buildFindings — channel_ingress_auth_rejected generic rollup", () => {
  function authRejectedRow(ts: number, reason: string): DiagnosticRow {
    return {
      timestamp: ts,
      category: "health_signal",
      severity: "warning",
      message: "channel:ingress_auth_rejected",
      details: JSON.stringify({
        signal: "channel_ingress_auth_rejected",
        channelType: "msteams",
        reason,
      }),
    };
  }

  it("rolls a rejected-ingress flood up into ONE counted generic finding", () => {
    const findings = buildFindings(
      [
        authRejectedRow(1_000, "invalid_token"),
        authRejectedRow(2_000, "invalid_token"),
        authRejectedRow(3_000, "missing_bearer"),
      ],
      [],
      [],
    );

    const f = findings.filter((x) => x.code === "health_signal:channel_ingress_auth_rejected");
    expect(f).toHaveLength(1);
    // Both reason classes fold into the one signal label — the flood is COUNTED.
    expect(f[0]!.count).toBe(3);
  });

  it("carries no token/header body in the generic finding text (content-free)", () => {
    const findings = buildFindings([authRejectedRow(1_000, "invalid_token")], [], []);
    const f = findings.find((x) => x.code === "health_signal:channel_ingress_auth_rejected");
    expect(f).toBeDefined();
    expect(JSON.stringify(f)).not.toContain("Bearer");
    expect(JSON.stringify(f)).not.toContain("authorization");
  });
});

describe("buildFindings — cron_wake_gate_efficiency (wake-gate rollup)", () => {
  function gateRow(fields: { agentId: string; wake: boolean; toolCalls?: number; estTurnsSaved?: number }): DiagnosticRow {
    return {
      timestamp: 1_000,
      category: "cron_wake_gate",
      severity: "info",
      agentId: fields.agentId,
      message: "scheduler:wake_gate",
      details: JSON.stringify({
        signal: "cron_wake_gate",
        wake: fields.wake,
        durationMs: 5,
        toolCalls: fields.toolCalls ?? 0,
        estTurnsSaved: fields.estTurnsSaved ?? (fields.wake ? 0 : 1),
      }),
    };
  }

  it("emits a cron_wake_gate_efficiency finding: fire count + summed skipped/turnsSaved/toolCalls", () => {
    const rows: DiagnosticRow[] = [
      gateRow({ agentId: "a", wake: false, estTurnsSaved: 1 }),
      gateRow({ agentId: "a", wake: false, estTurnsSaved: 1 }),
      gateRow({ agentId: "a", wake: true, toolCalls: 2, estTurnsSaved: 0 }),
    ];
    const findings = buildFindings([], [], [], [], [], rows);
    const f = findings.filter((x) => x.code === "cron_wake_gate_efficiency");
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(3); // 3 gated fires in the window
    expect(f[0]!.detail).toContain("skipped=2");
    expect(f[0]!.detail).toContain("turnsSaved=2");
    expect(f[0]!.detail).toContain("toolCalls=2");
  });

  it("carries a BENIGN hint (a high skip-rate is the gate WORKING, not a fault) pointing at cron.runs", () => {
    const findings = buildFindings([], [], [], [], [], [gateRow({ agentId: "a", wake: false })]);
    const f = findings.find((x) => x.code === "cron_wake_gate_efficiency");
    expect(f).toBeDefined();
    // The hint names cron.runs for the per-fire decisions + says a skip is savings,
    // and calls out the two signals to inspect (100% skip / toolCalls > turnsSaved).
    expect(f!.hint).toContain("cron.runs");
    expect(f!.hint.toLowerCase()).toMatch(/working|savings/);
  });

  it("no cron_wake_gate_efficiency finding when there are no gate rows (callers omitting the argument are unchanged)", () => {
    expect(buildFindings([], [], [], [], []).some((f) => f.code === "cron_wake_gate_efficiency")).toBe(false);
  });

  it("never echoes a gate script/payload even if smuggled into details (content-free)", () => {
    const row: DiagnosticRow = {
      timestamp: 1, category: "cron_wake_gate", severity: "info", agentId: "a", message: "scheduler:wake_gate",
      details: JSON.stringify({ signal: "cron_wake_gate", wake: false, estTurnsSaved: 1, toolCalls: 0, script: "gather the inbox rm -rf /" }),
    };
    const f = buildFindings([], [], [], [], [], [row]).filter((x) => x.code === "cron_wake_gate_efficiency");
    expect(JSON.stringify(f)).not.toContain("rm -rf");
    expect(JSON.stringify(f)).not.toContain("gather the inbox");
  });
});

// ---------------------------------------------------------------------------
// subagent_stuck_killed — the daemon health monitor force-killed sub-agent
// run(s). Dedicated finding (the sandbox_downgrade_refused discipline) whose
// hint names the exact knob; parent/operator kills are severity-info rows and
// never surface. The label is in DEDICATED_SCRIPT_SIGNALS, so it must NOT
// double-count as a generic `health_signal:subagent_killed` finding.
// ---------------------------------------------------------------------------

/** A `health_signal` row labelled `subagent_killed`, carrying the closed killedBy. */
function subagentKilledRow(ts: number, killedBy: string, severity: "warning" | "info" = "warning"): DiagnosticRow {
  return {
    timestamp: ts,
    category: "health_signal",
    severity,
    agentId: "default",
    sessionKey: `default:sub-agent-${ts}:sub-agent:${ts}`,
    message: "subagent:killed",
    details: JSON.stringify({ signal: "subagent_killed", killedBy }),
  };
}

describe("buildFindings — subagent_stuck_killed finding", () => {
  const CODE = "subagent_stuck_killed";

  it("emits ONE counted finding for health-monitor kills, hint naming the stuck threshold knob", () => {
    const findings = buildFindings(
      [subagentKilledRow(1_000, "health_monitor"), subagentKilledRow(2_000, "health_monitor")],
      [],
      [],
    );
    const f = findings.filter((x) => x.code === CODE);
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(2);
    expect(f[0]!.detail).toMatch(/2 sub-agent run\(s\) force-killed by the daemon health monitor/);
    expect(f[0]!.hint).toMatch(/stuckKillThresholdMs/);
    expect(f[0]!.hint).toMatch(/comis explain/);
  });

  it("does NOT double-count via the generic health_signal rollup", () => {
    const findings = buildFindings([subagentKilledRow(1_000, "health_monitor")], [], []);
    expect(findings.some((x) => x.code === "health_signal:subagent_killed")).toBe(false);
  });

  it("info-severity (parent/deliberate) kill rows never surface", () => {
    const findings = buildFindings([subagentKilledRow(1_000, "parent", "info")], [], []);
    expect(findings.some((x) => x.code === CODE)).toBe(false);
    expect(findings.some((x) => x.code === "health_signal:subagent_killed")).toBe(false);
  });
});

describe("buildFindings — config_posture:media_credential_gap", () => {
  const postureRow = (mediaCredentialGapCount: number): DiagnosticRow => ({
    timestamp: 1000,
    category: "config_posture",
    severity: "warning",
    message: "config_posture",
    details: JSON.stringify({ tlsOff: false, canaryFallbackActive: false, mediaCredentialGapCount }),
  });

  it("emits a media_credential_gap finding naming the count + remediation", () => {
    const findings = buildFindings([], [], [postureRow(2)], [], []);
    const f = findings.find((x) => x.code === "config_posture:media_credential_gap");
    expect(f).toBeDefined();
    expect(f!.count).toBe(2);
    expect(f!.detail).toMatch(/2 configured media pipeline/);
    expect(f!.hint).toMatch(/OPENAI_API_KEY|openai-codex|integrations\.media/);
  });

  it("does NOT emit when the media gap count is zero", () => {
    const findings = buildFindings([], [], [postureRow(0)], [], []);
    expect(findings.some((x) => x.code === "config_posture:media_credential_gap")).toBe(false);
  });
});
