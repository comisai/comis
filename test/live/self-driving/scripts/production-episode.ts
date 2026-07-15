// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  type ReplayCassetteKind,
} from "./production-bundle.js";
import {
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  TRANSCRIPT_SOURCE_KINDS,
  type TranscriptSourceKind,
} from "./production-transcript.js";

export const PRODUCTION_CAPTURE_EPISODE_BEGIN =
  "COMIS_PRODUCTION_CAPTURE_EPISODE_V1_BEGIN";
export const PRODUCTION_CAPTURE_EPISODE_END =
  "COMIS_PRODUCTION_CAPTURE_EPISODE_V1_END";
export const MAX_PRODUCTION_CAPTURE_EPISODE_BYTES = 4 * 1024 * 1024;
export const MAX_PRODUCTION_EPISODE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const CASSETTE_COVERAGE_KINDS = CASSETTE_KINDS;
export const DETERMINISTIC_INPUT_KINDS = DETERMINISTIC_SEQUENCE_KINDS;

export const PRODUCTION_EPISODE_REPLAY_GAP_KINDS = [
  "historical_final_state_only",
  "initial_checkpoint_missing",
  "initial_checkpoint_not_quiesced",
  "initial_checkpoint_not_pre_window",
  "source_authority_missing",
  "source_coverage_gap",
  "source_watermark_missing",
  "source_sequence_gap",
  "source_count_mismatch",
  "source_coverage_unattested",
  "deterministic_input_missing",
  "deterministic_input_gap",
  "deterministic_input_watermark_missing",
  "deterministic_input_sequence_gap",
  "deterministic_input_count_mismatch",
  "deterministic_input_unattested",
  "cassette_authority_missing",
  "cassette_coverage_gap",
  "cassette_watermark_missing",
  "cassette_sequence_gap",
  "cassette_count_mismatch",
  "cassette_coverage_unattested",
  "final_observation_missing",
  "final_observation_not_post_window",
  "final_observation_not_independent",
  "final_observation_unattested",
  "external_input_unrecorded",
  "capture_consistency_gap",
] as const;

export type DeterministicInputKind = (typeof DETERMINISTIC_INPUT_KINDS)[number];
export type ProductionCaptureMode = "prospective_window" | "historical_final_state_only";
export type ProductionEpisodeCoverageStatus = "covered" | "gap";
export type ProductionEpisodeCoverageGapReason =
  | "missing_artifact"
  | "unreadable_artifact"
  | "partial_retention"
  | "sequence_gap"
  | "count_mismatch"
  | "non_durable"
  | "capture_error"
  | "unsupported_source"
  | "external_call_not_recorded";
export type ProductionEpisodeReplayGapKind =
  (typeof PRODUCTION_EPISODE_REPLAY_GAP_KINDS)[number];
export type ProductionEpisodeReplayClassification =
  | "historical_best_effort"
  | "prospective_bounded"
  | "deterministic_cassette_exact"
  | "live_provider_semantic";

export interface ProductionEpisodeWindow {
  readonly startAtMs: number;
  readonly endAtMs: number;
  readonly startBoundaryDigestSha256: string;
  readonly endBoundaryDigestSha256: string;
  readonly boundaryLedgerDigestSha256: string;
  readonly captureControllerIdentityDigestSha256: string;
}

export interface ProductionEpisodeInitialCheckpoint {
  readonly status: "captured" | "missing";
  readonly phase: "pre_window";
  readonly capturedAtMs: number | null;
  readonly quiescence: "verified" | "unverified";
  readonly quiescenceAttestationDigestSha256: string | null;
  readonly snapshotManifestDigestSha256: string | null;
  readonly stateTreeDigestSha256: string | null;
  readonly entryCount: number | null;
  readonly bytes: number | null;
}

export interface ProductionEpisodeWatermark {
  readonly sequence: number;
  readonly ledgerDigestSha256: string;
}

export interface ProductionEpisodeSourceAuthority {
  readonly kind: TranscriptSourceKind;
  readonly sourceIdDigestSha256: string;
  readonly status: ProductionEpisodeCoverageStatus;
  readonly startWatermark: ProductionEpisodeWatermark | null;
  readonly endWatermark: ProductionEpisodeWatermark | null;
  readonly authoritativeCount: number | null;
  readonly transcriptCount: number;
  readonly contiguous: boolean;
  readonly coverageAttestationDigestSha256: string | null;
  readonly gapReason: ProductionEpisodeCoverageGapReason | null;
}

