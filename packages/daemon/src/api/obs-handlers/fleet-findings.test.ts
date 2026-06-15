// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DiagnosticRow } from "@comis/memory";
import { buildFindings } from "./fleet-findings.js";

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
