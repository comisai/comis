import { describe, expect, it } from "vitest";

import {
  CASSETTE_COVERAGE_KINDS,
  DETERMINISTIC_INPUT_KINDS,
  MAX_PRODUCTION_CAPTURE_EPISODE_BYTES,
  PRODUCTION_CAPTURE_EPISODE_BEGIN,
  PRODUCTION_CAPTURE_EPISODE_END,
  evaluateProductionEpisodeRun,
  formatProductionCaptureEpisode,
  parseProductionCaptureEpisode,
  validateProductionCaptureEpisode,
  type ProductionCaptureEpisode,
} from "./production-episode.js";
import { TRANSCRIPT_EXACT_SOURCE_KINDS } from "./production-transcript.js";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function makeEpisode(): ProductionCaptureEpisode {
  return {
    schema: "comis-production-capture-episode",
    schemaVersion: 1,
    episodeId: "episode-20260715-a",
    captureMode: "prospective_window",
    window: {
      startAtMs: 1_752_560_000_000,
      endAtMs: 1_752_560_060_000,
      startBoundaryDigestSha256: digest(1),
      endBoundaryDigestSha256: digest(2),
      boundaryLedgerDigestSha256: digest(3),
      captureControllerIdentityDigestSha256: digest(15),
    },
    initialCheckpoint: {
      status: "captured",
      phase: "pre_window",
      capturedAtMs: 1_752_559_999_000,
      quiescence: "verified",
      quiescenceAttestationDigestSha256: digest(4),
      snapshotManifestDigestSha256: digest(5),
      stateTreeDigestSha256: digest(6),
      entryCount: 2_100,
      bytes: 301_000_000,
    },
    sourceAuthorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind, index) => ({
      kind,
      sourceIdDigestSha256: digest(100 + index),
      status: "covered" as const,
      startWatermark: {
        sequence: 10,
        ledgerDigestSha256: digest(500 + index),
      },
      endWatermark: {
        sequence: 11,
        ledgerDigestSha256: digest(600 + index),
      },
      authoritativeCount: 1,
      transcriptCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: digest(700 + index),
      gapReason: null,
    })),
    deterministicInputs: DETERMINISTIC_INPUT_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: {
        sequence: 20,
        ledgerDigestSha256: digest(800 + index),
      },
      endWatermark: {
        sequence: 22,
        ledgerDigestSha256: digest(810 + index),
      },
      authoritativeCount: 2,
      capturedCount: 2,
      contiguous: true,
      coverageAttestationDigestSha256: digest(820 + index),
      gapReason: null,
    })),
    cassetteAuthorities: CASSETTE_COVERAGE_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: {
        sequence: 30,
        ledgerDigestSha256: digest(900 + index),
      },
      endWatermark: {
        sequence: 31,
        ledgerDigestSha256: digest(910 + index),
      },
      authoritativeCount: 1,
      cassetteCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: digest(920 + index),
      gapReason: null,
    })),
    finalObservation: {
      status: "captured",
      phase: "post_window",
      observedAtMs: 1_752_560_061_000,
      observerMode: "independent",
      observerIdentityDigestSha256: digest(7),
      observationAttestationDigestSha256: digest(8),
      outputIndexDigestSha256: digest(9),
      outputCount: 12,
      finalStateDigestSha256: digest(10),
      finalStateRecordCount: 2_100,
      oracleObservationDigestSha256: digest(11),
    },
    replayInput: {
      target: "deterministic_cassette",
      classification: "deterministic_cassette_exact",
      exactEligible: true,
      inputSetDigestSha256: digest(12),
      gaps: [],
    },
    correctness: {
      oracleSetDigestSha256: digest(13),
      oracleCount: 4,
      production: {
        observationDigestSha256: digest(11),
        verdict: "fail",
      },
      desired: {
        observationDigestSha256: digest(14),
        verdict: "pass",
      },
    },
  };
}

function mutableEpisode(): Mutable<ProductionCaptureEpisode> {
  return structuredClone(makeEpisode()) as Mutable<ProductionCaptureEpisode>;
}