export interface ProductionEpisodeDeterministicInputAuthority {
  readonly kind: DeterministicInputKind;
  readonly status: ProductionEpisodeCoverageStatus;
  readonly startWatermark: ProductionEpisodeWatermark | null;
  readonly endWatermark: ProductionEpisodeWatermark | null;
  readonly authoritativeCount: number | null;
  readonly capturedCount: number;
  readonly contiguous: boolean;
  readonly coverageAttestationDigestSha256: string | null;
  readonly gapReason: ProductionEpisodeCoverageGapReason | null;
}

export interface ProductionEpisodeCassetteAuthority {
  readonly kind: ReplayCassetteKind;
  readonly status: ProductionEpisodeCoverageStatus;
  readonly startWatermark: ProductionEpisodeWatermark | null;
  readonly endWatermark: ProductionEpisodeWatermark | null;
  readonly authoritativeCount: number | null;
  readonly cassetteCount: number;
  readonly contiguous: boolean;
  readonly coverageAttestationDigestSha256: string | null;
  readonly gapReason: ProductionEpisodeCoverageGapReason | null;
}

export interface ProductionEpisodeFinalObservation {
  readonly status: "captured" | "missing";
  readonly phase: "post_window";
  readonly observedAtMs: number | null;
  readonly observerMode: "independent" | "capture_controller" | "unavailable";
  readonly observerIdentityDigestSha256: string | null;
  readonly observationAttestationDigestSha256: string | null;
  readonly outputIndexDigestSha256: string | null;
  readonly outputCount: number | null;
  readonly finalStateDigestSha256: string | null;
  readonly finalStateRecordCount: number | null;
  readonly oracleObservationDigestSha256: string | null;
}

export interface ProductionEpisodeReplayGap {
  readonly kind: ProductionEpisodeReplayGapKind;
  readonly sourceKind: TranscriptSourceKind | null;
  readonly deterministicInputKind: DeterministicInputKind | null;
  readonly cassetteKind: ReplayCassetteKind | null;
}

export interface ProductionEpisodeReplayInput {
  readonly target: "deterministic_cassette" | "live_provider";
  readonly classification: ProductionEpisodeReplayClassification;
  readonly exactEligible: boolean;
  readonly inputSetDigestSha256: string;
  readonly gaps: readonly ProductionEpisodeReplayGap[];
}

export interface ProductionEpisodeCorrectnessObservation {
  readonly observationDigestSha256: string;
  readonly verdict: "pass" | "fail";
}

export interface ProductionEpisodeCorrectness {
  readonly oracleSetDigestSha256: string;
  readonly oracleCount: number;
  readonly production: ProductionEpisodeCorrectnessObservation;
  readonly desired: ProductionEpisodeCorrectnessObservation;
}

export interface ProductionCaptureEpisode {
  readonly schema: "comis-production-capture-episode";
  readonly schemaVersion: 1;
  readonly episodeId: string;
  readonly captureMode: ProductionCaptureMode;
  readonly window: ProductionEpisodeWindow;
  readonly initialCheckpoint: ProductionEpisodeInitialCheckpoint;
  readonly sourceAuthorities: readonly ProductionEpisodeSourceAuthority[];
  readonly deterministicInputs: readonly ProductionEpisodeDeterministicInputAuthority[];
  readonly cassetteAuthorities: readonly ProductionEpisodeCassetteAuthority[];
  readonly finalObservation: ProductionEpisodeFinalObservation;
  readonly replayInput: ProductionEpisodeReplayInput;
  readonly correctness: ProductionEpisodeCorrectness;
}

export interface ProductionEpisodeRunInput {
  readonly phase: "reproduction" | "verification";
  readonly inputFidelity: "matched" | "diverged";
  readonly observationDigestSha256: string;
  readonly verdict: "pass" | "fail";
}

export interface ProductionEpisodeRunEvaluation {
  readonly phase: "reproduction" | "verification";
  readonly inputFidelity: "matched" | "diverged";
  readonly correctness:
    | "red_reproduced"
    | "production_pass_reproduced"
    | "green_verified"
    | "desired_failure_verified"
    | "production_bug_persists"
    | "oracle_mismatch"
    | "not_evaluated";
  readonly productionObservationMatched: boolean;
  readonly desiredObservationMatched: boolean;
}

export type ProductionCaptureEpisodeError =
  | {
      readonly kind: "invalid_envelope";
      readonly field: "envelope";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_episode";
      readonly field:
        | "episode"
        | "window"
        | "initialCheckpoint"
        | "sourceAuthorities"
        | "deterministicInputs"
        | "cassetteAuthorities"
        | "finalObservation"
        | "replayInput"
        | "correctness";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_run";
      readonly field: "run";
      readonly message: string;
    };

