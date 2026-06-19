// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DiagnosticRow } from "@comis/memory";
import { buildFindings, pipelineAuthoringAggregateFromRows } from "./fleet-findings.js";

// ---------------------------------------------------------------------------
// EMB-01 — the dedicated multilingual fleet advisory (standing state).
//
// buildFindings is a PURE rows -> findings transform. The EMB-01 advisory reads
// the LATEST (max-timestamp) `model_health` row's details JSON and emits ONE
// finding per non-multilingual lane (embedder / reranker). It is STANDING STATE,
// not a count over rows (Pitfall 4 — a daemon that rebooted N times must NOT show
// "N non-multilingual signals", mirrors the KNOB-03 latest-row pattern). The
// parse is defensive (malformed/missing folds to no-advisory, never throws, never
// echoes a body). ADVISORY ONLY (I4) — buildFindings touches no recall/search path.
//
// RED: the advisory branch does not exist yet, so none of these findings are
// emitted (only the generic count-based `model_health` rollup exists).
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

describe("buildFindings — EMB-01 multilingual advisory (standing state)", () => {
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

  it("reports the advisory as STANDING STATE — five reboot rows with latest multilingual=false yield count 1, NOT 5 (Pitfall 4 RED)", () => {
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

  it("never echoes a raw model-id / path body — the advisory detail+hint carry no GGUF/URI substring (I8 digest-only)", () => {
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
// T1.3 (F6) — the generic config_posture rollup NAMES the specific flagged keys
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

describe("buildFindings — T1.3 config_posture names the flagged keys (F6)", () => {
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
// OBS-04 (Phase 196) — the voice_health fleet finding.
//
// A degraded STT/TTS turn emits a `health_signal` diagnostic row labelled
// `voice_degraded` (the route-(b) emit, scoped to the obs layer — see the plan's
// FLAG-7 spike decision). buildFindings rolls those rows up into ONE
// counts+hints-only `voice_health` finding beside `model_health`/`config_posture`:
// the degraded count + the dominant voice errorKind (the domain SttErrorKind, a
// CLOSED label — never a raw provider body or a secret). The finding rides the
// existing `count desc, code asc` sort and is guarded on zero voice traffic
// (mirrors `if (modelHealth.length > 0)`).
//
// RED: the `voice_degraded` arm + the `voice_health` finding do not exist yet, so
// NO `voice_health` finding is produced — every assertion below fails on the
// pre-patch code.
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

describe("buildFindings — OBS-04 voice_health finding", () => {
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

  it("is SAFE TO PASTE — the detail+hint carry no raw provider body, no URL, no secret (SEC-01 H1)", () => {
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
    const modelRows: DiagnosticRow[] = [
      modelHealthRow(1_000, { embeddingMultilingual: true, rerankerMultilingual: true }),
      modelHealthRow(2_000, { embeddingMultilingual: true, rerankerMultilingual: true }),
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
// TELEM-01 (Plan 173-03) — the dedicated pipeline_authoring finding + the pure
// pipelineAuthoringAggregateFromRows reducer.
//
// The GENQ-01 clone: pipeline:authored persists a `health_signal` row with
// signal:"pipeline_authoring" + {tier, schemaValid}. buildFindings rolls the
// SMALL-TIER (small|nano — D-TIER) invalid rate into ONE dedicated finding (the
// Phase-174 gate metric). The pure reducer computes the aggregate Plan 04's gate
// consumes: {smallTierInvocations, smallTierValidRate, frontierValidRate}.
//
// RED: neither the reducer nor the finding exists yet on the pre-patch code —
// `pipelineAuthoringAggregateFromRows` is undefined and NO pipeline_authoring
// finding is produced, so every assertion below fails.
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

describe("buildFindings — TELEM-01 pipeline_authoring finding", () => {
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
    // The hint names the Phase-174 gate metric.
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
// ORCH-OBS (orchestration-observability) — three dedicated fleet findings for the
// previously-dark daemon-side orchestration health_signals. Each mirrors the
// voice_health pattern: a closed `signal` label, a zero-traffic if-guard, counts +
// closed labels ONLY (safe to paste), defensive parse. RED: none of the three arms
// exist yet, so NO finding is produced — every assertion fails on the pre-patch code.
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

describe("buildFindings — ORCH-OBS sandbox_downgrade_refused finding", () => {
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

describe("buildFindings — ORCH-OBS delivery_deadlettered finding", () => {
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

describe("buildFindings — ORCH-OBS node_budget_exceeded finding", () => {
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