describe("prospective production capture episode contract", () => {
  it("keeps exact input replay separate from a failing production correctness oracle", () => {
    const episode = makeEpisode();

    const validated = validateProductionCaptureEpisode(episode);
    const red = evaluateProductionEpisodeRun(episode, {
      phase: "reproduction",
      inputFidelity: "matched",
      observationDigestSha256: episode.correctness.production.observationDigestSha256,
      verdict: "fail",
    });
    const green = evaluateProductionEpisodeRun(episode, {
      phase: "verification",
      inputFidelity: "matched",
      observationDigestSha256: episode.correctness.desired.observationDigestSha256,
      verdict: "pass",
    });

    expect(validated.ok).toBe(true);
    expect(red).toEqual({
      ok: true,
      value: {
        phase: "reproduction",
        inputFidelity: "matched",
        correctness: "red_reproduced",
        productionObservationMatched: true,
        desiredObservationMatched: false,
      },
    });
    expect(green).toEqual({
      ok: true,
      value: {
        phase: "verification",
        inputFidelity: "matched",
        correctness: "green_verified",
        productionObservationMatched: false,
        desiredObservationMatched: true,
      },
    });
  });

  it("rejects exact replay without a quiesced pre-window checkpoint", () => {
    const missing = mutableEpisode();
    missing.initialCheckpoint = {
      status: "missing",
      phase: "pre_window",
      capturedAtMs: null,
      quiescence: "unverified",
      quiescenceAttestationDigestSha256: null,
      snapshotManifestDigestSha256: null,
      stateTreeDigestSha256: null,
      entryCount: null,
      bytes: null,
    };

    expect(validateProductionCaptureEpisode(missing)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });
  });

  it("rejects exact replay when an authority watermark is missing or has a sequence gap", () => {
    const missingWatermark = mutableEpisode();
    missingWatermark.sourceAuthorities[0]!.startWatermark = null;
    expect(validateProductionCaptureEpisode(missingWatermark)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });

    const sequenceGap = mutableEpisode();
    sequenceGap.sourceAuthorities[0]!.endWatermark!.sequence = 13;
    expect(validateProductionCaptureEpisode(sequenceGap)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });
  });

  it("rejects self-asserted zero-count exactness without durable coverage attestations", () => {
    const source = mutableEpisode();
    const sourceAuthority = source.sourceAuthorities[0]!;
    sourceAuthority.endWatermark!.sequence = sourceAuthority.startWatermark!.sequence;
    sourceAuthority.authoritativeCount = 0;
    sourceAuthority.transcriptCount = 0;
    sourceAuthority.coverageAttestationDigestSha256 = null;
    expect(validateProductionCaptureEpisode(source)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });

    const cassette = mutableEpisode();
    const cassetteAuthority = cassette.cassetteAuthorities[0]!;
    cassetteAuthority.endWatermark!.sequence = cassetteAuthority.startWatermark!.sequence;
    cassetteAuthority.authoritativeCount = 0;
    cassetteAuthority.cassetteCount = 0;
    cassetteAuthority.coverageAttestationDigestSha256 = null;
    expect(validateProductionCaptureEpisode(cassette)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });
  });

  it("makes historical final-state-only capture explicitly ineligible for exact replay", () => {
    const historical = mutableEpisode();
    historical.captureMode = "historical_final_state_only";
    historical.initialCheckpoint = {
      status: "missing",
      phase: "pre_window",
      capturedAtMs: null,
      quiescence: "unverified",
      quiescenceAttestationDigestSha256: null,
      snapshotManifestDigestSha256: null,
      stateTreeDigestSha256: null,
      entryCount: null,
      bytes: null,
    };
    historical.replayInput = {
      target: "deterministic_cassette",
      classification: "historical_best_effort",
      exactEligible: false,
      inputSetDigestSha256: digest(12),
      gaps: [
        {
          kind: "historical_final_state_only",
          sourceKind: null,
          deterministicInputKind: null,
          cassetteKind: null,
        },
        {
          kind: "initial_checkpoint_missing",
          sourceKind: null,
          deterministicInputKind: null,
          cassetteKind: null,
        },
      ],
    };

    const result = validateProductionCaptureEpisode(historical);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replayInput.exactEligible).toBe(false);
  });

  it("requires an independently captured post-window observation for exact replay", () => {
    const sameObserver = mutableEpisode();
    sameObserver.finalObservation.observerMode = "capture_controller";

    expect(validateProductionCaptureEpisode(sameObserver)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });

    const forgedIndependent = mutableEpisode();
    forgedIndependent.finalObservation.observerIdentityDigestSha256 =
      forgedIndependent.window.captureControllerIdentityDigestSha256;
    expect(validateProductionCaptureEpisode(forgedIndependent)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "replayInput" },
    });
  });

  it("rejects unbounded windows, unknown fields, and oversized envelopes without echoing content", () => {
    const unbounded = mutableEpisode();
    unbounded.window.endAtMs = unbounded.window.startAtMs;
    expect(validateProductionCaptureEpisode(unbounded)).toMatchObject({
      ok: false,
      error: { kind: "invalid_episode", field: "window" },
    });

    const unsafe = structuredClone(makeEpisode()) as unknown as Record<string, unknown>;
    unsafe.promptBody = "PRIVATE_USER_PROMPT";
    const strict = validateProductionCaptureEpisode(unsafe);
    expect(strict.ok).toBe(false);
    expect(JSON.stringify(strict)).not.toContain("PRIVATE_USER_PROMPT");

    const oversized = `${PRODUCTION_CAPTURE_EPISODE_BEGIN}\n${"x".repeat(MAX_PRODUCTION_CAPTURE_EPISODE_BYTES)}\n${PRODUCTION_CAPTURE_EPISODE_END}\n`;
    expect(parseProductionCaptureEpisode(oversized)).toMatchObject({
      ok: false,
      error: { kind: "invalid_envelope", field: "envelope" },
    });
  });

  it("round-trips the bounded content-free episode envelope", () => {
    const formatted = formatProductionCaptureEpisode(makeEpisode());

    expect(formatted.ok).toBe(true);
    if (!formatted.ok) return;
    const parsed = parseProductionCaptureEpisode(formatted.value);
    expect(parsed.ok).toBe(true);
    expect(formatted.value.split("\n")).toEqual([
      PRODUCTION_CAPTURE_EPISODE_BEGIN,
      expect.any(String),
      PRODUCTION_CAPTURE_EPISODE_END,
      "",
    ]);
    expect(formatted.value).not.toContain("promptBody");
    expect(formatted.value).not.toContain("secretValue");
  });
});