const MAX_AUTHORITIES = 10_000;
const MAX_COUNT = 1_000_000_000;
const MAX_SNAPSHOT_BYTES = 1_125_899_906_842_624;
const MAX_GAPS = 10_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_KIND_VALUES = new Set<string>(TRANSCRIPT_SOURCE_KINDS);
const DETERMINISTIC_KIND_VALUES = new Set<string>(DETERMINISTIC_INPUT_KINDS);
const CASSETTE_KIND_VALUES = new Set<string>(CASSETTE_COVERAGE_KINDS);
const GAP_KIND_VALUES = new Set<string>(PRODUCTION_EPISODE_REPLAY_GAP_KINDS);
const COVERAGE_GAP_VALUES = new Set<string>([
  "missing_artifact",
  "unreadable_artifact",
  "partial_retention",
  "sequence_gap",
  "count_mismatch",
  "non_durable",
  "capture_error",
  "unsupported_source",
  "external_call_not_recorded",
]);

const EPISODE_KEYS = [
  "schema",
  "schemaVersion",
  "episodeId",
  "captureMode",
  "window",
  "initialCheckpoint",
  "sourceAuthorities",
  "deterministicInputs",
  "cassetteAuthorities",
  "finalObservation",
  "replayInput",
  "correctness",
] as const;
const WINDOW_KEYS = [
  "startAtMs",
  "endAtMs",
  "startBoundaryDigestSha256",
  "endBoundaryDigestSha256",
  "boundaryLedgerDigestSha256",
  "captureControllerIdentityDigestSha256",
] as const;
const CHECKPOINT_KEYS = [
  "status",
  "phase",
  "capturedAtMs",
  "quiescence",
  "quiescenceAttestationDigestSha256",
  "snapshotManifestDigestSha256",
  "stateTreeDigestSha256",
  "entryCount",
  "bytes",
] as const;
const WATERMARK_KEYS = ["sequence", "ledgerDigestSha256"] as const;
const SOURCE_AUTHORITY_KEYS = [
  "kind",
  "sourceIdDigestSha256",
  "status",
  "startWatermark",
  "endWatermark",
  "authoritativeCount",
  "transcriptCount",
  "contiguous",
  "coverageAttestationDigestSha256",
  "gapReason",
] as const;
const DETERMINISTIC_AUTHORITY_KEYS = [
  "kind",
  "status",
  "startWatermark",
  "endWatermark",
  "authoritativeCount",
  "capturedCount",
  "contiguous",
  "coverageAttestationDigestSha256",
  "gapReason",
] as const;
const CASSETTE_AUTHORITY_KEYS = [
  "kind",
  "status",
  "startWatermark",
  "endWatermark",
  "authoritativeCount",
  "cassetteCount",
  "contiguous",
  "coverageAttestationDigestSha256",
  "gapReason",
] as const;
const FINAL_OBSERVATION_KEYS = [
  "status",
  "phase",
  "observedAtMs",
  "observerMode",
  "observerIdentityDigestSha256",
  "observationAttestationDigestSha256",
  "outputIndexDigestSha256",
  "outputCount",
  "finalStateDigestSha256",
  "finalStateRecordCount",
  "oracleObservationDigestSha256",
] as const;
const REPLAY_INPUT_KEYS = [
  "target",
  "classification",
  "exactEligible",
  "inputSetDigestSha256",
  "gaps",
] as const;
const REPLAY_GAP_KEYS = [
  "kind",
  "sourceKind",
  "deterministicInputKind",
  "cassetteKind",
] as const;
const CORRECTNESS_KEYS = ["oracleSetDigestSha256", "oracleCount", "production", "desired"] as const;
const CORRECTNESS_OBSERVATION_KEYS = ["observationDigestSha256", "verdict"] as const;
const RUN_KEYS = ["phase", "inputFidelity", "observationDigestSha256", "verdict"] as const;

type EpisodeField = Extract<ProductionCaptureEpisodeError, { kind: "invalid_episode" }>["field"];

function invalidEpisode(
  field: EpisodeField,
): Result<never, ProductionCaptureEpisodeError> {
  return err({
    kind: "invalid_episode",
    field,
    message: "Production capture episode contract is invalid",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isNullableBoundedCount(value: unknown): value is number | null {
  return value === null || isBoundedCount(value);
}

function isNullableBoundedBytes(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_SNAPSHOT_BYTES)
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableSafeTimestamp(value: unknown): value is number | null {
  return value === null || isSafeTimestamp(value);
}

function validateWatermark(value: unknown): value is ProductionEpisodeWatermark | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, WATERMARK_KEYS) &&
    isBoundedCount(value.sequence) &&
    isDigest(value.ledgerDigestSha256)
  );
}

function validateCoverageFields(value: Record<string, unknown>): boolean {
  return (
    (value.status === "covered" || value.status === "gap") &&
    validateWatermark(value.startWatermark) &&
    validateWatermark(value.endWatermark) &&
    isNullableBoundedCount(value.authoritativeCount) &&
    typeof value.contiguous === "boolean" &&
    isNullableDigest(value.coverageAttestationDigestSha256) &&
    (value.gapReason === null ||
      (typeof value.gapReason === "string" && COVERAGE_GAP_VALUES.has(value.gapReason))) &&
    (value.status === "covered" ? value.gapReason === null : value.gapReason !== null)
  );
}

function validateWindow(value: unknown): value is ProductionEpisodeWindow {
  if (!isRecord(value) || !hasExactKeys(value, WINDOW_KEYS)) return false;
  if (
    !isSafeTimestamp(value.startAtMs) ||
    !isSafeTimestamp(value.endAtMs) ||
    !isDigest(value.startBoundaryDigestSha256) ||
    !isDigest(value.endBoundaryDigestSha256) ||
    !isDigest(value.boundaryLedgerDigestSha256) ||
    !isDigest(value.captureControllerIdentityDigestSha256) ||
    value.startBoundaryDigestSha256 === value.endBoundaryDigestSha256
  ) {
    return false;
  }
  const duration = value.endAtMs - value.startAtMs;
  return duration > 0 && duration <= MAX_PRODUCTION_EPISODE_WINDOW_MS;
}

function validateCheckpointShape(value: unknown): value is ProductionEpisodeInitialCheckpoint {
  if (!isRecord(value) || !hasExactKeys(value, CHECKPOINT_KEYS)) return false;
  if (
    (value.status !== "captured" && value.status !== "missing") ||
    value.phase !== "pre_window" ||
    !isNullableSafeTimestamp(value.capturedAtMs) ||
    (value.quiescence !== "verified" && value.quiescence !== "unverified") ||
    !isNullableDigest(value.quiescenceAttestationDigestSha256) ||
    !isNullableDigest(value.snapshotManifestDigestSha256) ||
    !isNullableDigest(value.stateTreeDigestSha256) ||
    !isNullableBoundedCount(value.entryCount) ||
    !isNullableBoundedBytes(value.bytes)
  ) {
    return false;
  }
  if (value.status === "missing") {
    return (
      value.capturedAtMs === null &&
      value.quiescence === "unverified" &&
      value.quiescenceAttestationDigestSha256 === null &&
      value.snapshotManifestDigestSha256 === null &&
      value.stateTreeDigestSha256 === null &&
      value.entryCount === null &&
      value.bytes === null
    );
  }
  return true;
}

function validateSourceAuthorities(
  value: unknown,
): value is readonly ProductionEpisodeSourceAuthority[] {
  if (!Array.isArray(value) || value.length > MAX_AUTHORITIES) return false;
  const identities = new Set<string>();
  for (const authority of value) {
    if (
      !isRecord(authority) ||
      !hasExactKeys(authority, SOURCE_AUTHORITY_KEYS) ||
      typeof authority.kind !== "string" ||
      !SOURCE_KIND_VALUES.has(authority.kind) ||
      !isDigest(authority.sourceIdDigestSha256) ||
      !validateCoverageFields(authority) ||
      !isBoundedCount(authority.transcriptCount)
    ) {
      return false;
    }
    const identity = `${authority.kind}:${authority.sourceIdDigestSha256}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function validateDeterministicInputs(
  value: unknown,
): value is readonly ProductionEpisodeDeterministicInputAuthority[] {
  if (!Array.isArray(value) || value.length > DETERMINISTIC_INPUT_KINDS.length) return false;
  const kinds = new Set<string>();
  for (const authority of value) {
    if (
      !isRecord(authority) ||
      !hasExactKeys(authority, DETERMINISTIC_AUTHORITY_KEYS) ||
      typeof authority.kind !== "string" ||
      !DETERMINISTIC_KIND_VALUES.has(authority.kind) ||
      !validateCoverageFields(authority) ||
      !isBoundedCount(authority.capturedCount) ||
      kinds.has(authority.kind)
    ) {
      return false;
    }
    kinds.add(authority.kind);
  }
  return true;
}

function validateCassetteAuthorities(
  value: unknown,
): value is readonly ProductionEpisodeCassetteAuthority[] {
  if (!Array.isArray(value) || value.length > CASSETTE_COVERAGE_KINDS.length) return false;
  const kinds = new Set<string>();
  for (const authority of value) {
    if (
      !isRecord(authority) ||
      !hasExactKeys(authority, CASSETTE_AUTHORITY_KEYS) ||
      typeof authority.kind !== "string" ||
      !CASSETTE_KIND_VALUES.has(authority.kind) ||
      !validateCoverageFields(authority) ||
      !isBoundedCount(authority.cassetteCount) ||
      kinds.has(authority.kind)
    ) {
      return false;
    }
    kinds.add(authority.kind);
  }
  return true;
}

function validateFinalObservationShape(
  value: unknown,
): value is ProductionEpisodeFinalObservation {
  if (!isRecord(value) || !hasExactKeys(value, FINAL_OBSERVATION_KEYS)) return false;
  if (
    (value.status !== "captured" && value.status !== "missing") ||
    value.phase !== "post_window" ||
    !isNullableSafeTimestamp(value.observedAtMs) ||
    (value.observerMode !== "independent" &&
      value.observerMode !== "capture_controller" &&
      value.observerMode !== "unavailable") ||
    !isNullableDigest(value.observerIdentityDigestSha256) ||
    !isNullableDigest(value.observationAttestationDigestSha256) ||
    !isNullableDigest(value.outputIndexDigestSha256) ||
    !isNullableBoundedCount(value.outputCount) ||
    !isNullableDigest(value.finalStateDigestSha256) ||
    !isNullableBoundedCount(value.finalStateRecordCount) ||
    !isNullableDigest(value.oracleObservationDigestSha256)
  ) {
    return false;
  }
  if (value.status === "missing") {
    return (
      value.observedAtMs === null &&
      value.observerMode === "unavailable" &&
      value.observerIdentityDigestSha256 === null &&
      value.observationAttestationDigestSha256 === null &&
      value.outputIndexDigestSha256 === null &&
      value.outputCount === null &&
      value.finalStateDigestSha256 === null &&
      value.finalStateRecordCount === null &&
      value.oracleObservationDigestSha256 === null
    );
  }
  return true;
}

function validateReplayGap(value: unknown): value is ProductionEpisodeReplayGap {
  if (!isRecord(value) || !hasExactKeys(value, REPLAY_GAP_KEYS)) return false;
  return (
    typeof value.kind === "string" &&
    GAP_KIND_VALUES.has(value.kind) &&
    (value.sourceKind === null ||
      (typeof value.sourceKind === "string" && SOURCE_KIND_VALUES.has(value.sourceKind))) &&
    (value.deterministicInputKind === null ||
      (typeof value.deterministicInputKind === "string" &&
        DETERMINISTIC_KIND_VALUES.has(value.deterministicInputKind))) &&
    (value.cassetteKind === null ||
      (typeof value.cassetteKind === "string" && CASSETTE_KIND_VALUES.has(value.cassetteKind)))
  );
}

function validateReplayInputShape(value: unknown): value is ProductionEpisodeReplayInput {
  if (!isRecord(value) || !hasExactKeys(value, REPLAY_INPUT_KEYS)) return false;
  if (
    (value.target !== "deterministic_cassette" && value.target !== "live_provider") ||
    (value.classification !== "historical_best_effort" &&
      value.classification !== "prospective_bounded" &&
      value.classification !== "deterministic_cassette_exact" &&
      value.classification !== "live_provider_semantic") ||
    typeof value.exactEligible !== "boolean" ||
    !isDigest(value.inputSetDigestSha256) ||
    !Array.isArray(value.gaps) ||
    value.gaps.length > MAX_GAPS
  ) {
    return false;
  }
  const identities = new Set<string>();
  for (const gap of value.gaps) {
    if (!validateReplayGap(gap)) return false;
    const identity = gapIdentity(gap);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function validateCorrectness(value: unknown): value is ProductionEpisodeCorrectness {
  if (!isRecord(value) || !hasExactKeys(value, CORRECTNESS_KEYS)) return false;
  if (!isDigest(value.oracleSetDigestSha256) || !isBoundedCount(value.oracleCount) || value.oracleCount === 0) {
    return false;
  }
  for (const observation of [value.production, value.desired]) {
    if (
      !isRecord(observation) ||
      !hasExactKeys(observation, CORRECTNESS_OBSERVATION_KEYS) ||
      !isDigest(observation.observationDigestSha256) ||
      (observation.verdict !== "pass" && observation.verdict !== "fail")
    ) {
      return false;
    }
  }
  return true;
}

function gapIdentity(gap: ProductionEpisodeReplayGap): string {
  return [gap.kind, gap.sourceKind, gap.deterministicInputKind, gap.cassetteKind]
    .map((value) => value ?? "-")
    .join(":");
}

function makeGap(
  kind: ProductionEpisodeReplayGapKind,
  sourceKind: TranscriptSourceKind | null = null,
  deterministicInputKind: DeterministicInputKind | null = null,
  cassetteKind: ReplayCassetteKind | null = null,
): ProductionEpisodeReplayGap {
  return { kind, sourceKind, deterministicInputKind, cassetteKind };
}

function addCoverageGaps(
  gaps: ProductionEpisodeReplayGap[],
  authority:
    | ProductionEpisodeSourceAuthority
    | ProductionEpisodeDeterministicInputAuthority
    | ProductionEpisodeCassetteAuthority,
  scope:
    | { readonly kind: "source"; readonly sourceKind: TranscriptSourceKind }
    | { readonly kind: "deterministic"; readonly deterministicInputKind: DeterministicInputKind }
    | { readonly kind: "cassette"; readonly cassetteKind: ReplayCassetteKind },
  capturedCount: number,
): void {
  const scoped = (kind: ProductionEpisodeReplayGapKind): ProductionEpisodeReplayGap =>
    scope.kind === "source"
      ? makeGap(kind, scope.sourceKind)
      : scope.kind === "deterministic"
        ? makeGap(kind, null, scope.deterministicInputKind)
        : makeGap(kind, null, null, scope.cassetteKind);
  const names: Readonly<{
    coverage: ProductionEpisodeReplayGapKind;
    watermark: ProductionEpisodeReplayGapKind;
    sequence: ProductionEpisodeReplayGapKind;
    count: ProductionEpisodeReplayGapKind;
    unattested: ProductionEpisodeReplayGapKind;
  }> =
    scope.kind === "source"
      ? {
          coverage: "source_coverage_gap",
          watermark: "source_watermark_missing",
          sequence: "source_sequence_gap",
          count: "source_count_mismatch",
          unattested: "source_coverage_unattested",
        }
      : scope.kind === "deterministic"
        ? {
            coverage: "deterministic_input_gap",
            watermark: "deterministic_input_watermark_missing",
            sequence: "deterministic_input_sequence_gap",
            count: "deterministic_input_count_mismatch",
            unattested: "deterministic_input_unattested",
          }
        : {
            coverage: "cassette_coverage_gap",
            watermark: "cassette_watermark_missing",
            sequence: "cassette_sequence_gap",
            count: "cassette_count_mismatch",
            unattested: "cassette_coverage_unattested",
          };

  if (authority.status !== "covered") gaps.push(scoped(names.coverage));
  const { startWatermark, endWatermark, authoritativeCount } = authority;
  if (startWatermark === null || endWatermark === null) {
    gaps.push(scoped(names.watermark));
  } else if (
    endWatermark.sequence < startWatermark.sequence ||
    authoritativeCount === null ||
    endWatermark.sequence - startWatermark.sequence !== authoritativeCount ||
    !authority.contiguous
  ) {
    gaps.push(scoped(names.sequence));
  }
  if (authoritativeCount === null || authoritativeCount !== capturedCount) {
    gaps.push(scoped(names.count));
  }
  if (authority.coverageAttestationDigestSha256 === null) {
    gaps.push(scoped(names.unattested));
  }
}

function deriveRequiredGaps(episode: ProductionCaptureEpisode): ProductionEpisodeReplayGap[] {
  const gaps: ProductionEpisodeReplayGap[] = [];
  if (episode.captureMode === "historical_final_state_only") {
    gaps.push(makeGap("historical_final_state_only"));
  }

  const checkpoint = episode.initialCheckpoint;
  if (checkpoint.status !== "captured") {
    gaps.push(makeGap("initial_checkpoint_missing"));
  } else {
    if (
      checkpoint.quiescence !== "verified" ||
      checkpoint.quiescenceAttestationDigestSha256 === null ||
      checkpoint.snapshotManifestDigestSha256 === null ||
      checkpoint.stateTreeDigestSha256 === null ||
      checkpoint.entryCount === null ||
      checkpoint.bytes === null
    ) {
      gaps.push(makeGap("initial_checkpoint_not_quiesced"));
    }
    if (checkpoint.capturedAtMs === null || checkpoint.capturedAtMs > episode.window.startAtMs) {
      gaps.push(makeGap("initial_checkpoint_not_pre_window"));
    }
  }

  const sourcesByKind = new Map<TranscriptSourceKind, ProductionEpisodeSourceAuthority[]>();
  for (const authority of episode.sourceAuthorities) {
    const existing = sourcesByKind.get(authority.kind) ?? [];
    existing.push(authority);
    sourcesByKind.set(authority.kind, existing);
  }
  for (const kind of TRANSCRIPT_EXACT_SOURCE_KINDS) {
    const authorities = sourcesByKind.get(kind) ?? [];
    if (authorities.length === 0) {
      gaps.push(makeGap("source_authority_missing", kind));
      continue;
    }
    for (const authority of authorities) {
      addCoverageGaps(gaps, authority, { kind: "source", sourceKind: kind }, authority.transcriptCount);
    }
  }

  const deterministicByKind = new Map(
    episode.deterministicInputs.map((authority) => [authority.kind, authority] as const),
  );
  for (const kind of DETERMINISTIC_INPUT_KINDS) {
    const authority = deterministicByKind.get(kind);
    if (authority === undefined) {
      gaps.push(makeGap("deterministic_input_missing", null, kind));
      continue;
    }
    addCoverageGaps(
      gaps,
      authority,
      { kind: "deterministic", deterministicInputKind: kind },
      authority.capturedCount,
    );
  }

  if (episode.replayInput.target === "deterministic_cassette") {
    const cassettesByKind = new Map(
      episode.cassetteAuthorities.map((authority) => [authority.kind, authority] as const),
    );
    for (const kind of CASSETTE_COVERAGE_KINDS) {
      const authority = cassettesByKind.get(kind);
      if (authority === undefined) {
        gaps.push(makeGap("cassette_authority_missing", null, null, kind));
        continue;
      }
      addCoverageGaps(
        gaps,
        authority,
        { kind: "cassette", cassetteKind: kind },
        authority.cassetteCount,
      );
    }
  }

  const finalObservation = episode.finalObservation;
  if (finalObservation.status !== "captured") {
    gaps.push(makeGap("final_observation_missing"));
  } else {
    if (
      finalObservation.observedAtMs === null ||
      finalObservation.observedAtMs < episode.window.endAtMs
    ) {
      gaps.push(makeGap("final_observation_not_post_window"));
    }
    if (
      finalObservation.observerMode !== "independent" ||
      finalObservation.observerIdentityDigestSha256 ===
        episode.window.captureControllerIdentityDigestSha256
    ) {
      gaps.push(makeGap("final_observation_not_independent"));
    }
    if (
      finalObservation.observerIdentityDigestSha256 === null ||
      finalObservation.observationAttestationDigestSha256 === null ||
      finalObservation.outputIndexDigestSha256 === null ||
      finalObservation.outputCount === null ||
      finalObservation.finalStateDigestSha256 === null ||
      finalObservation.finalStateRecordCount === null ||
      finalObservation.oracleObservationDigestSha256 === null
    ) {
      gaps.push(makeGap("final_observation_unattested"));
    }
  }

  const unique = new Map(gaps.map((gap) => [gapIdentity(gap), gap] as const));
  return [...unique.values()];
}

function expectedClassification(
  episode: ProductionCaptureEpisode,
  exactEligible: boolean,
): ProductionEpisodeReplayClassification {
  if (episode.captureMode === "historical_final_state_only") return "historical_best_effort";
  if (episode.replayInput.target === "live_provider") return "live_provider_semantic";
  return exactEligible ? "deterministic_cassette_exact" : "prospective_bounded";
}

export function validateProductionCaptureEpisode(
  raw: unknown,
): Result<ProductionCaptureEpisode, ProductionCaptureEpisodeError> {
  if (!isRecord(raw) || !hasExactKeys(raw, EPISODE_KEYS)) return invalidEpisode("episode");
  if (
    raw.schema !== "comis-production-capture-episode" ||
    raw.schemaVersion !== 1 ||
    typeof raw.episodeId !== "string" ||
    !SAFE_ID_RE.test(raw.episodeId) ||
    (raw.captureMode !== "prospective_window" && raw.captureMode !== "historical_final_state_only")
  ) {
    return invalidEpisode("episode");
  }
  if (!validateWindow(raw.window)) return invalidEpisode("window");
  if (!validateCheckpointShape(raw.initialCheckpoint)) return invalidEpisode("initialCheckpoint");
  if (!validateSourceAuthorities(raw.sourceAuthorities)) return invalidEpisode("sourceAuthorities");
  if (!validateDeterministicInputs(raw.deterministicInputs)) {
    return invalidEpisode("deterministicInputs");
  }
  if (!validateCassetteAuthorities(raw.cassetteAuthorities)) {
    return invalidEpisode("cassetteAuthorities");
  }
  if (!validateFinalObservationShape(raw.finalObservation)) {
    return invalidEpisode("finalObservation");
  }
  if (!validateReplayInputShape(raw.replayInput)) return invalidEpisode("replayInput");
  if (!validateCorrectness(raw.correctness)) return invalidEpisode("correctness");

  const episode = raw as unknown as ProductionCaptureEpisode;
  if (
    episode.captureMode === "historical_final_state_only" &&
    episode.initialCheckpoint.status !== "missing"
  ) {
    return invalidEpisode("initialCheckpoint");
  }
  if (
    episode.finalObservation.status === "captured" &&
    episode.finalObservation.oracleObservationDigestSha256 !==
      episode.correctness.production.observationDigestSha256
  ) {
    return invalidEpisode("correctness");
  }

  const requiredGaps = deriveRequiredGaps(episode);
  const declaredGapIds = new Set(episode.replayInput.gaps.map(gapIdentity));
  if (requiredGaps.some((gap) => !declaredGapIds.has(gapIdentity(gap)))) {
    return invalidEpisode("replayInput");
  }
  const exactEligible =
    episode.captureMode === "prospective_window" &&
    episode.replayInput.target === "deterministic_cassette" &&
    episode.replayInput.gaps.length === 0 &&
    requiredGaps.length === 0;
  if (
    episode.replayInput.exactEligible !== exactEligible ||
    episode.replayInput.classification !== expectedClassification(episode, exactEligible)
  ) {
    return invalidEpisode("replayInput");
  }
  return ok(episode);
}

export function formatProductionCaptureEpisode(
  raw: unknown,
): Result<string, ProductionCaptureEpisodeError> {
  const validated = validateProductionCaptureEpisode(raw);
  if (!validated.ok) return validated;
  const encoded = tryCatch(() => JSON.stringify(validated.value));
  if (!encoded.ok) return invalidEpisode("episode");
  const envelope = `${PRODUCTION_CAPTURE_EPISODE_BEGIN}\n${encoded.value}\n${PRODUCTION_CAPTURE_EPISODE_END}\n`;
  if (new TextEncoder().encode(envelope).byteLength > MAX_PRODUCTION_CAPTURE_EPISODE_BYTES) {
    return err({
      kind: "invalid_envelope",
      field: "envelope",
      message: "Production capture episode envelope exceeds the byte limit",
    });
  }
  return ok(envelope);
}

export function parseProductionCaptureEpisode(
  envelope: string,
): Result<ProductionCaptureEpisode, ProductionCaptureEpisodeError> {
  if (
    typeof envelope !== "string" ||
    new TextEncoder().encode(envelope).byteLength > MAX_PRODUCTION_CAPTURE_EPISODE_BYTES
  ) {
    return err({
      kind: "invalid_envelope",
      field: "envelope",
      message: "Production capture episode envelope is invalid",
    });
  }
  const lines = envelope.split("\n");
  if (
    lines.length !== 4 ||
    lines[0] !== PRODUCTION_CAPTURE_EPISODE_BEGIN ||
    lines[2] !== PRODUCTION_CAPTURE_EPISODE_END ||
    lines[3] !== "" ||
    lines[1] === ""
  ) {
    return err({
      kind: "invalid_envelope",
      field: "envelope",
      message: "Production capture episode envelope is invalid",
    });
  }
  const decoded = tryCatch(() => JSON.parse(lines[1] as string) as unknown);
  if (!decoded.ok) {
    return err({
      kind: "invalid_envelope",
      field: "envelope",
      message: "Production capture episode envelope is invalid",
    });
  }
  return validateProductionCaptureEpisode(decoded.value);
}

export function evaluateProductionEpisodeRun(
  episode: ProductionCaptureEpisode,
  rawRun: unknown,
): Result<ProductionEpisodeRunEvaluation, ProductionCaptureEpisodeError> {
  const validated = validateProductionCaptureEpisode(episode);
  if (!validated.ok) return validated;
  if (
    !isRecord(rawRun) ||
    !hasExactKeys(rawRun, RUN_KEYS) ||
    (rawRun.phase !== "reproduction" && rawRun.phase !== "verification") ||
    (rawRun.inputFidelity !== "matched" && rawRun.inputFidelity !== "diverged") ||
    !isDigest(rawRun.observationDigestSha256) ||
    (rawRun.verdict !== "pass" && rawRun.verdict !== "fail")
  ) {
    return err({
      kind: "invalid_run",
      field: "run",
      message: "Production episode run observation is invalid",
    });
  }

  const run = rawRun as unknown as ProductionEpisodeRunInput;
  const productionObservationMatched =
    run.observationDigestSha256 === validated.value.correctness.production.observationDigestSha256 &&
    run.verdict === validated.value.correctness.production.verdict;
  const desiredObservationMatched =
    run.observationDigestSha256 === validated.value.correctness.desired.observationDigestSha256 &&
    run.verdict === validated.value.correctness.desired.verdict;

  let correctness: ProductionEpisodeRunEvaluation["correctness"];
  if (run.inputFidelity === "diverged") {
    correctness = "not_evaluated";
  } else if (run.phase === "reproduction") {
    correctness = productionObservationMatched
      ? run.verdict === "fail"
        ? "red_reproduced"
        : "production_pass_reproduced"
      : "oracle_mismatch";
  } else if (desiredObservationMatched) {
    correctness = run.verdict === "pass" ? "green_verified" : "desired_failure_verified";
  } else if (productionObservationMatched && run.verdict === "fail") {
    correctness = "production_bug_persists";
  } else {
    correctness = "oracle_mismatch";
  }

  return ok({
    phase: run.phase,
    inputFidelity: run.inputFidelity,
    correctness,
    productionObservationMatched,
    desiredObservationMatched,
  });
}
