// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  TRANSCRIPT_SOURCE_KINDS,
  type TranscriptCaptureGapReason,
  type TranscriptFidelity,
  type TranscriptSourceKind,
} from "./production-transcript.js";

export const PRODUCTION_REPLAY_BUNDLE_BEGIN = "COMIS_PRODUCTION_REPLAY_BUNDLE_V1_BEGIN";
export const PRODUCTION_REPLAY_BUNDLE_END = "COMIS_PRODUCTION_REPLAY_BUNDLE_V1_END";
export const MAX_PRODUCTION_REPLAY_BUNDLE_BYTES = 32 * 1024 * 1024;

export const DETERMINISTIC_SEQUENCE_KINDS = ["clock", "random", "identifier"] as const;
export const CASSETTE_KINDS = [
  "model",
  "tool",
  "mcp",
  "web",
  "media",
  "channel",
  "external_io",
] as const;

export const REPLAY_BUNDLE_BLOB_KINDS = [
  "runtime_archive",
  "state_archive",
  "snapshot_manifest",
  "source_evidence",
  "target_evidence",
  "capture_episode",
  "canonical_transcript",
  "clock_sequence",
  "random_sequence",
  "identifier_sequence",
  "cassette_request",
  "cassette_response",
  "expected_outputs",
  "expected_state",
] as const;

export const REPLAY_BUNDLE_FIDELITY_GAP_KINDS = [
  "source_authority_gap",
  "transcript_incomplete",
  "runtime_mismatch",
  "state_mismatch",
  "deterministic_sequence_missing",
  "cassette_source_missing",
  "cassette_count_mismatch",
  "external_dependency_unrecorded",
  "live_provider_nondeterminism",
  "capture_consistency_gap",
] as const;

export type DeterministicSequenceKind = (typeof DETERMINISTIC_SEQUENCE_KINDS)[number];
export type ReplayCassetteKind = (typeof CASSETTE_KINDS)[number];
export type ReplayBundleBlobKind = (typeof REPLAY_BUNDLE_BLOB_KINDS)[number];
export type ReplayBundleFidelityGapKind =
  (typeof REPLAY_BUNDLE_FIDELITY_GAP_KINDS)[number];
export type ReplayCaptureStatus = "captured" | "missing";
export type ReplayDeterminismGapReason =
  | "missing_artifact"
  | "non_durable"
  | "capture_error"
  | "unsupported_source"
  | "external_call_not_recorded"
  | "partial_retention";

export interface ReplayBundleBlob {
  readonly digestSha256: string;
  readonly bytes: number;
  readonly kind: ReplayBundleBlobKind;
}

export interface ReplayBundleVault {
  readonly format: "aes-256-gcm-detached-v1";
  readonly encryptionKeyIdSha256: string;
  readonly blobs: readonly ReplayBundleBlob[];
}

export interface ReplayHostAttestation {
  readonly role: "production_source" | "replay_target";
  readonly machineIdSha256: string;
  readonly profileDigestSha256: string;
  readonly evidenceBlobDigestSha256: string;
}

export interface ReplayRuntimeIdentity {
  readonly digestSha256: string;
  readonly entryCount: number;
  readonly bytes: number;
  readonly version: string;
}

export interface ReplayRuntimeAttestation {
  readonly archiveBlobDigestSha256: string;
  readonly source: ReplayRuntimeIdentity;
  readonly target: ReplayRuntimeIdentity;
  readonly exact: boolean;
}

export interface ReplayStateIdentity {
  readonly treeDigestSha256: string;
  readonly entryCount: number;
  readonly bytes: number;
}

export interface ReplayStateAttestation {
  readonly snapshotManifestBlobDigestSha256: string;
  readonly archiveBlobDigestSha256: string;
  readonly captureMode: "offline" | "bounded-freeze";
  readonly source: ReplayStateIdentity;
  readonly target: ReplayStateIdentity;
  readonly exact: boolean;
}

export interface ReplayBundleAttestations {
  readonly source: ReplayHostAttestation;
  readonly target: ReplayHostAttestation;
  readonly runtime: ReplayRuntimeAttestation;
  readonly state: ReplayStateAttestation;
}

export interface ReplayTranscriptAuthority {
  readonly kind: TranscriptSourceKind;
  readonly sourceId: string;
  readonly status: "available" | "missing" | "unreadable" | "unsupported" | "not_configured";
  readonly authoritativeCount: number | null;
  readonly transcriptCount: number;
  readonly gapReasons: readonly TranscriptCaptureGapReason[];
}

export interface ReplayBundleTranscript {
  readonly blobDigestSha256: string;
  readonly captureId: string;
  readonly eventCount: number;
  readonly authorities: readonly ReplayTranscriptAuthority[];
}

export type ReplayEpisodeCaptureMode =
  | "prospective_window"
  | "historical_final_state_only";
export type ReplayEpisodeClassification =
  | "historical_best_effort"
  | "prospective_bounded"
  | "deterministic_cassette_exact"
  | "live_provider_semantic";

export interface ReplayBundleEpisode {
  readonly blobDigestSha256: string;
  /** SHA-256 of the strict plaintext episode envelope, sealed by the bundle manifest. */
  readonly contentDigestSha256: string;
  readonly episodeId: string;
  readonly captureMode: ReplayEpisodeCaptureMode;
  readonly windowStartAtMs: number;
  readonly windowEndAtMs: number;
  readonly initialCheckpointSnapshotManifestDigestSha256: string | null;
  readonly inputSetDigestSha256: string;
  readonly target: "deterministic_cassette" | "live_provider";
  readonly classification: ReplayEpisodeClassification;
  readonly exactEligible: boolean;
}

export interface ReplayDeterministicSequence {
  readonly kind: DeterministicSequenceKind;
  readonly status: ReplayCaptureStatus;
  readonly recordCount: number;
  readonly blobDigestSha256: string | null;
  readonly gapReason: ReplayDeterminismGapReason | null;
}

export interface ReplayCassetteAuthority {
  readonly kind: ReplayCassetteKind;
  readonly status: ReplayCaptureStatus;
  readonly authoritativeCount: number | null;
  readonly cassetteCount: number;
  readonly gapReason: ReplayDeterminismGapReason | null;
}

export interface ReplayCassette {
  readonly cassetteId: string;
  readonly kind: ReplayCassetteKind;
  readonly ordinal: number;
  readonly requestBlobDigestSha256: string;
  readonly responseBlobDigestSha256: string;
  readonly outcome: "success" | "error" | "timeout" | "cancelled";
  readonly latencyMs: number;
}

export interface ReplayBundleDeterminism {
  readonly sequences: readonly ReplayDeterministicSequence[];
  readonly cassetteAuthorities: readonly ReplayCassetteAuthority[];
  readonly cassettes: readonly ReplayCassette[];
}

export interface ReplayBundleExpectedResult {
  readonly outputCount: number;
  readonly outputBlobDigestSha256: string;
  readonly finalStateRecordCount: number;
  readonly finalStateBlobDigestSha256: string;
  readonly finalStateDigestSha256: string;
}

export interface ReplayBundleFidelityGap {
  readonly kind: ReplayBundleFidelityGapKind;
  readonly componentId: string | null;
  readonly sourceKind: TranscriptSourceKind | null;
}

export interface ReplayBundleFidelity {
  readonly classification: TranscriptFidelity;
  readonly target: "deterministic_cassette" | "live_provider";
  readonly exactEligible: boolean;
  readonly gaps: readonly ReplayBundleFidelityGap[];
}

export interface ProductionReplayBundleUnsignedManifest {
  readonly schema: "comis-production-replay-bundle";
  readonly schemaVersion: 1;
  readonly bundleId: string;
  readonly createdAtMs: number;
  readonly attestations: ReplayBundleAttestations;
  readonly vault: ReplayBundleVault;
  readonly episode: ReplayBundleEpisode;
  readonly transcript: ReplayBundleTranscript;
  readonly determinism: ReplayBundleDeterminism;
  readonly expected: ReplayBundleExpectedResult;
  readonly fidelity: ReplayBundleFidelity;
}

export interface ProductionReplayBundleSeal {
  readonly algorithm: "hmac-sha256";
  readonly canonicalization: "comis-json-c14n-v1";
  readonly keyIdSha256: string;
  readonly manifestDigestSha256: string;
  readonly authenticationTagSha256: string;
}

export interface ProductionReplayBundleManifest extends ProductionReplayBundleUnsignedManifest {
  readonly seal: ProductionReplayBundleSeal;
}

export type ProductionReplayBundleError =
  | {
      readonly kind: "invalid_manifest";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "invalid_seal";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_seal_key";
      readonly message: string;
    };

const MAX_BLOBS = 200_000;
const MAX_CASSETTES = 100_000;
const MAX_AUTHORITIES = 10_000;
const MAX_FIDELITY_GAPS = 10_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

const BLOB_KIND_VALUES = new Set<string>(REPLAY_BUNDLE_BLOB_KINDS);
const SOURCE_KIND_VALUES = new Set<string>(TRANSCRIPT_SOURCE_KINDS);
const CAPTURE_GAP_VALUES = new Set<string>([
  "missing_artifact",
  "unreadable_artifact",
  "unsupported_source",
  "partial_retention",
  "rotation_loss",
  "queue_drop",
  "scan_limit",
  "external_path_unscanned",
  "non_durable",
  "count_unknown",
  "timestamp_gap",
  "capture_error",
]);
const DETERMINISM_GAP_VALUES = new Set<string>([
  "missing_artifact",
  "non_durable",
  "capture_error",
  "unsupported_source",
  "external_call_not_recorded",
  "partial_retention",
]);
const FIDELITY_VALUES = new Set<string>([
  "historical_best_effort",
  "complete_input",
  "state_equivalent",
  "deterministic_cassette_exact",
  "live_provider_semantic",
]);
const FIDELITY_GAP_VALUES = new Set<string>(REPLAY_BUNDLE_FIDELITY_GAP_KINDS);
const CASSETTE_KIND_VALUES = new Set<string>(CASSETTE_KINDS);
const SEQUENCE_KIND_VALUES = new Set<string>(DETERMINISTIC_SEQUENCE_KINDS);
const OUTCOME_VALUES = new Set<string>(["success", "error", "timeout", "cancelled"]);
const AUTHORITY_STATUS_VALUES = new Set<string>([
  "available",
  "missing",
  "unreadable",
  "unsupported",
  "not_configured",
]);

const UNSIGNED_KEYS = [
  "schema",
  "schemaVersion",
  "bundleId",
  "createdAtMs",
  "attestations",
  "vault",
  "episode",
  "transcript",
  "determinism",
  "expected",
  "fidelity",
] as const;
const MANIFEST_KEYS = [...UNSIGNED_KEYS, "seal"] as const;

const INPUT_SOURCE_KINDS = [
  "offline_messages",
  "cron_store",
  "cron_execution",
  "heartbeat",
  "proactive",
  "system_dispatch",
] as const satisfies readonly TranscriptSourceKind[];
const STATE_SOURCE_KINDS = [
  ...INPUT_SOURCE_KINDS,
  "session",
  "lcd",
  "delivery",
  "memory",
  "durable_run",
  "state",
  "config",
] as const satisfies readonly TranscriptSourceKind[];

function invalidManifest(
  field: string,
  message = "Replay bundle manifest field is invalid",
): Result<never, ProductionReplayBundleError> {
  return err({ kind: "invalid_manifest", field, message });
}

function invalidSeal(): Result<never, ProductionReplayBundleError> {
  return err({ kind: "invalid_seal", message: "Replay bundle manifest seal is invalid" });
}

function invalidSealKey(): Result<never, ProductionReplayBundleError> {
  return err({
    kind: "invalid_seal_key",
    message: "Replay bundle seal key must contain between 32 and 64 bytes",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateHost(
  raw: unknown,
  role: ReplayHostAttestation["role"],
): Result<ReplayHostAttestation, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "role",
      "machineIdSha256",
      "profileDigestSha256",
      "evidenceBlobDigestSha256",
    ]) ||
    raw.role !== role ||
    !isDigest(raw.machineIdSha256) ||
    !isDigest(raw.profileDigestSha256) ||
    !isDigest(raw.evidenceBlobDigestSha256)
  ) {
    return invalidManifest("attestations.host");
  }
  return ok(raw as unknown as ReplayHostAttestation);
}

function validateRuntimeIdentity(
  raw: unknown,
): Result<ReplayRuntimeIdentity, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["digestSha256", "entryCount", "bytes", "version"]) ||
    !isDigest(raw.digestSha256) ||
    !isPositiveSafeInteger(raw.entryCount) ||
    !isPositiveSafeInteger(raw.bytes) ||
    typeof raw.version !== "string" ||
    !SAFE_VERSION_RE.test(raw.version)
  ) {
    return invalidManifest("attestations.runtime.identity");
  }
  return ok(raw as unknown as ReplayRuntimeIdentity);
}

function runtimeIdentitiesEqual(
  left: ReplayRuntimeIdentity,
  right: ReplayRuntimeIdentity,
): boolean {
  return (
    left.digestSha256 === right.digestSha256 &&
    left.entryCount === right.entryCount &&
    left.bytes === right.bytes &&
    left.version === right.version
  );
}

function validateRuntime(
  raw: unknown,
): Result<ReplayRuntimeAttestation, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["archiveBlobDigestSha256", "source", "target", "exact"]) ||
    !isDigest(raw.archiveBlobDigestSha256) ||
    typeof raw.exact !== "boolean"
  ) {
    return invalidManifest("attestations.runtime");
  }
  const source = validateRuntimeIdentity(raw.source);
  if (!source.ok) return source;
  const target = validateRuntimeIdentity(raw.target);
  if (!target.ok) return target;
  if (raw.exact !== runtimeIdentitiesEqual(source.value, target.value)) {
    return invalidManifest("attestations.runtime", "Runtime exactness claim is inconsistent");
  }
  return ok(raw as unknown as ReplayRuntimeAttestation);
}

function validateStateIdentity(
  raw: unknown,
): Result<ReplayStateIdentity, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["treeDigestSha256", "entryCount", "bytes"]) ||
    !isDigest(raw.treeDigestSha256) ||
    !isPositiveSafeInteger(raw.entryCount) ||
    !isPositiveSafeInteger(raw.bytes)
  ) {
    return invalidManifest("attestations.state.identity");
  }
  return ok(raw as unknown as ReplayStateIdentity);
}

function stateIdentitiesEqual(left: ReplayStateIdentity, right: ReplayStateIdentity): boolean {
  return (
    left.treeDigestSha256 === right.treeDigestSha256 &&
    left.entryCount === right.entryCount &&
    left.bytes === right.bytes
  );
}

function validateState(
  raw: unknown,
): Result<ReplayStateAttestation, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "snapshotManifestBlobDigestSha256",
      "archiveBlobDigestSha256",
      "captureMode",
      "source",
      "target",
      "exact",
    ]) ||
    !isDigest(raw.snapshotManifestBlobDigestSha256) ||
    !isDigest(raw.archiveBlobDigestSha256) ||
    (raw.captureMode !== "offline" && raw.captureMode !== "bounded-freeze") ||
    typeof raw.exact !== "boolean"
  ) {
    return invalidManifest("attestations.state");
  }
  const source = validateStateIdentity(raw.source);
  if (!source.ok) return source;
  const target = validateStateIdentity(raw.target);
  if (!target.ok) return target;
  if (raw.exact !== stateIdentitiesEqual(source.value, target.value)) {
    return invalidManifest("attestations.state", "State exactness claim is inconsistent");
  }
  return ok(raw as unknown as ReplayStateAttestation);
}

function validateAttestations(
  raw: unknown,
): Result<ReplayBundleAttestations, ProductionReplayBundleError> {
  if (!isRecord(raw) || !hasExactKeys(raw, ["source", "target", "runtime", "state"])) {
    return invalidManifest("attestations");
  }
  const source = validateHost(raw.source, "production_source");
  if (!source.ok) return source;
  const target = validateHost(raw.target, "replay_target");
  if (!target.ok) return target;
  if (source.value.machineIdSha256 === target.value.machineIdSha256) {
    return invalidManifest("attestations.target", "Replay target must differ from production source");
  }
  const runtime = validateRuntime(raw.runtime);
  if (!runtime.ok) return runtime;
  const state = validateState(raw.state);
  if (!state.ok) return state;
  return ok(raw as unknown as ReplayBundleAttestations);
}

function validateVault(raw: unknown): Result<ReplayBundleVault, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["format", "encryptionKeyIdSha256", "blobs"]) ||
    raw.format !== "aes-256-gcm-detached-v1" ||
    !isDigest(raw.encryptionKeyIdSha256) ||
    !Array.isArray(raw.blobs) ||
    raw.blobs.length === 0 ||
    raw.blobs.length > MAX_BLOBS
  ) {
    return invalidManifest("vault");
  }
  const digests = new Set<string>();
  for (const blob of raw.blobs) {
    if (
      !isRecord(blob) ||
      !hasExactKeys(blob, ["digestSha256", "bytes", "kind"]) ||
      !isDigest(blob.digestSha256) ||
      !isPositiveSafeInteger(blob.bytes) ||
      typeof blob.kind !== "string" ||
      !BLOB_KIND_VALUES.has(blob.kind) ||
      digests.has(blob.digestSha256)
    ) {
      return invalidManifest("vault.blobs");
    }
    digests.add(blob.digestSha256);
  }
  return ok(raw as unknown as ReplayBundleVault);
}

function validateAuthority(
  raw: unknown,
): Result<ReplayTranscriptAuthority, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "sourceId",
      "status",
      "authoritativeCount",
      "transcriptCount",
      "gapReasons",
    ]) ||
    typeof raw.kind !== "string" ||
    !SOURCE_KIND_VALUES.has(raw.kind) ||
    !isSafeId(raw.sourceId) ||
    typeof raw.status !== "string" ||
    !AUTHORITY_STATUS_VALUES.has(raw.status) ||
    !isNonNegativeSafeInteger(raw.transcriptCount) ||
    !Array.isArray(raw.gapReasons) ||
    raw.gapReasons.length > 32 ||
    raw.gapReasons.some(
      (reason) => typeof reason !== "string" || !CAPTURE_GAP_VALUES.has(reason),
    ) ||
    new Set(raw.gapReasons).size !== raw.gapReasons.length
  ) {
    return invalidManifest("transcript.authorities");
  }
  if (
    (raw.status === "available" && !isNonNegativeSafeInteger(raw.authoritativeCount)) ||
    (raw.status !== "available" && raw.authoritativeCount !== null) ||
    (raw.status === "not_configured" && raw.gapReasons.length !== 0) ||
    (raw.status !== "available" && raw.status !== "not_configured" && raw.gapReasons.length === 0)
  ) {
    return invalidManifest("transcript.authorities");
  }
  return ok(raw as unknown as ReplayTranscriptAuthority);
}

function validateTranscript(
  raw: unknown,
): Result<ReplayBundleTranscript, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["blobDigestSha256", "captureId", "eventCount", "authorities"]) ||
    !isDigest(raw.blobDigestSha256) ||
    !isSafeId(raw.captureId) ||
    !isNonNegativeSafeInteger(raw.eventCount) ||
    !Array.isArray(raw.authorities) ||
    raw.authorities.length > MAX_AUTHORITIES
  ) {
    return invalidManifest("transcript");
  }
  const authorityKeys = new Set<string>();
  let eventCount = 0;
  for (const candidate of raw.authorities) {
    const authority = validateAuthority(candidate);
    if (!authority.ok) return authority;
    const key = `${authority.value.kind}\0${authority.value.sourceId}`;
    if (authorityKeys.has(key)) return invalidManifest("transcript.authorities");
    authorityKeys.add(key);
    eventCount += authority.value.transcriptCount;
    if (!Number.isSafeInteger(eventCount)) return invalidManifest("transcript.eventCount");
  }
  if (eventCount !== raw.eventCount) {
    return invalidManifest("transcript.eventCount", "Transcript authority counts do not reconcile");
  }
  return ok(raw as unknown as ReplayBundleTranscript);
}

function validateEpisode(
  raw: unknown,
): Result<ReplayBundleEpisode, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "blobDigestSha256",
      "contentDigestSha256",
      "episodeId",
      "captureMode",
      "windowStartAtMs",
      "windowEndAtMs",
      "initialCheckpointSnapshotManifestDigestSha256",
      "inputSetDigestSha256",
      "target",
      "classification",
      "exactEligible",
    ]) ||
    !isDigest(raw.blobDigestSha256) ||
    !isDigest(raw.contentDigestSha256) ||
    !isSafeId(raw.episodeId) ||
    (raw.captureMode !== "prospective_window" &&
      raw.captureMode !== "historical_final_state_only") ||
    !isNonNegativeSafeInteger(raw.windowStartAtMs) ||
    !isNonNegativeSafeInteger(raw.windowEndAtMs) ||
    raw.windowEndAtMs <= raw.windowStartAtMs ||
    (raw.initialCheckpointSnapshotManifestDigestSha256 !== null &&
      !isDigest(raw.initialCheckpointSnapshotManifestDigestSha256)) ||
    !isDigest(raw.inputSetDigestSha256) ||
    (raw.target !== "deterministic_cassette" && raw.target !== "live_provider") ||
    (raw.classification !== "historical_best_effort" &&
      raw.classification !== "prospective_bounded" &&
      raw.classification !== "deterministic_cassette_exact" &&
      raw.classification !== "live_provider_semantic") ||
    typeof raw.exactEligible !== "boolean"
  ) {
    return invalidManifest("episode");
  }

  const exactEligible =
    raw.captureMode === "prospective_window" &&
    raw.target === "deterministic_cassette" &&
    raw.initialCheckpointSnapshotManifestDigestSha256 !== null &&
    raw.classification === "deterministic_cassette_exact";
  const expectedClassification: ReplayEpisodeClassification =
    raw.captureMode === "historical_final_state_only"
      ? "historical_best_effort"
      : raw.target === "live_provider"
        ? "live_provider_semantic"
        : raw.exactEligible
          ? "deterministic_cassette_exact"
          : "prospective_bounded";
  if (
    raw.exactEligible !== exactEligible ||
    raw.classification !== expectedClassification ||
    (raw.captureMode === "historical_final_state_only" &&
      raw.initialCheckpointSnapshotManifestDigestSha256 !== null)
  ) {
    return invalidManifest("episode", "Capture episode eligibility claim is inconsistent");
  }
  return ok(raw as unknown as ReplayBundleEpisode);
}

function validateSequence(
  raw: unknown,
  expectedKind: DeterministicSequenceKind,
): Result<ReplayDeterministicSequence, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "status", "recordCount", "blobDigestSha256", "gapReason"]) ||
    raw.kind !== expectedKind ||
    !SEQUENCE_KIND_VALUES.has(expectedKind) ||
    (raw.status !== "captured" && raw.status !== "missing") ||
    !isNonNegativeSafeInteger(raw.recordCount) ||
    (raw.gapReason !== null &&
      (typeof raw.gapReason !== "string" || !DETERMINISM_GAP_VALUES.has(raw.gapReason)))
  ) {
    return invalidManifest("determinism.sequences");
  }
  if (
    (raw.status === "captured" && (!isDigest(raw.blobDigestSha256) || raw.gapReason !== null)) ||
    (raw.status === "missing" &&
      (raw.blobDigestSha256 !== null || raw.recordCount !== 0 || raw.gapReason === null))
  ) {
    return invalidManifest("determinism.sequences");
  }
  return ok(raw as unknown as ReplayDeterministicSequence);
}

function validateCassetteAuthority(
  raw: unknown,
  expectedKind: ReplayCassetteKind,
): Result<ReplayCassetteAuthority, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "status",
      "authoritativeCount",
      "cassetteCount",
      "gapReason",
    ]) ||
    raw.kind !== expectedKind ||
    !CASSETTE_KIND_VALUES.has(expectedKind) ||
    (raw.status !== "captured" && raw.status !== "missing") ||
    !isNonNegativeSafeInteger(raw.cassetteCount) ||
    (raw.gapReason !== null &&
      (typeof raw.gapReason !== "string" || !DETERMINISM_GAP_VALUES.has(raw.gapReason)))
  ) {
    return invalidManifest("determinism.cassetteAuthorities");
  }
  if (
    (raw.status === "captured" &&
      (!isNonNegativeSafeInteger(raw.authoritativeCount) || raw.gapReason !== null)) ||
    (raw.status === "missing" &&
      (raw.authoritativeCount !== null || raw.cassetteCount !== 0 || raw.gapReason === null))
  ) {
    return invalidManifest("determinism.cassetteAuthorities");
  }
  return ok(raw as unknown as ReplayCassetteAuthority);
}

function validateCassette(
  raw: unknown,
): Result<ReplayCassette, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "cassetteId",
      "kind",
      "ordinal",
      "requestBlobDigestSha256",
      "responseBlobDigestSha256",
      "outcome",
      "latencyMs",
    ]) ||
    !isSafeId(raw.cassetteId) ||
    typeof raw.kind !== "string" ||
    !CASSETTE_KIND_VALUES.has(raw.kind) ||
    !isPositiveSafeInteger(raw.ordinal) ||
    !isDigest(raw.requestBlobDigestSha256) ||
    !isDigest(raw.responseBlobDigestSha256) ||
    typeof raw.outcome !== "string" ||
    !OUTCOME_VALUES.has(raw.outcome) ||
    !isNonNegativeSafeInteger(raw.latencyMs)
  ) {
    return invalidManifest("determinism.cassettes");
  }
  return ok(raw as unknown as ReplayCassette);
}

function validateDeterminism(
  raw: unknown,
): Result<ReplayBundleDeterminism, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["sequences", "cassetteAuthorities", "cassettes"]) ||
    !Array.isArray(raw.sequences) ||
    raw.sequences.length !== DETERMINISTIC_SEQUENCE_KINDS.length ||
    !Array.isArray(raw.cassetteAuthorities) ||
    raw.cassetteAuthorities.length !== CASSETTE_KINDS.length ||
    !Array.isArray(raw.cassettes) ||
    raw.cassettes.length > MAX_CASSETTES
  ) {
    return invalidManifest("determinism");
  }
  for (let index = 0; index < DETERMINISTIC_SEQUENCE_KINDS.length; index += 1) {
    const kind = DETERMINISTIC_SEQUENCE_KINDS.at(index) as DeterministicSequenceKind;
    const sequence = validateSequence(raw.sequences.at(index), kind);
    if (!sequence.ok) return sequence;
  }
  for (let index = 0; index < CASSETTE_KINDS.length; index += 1) {
    const kind = CASSETTE_KINDS.at(index) as ReplayCassetteKind;
    const authority = validateCassetteAuthority(raw.cassetteAuthorities.at(index), kind);
    if (!authority.ok) return authority;
  }

  const cassetteIds = new Set<string>();
  const kindCounts = new Map<ReplayCassetteKind, number>();
  for (const candidate of raw.cassettes) {
    const cassette = validateCassette(candidate);
    if (!cassette.ok) return cassette;
    if (cassetteIds.has(cassette.value.cassetteId)) {
      return invalidManifest("determinism.cassettes");
    }
    cassetteIds.add(cassette.value.cassetteId);
    const priorCount = kindCounts.get(cassette.value.kind) ?? 0;
    if (cassette.value.ordinal !== priorCount + 1) {
      return invalidManifest("determinism.cassettes", "Cassette ordinals are not contiguous");
    }
    kindCounts.set(cassette.value.kind, priorCount + 1);
  }
  for (const candidate of raw.cassetteAuthorities) {
    const authority = candidate as ReplayCassetteAuthority;
    if ((kindCounts.get(authority.kind) ?? 0) !== authority.cassetteCount) {
      return invalidManifest(
        "determinism.cassetteAuthorities",
        "Cassette inventory does not reconcile",
      );
    }
  }
  return ok(raw as unknown as ReplayBundleDeterminism);
}

function validateExpected(
  raw: unknown,
): Result<ReplayBundleExpectedResult, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "outputCount",
      "outputBlobDigestSha256",
      "finalStateRecordCount",
      "finalStateBlobDigestSha256",
      "finalStateDigestSha256",
    ]) ||
    !isNonNegativeSafeInteger(raw.outputCount) ||
    !isDigest(raw.outputBlobDigestSha256) ||
    !isNonNegativeSafeInteger(raw.finalStateRecordCount) ||
    !isDigest(raw.finalStateBlobDigestSha256) ||
    !isDigest(raw.finalStateDigestSha256)
  ) {
    return invalidManifest("expected");
  }
  return ok(raw as unknown as ReplayBundleExpectedResult);
}

function validateFidelity(
  raw: unknown,
): Result<ReplayBundleFidelity, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["classification", "target", "exactEligible", "gaps"]) ||
    typeof raw.classification !== "string" ||
    !FIDELITY_VALUES.has(raw.classification) ||
    (raw.target !== "deterministic_cassette" && raw.target !== "live_provider") ||
    typeof raw.exactEligible !== "boolean" ||
    !Array.isArray(raw.gaps) ||
    raw.gaps.length > MAX_FIDELITY_GAPS
  ) {
    return invalidManifest("fidelity");
  }
  const gaps = new Set<string>();
  for (const gap of raw.gaps) {
    if (
      !isRecord(gap) ||
      !hasExactKeys(gap, ["kind", "componentId", "sourceKind"]) ||
      typeof gap.kind !== "string" ||
      !FIDELITY_GAP_VALUES.has(gap.kind) ||
      (gap.componentId !== null && !isSafeId(gap.componentId)) ||
      (gap.sourceKind !== null &&
        (typeof gap.sourceKind !== "string" || !SOURCE_KIND_VALUES.has(gap.sourceKind)))
    ) {
      return invalidManifest("fidelity.gaps");
    }
    const key = `${gap.kind}\0${gap.componentId ?? ""}\0${gap.sourceKind ?? ""}`;
    if (gaps.has(key)) return invalidManifest("fidelity.gaps");
    gaps.add(key);
  }
  return ok(raw as unknown as ReplayBundleFidelity);
}

function authorityIsComplete(authority: ReplayTranscriptAuthority): boolean {
  return (
    authority.status === "available" &&
    authority.authoritativeCount === authority.transcriptCount &&
    authority.gapReasons.length === 0
  );
}

function authorityKindsAreComplete(
  authorities: readonly ReplayTranscriptAuthority[],
  required: readonly TranscriptSourceKind[],
): boolean {
  return required.every((kind) => {
    const matching = authorities.filter((authority) => authority.kind === kind);
    return matching.length > 0 && matching.every(authorityIsComplete);
  });
}

function hasFidelityGap(
  fidelity: ReplayBundleFidelity,
  kind: ReplayBundleFidelityGapKind,
): boolean {
  return fidelity.gaps.some((gap) => gap.kind === kind);
}

function hasAuthorityFidelityGap(
  fidelity: ReplayBundleFidelity,
  authority: ReplayTranscriptAuthority,
): boolean {
  return fidelity.gaps.some(
    (gap) =>
      gap.kind === "source_authority_gap" &&
      gap.componentId === authority.sourceId &&
      gap.sourceKind === authority.kind,
  );
}

function validateFidelityClaims(
  attestations: ReplayBundleAttestations,
  episode: ReplayBundleEpisode,
  transcript: ReplayBundleTranscript,
  determinism: ReplayBundleDeterminism,
  fidelity: ReplayBundleFidelity,
): Result<void, ProductionReplayBundleError> {
  const incompleteAuthority = transcript.authorities.some(
    (authority) => !authorityIsComplete(authority),
  );
  const inputComplete = authorityKindsAreComplete(transcript.authorities, INPUT_SOURCE_KINDS);
  const stateComplete = inputComplete && authorityKindsAreComplete(transcript.authorities, STATE_SOURCE_KINDS);
  const exactKindsComplete = authorityKindsAreComplete(
    transcript.authorities,
    TRANSCRIPT_EXACT_SOURCE_KINDS,
  );
  const transcriptExact =
    exactKindsComplete && transcript.authorities.every(authorityIsComplete);
  const sequencesExact = determinism.sequences.every(
    (sequence) => sequence.status === "captured",
  );
  const cassettesExact = determinism.cassetteAuthorities.every(
    (authority) =>
      authority.status === "captured" &&
      authority.authoritativeCount === authority.cassetteCount,
  );
  const missingExactKind = TRANSCRIPT_EXACT_SOURCE_KINDS.some(
    (kind) => !transcript.authorities.some((authority) => authority.kind === kind),
  );

  if (
    incompleteAuthority &&
    transcript.authorities.some(
      (authority) => !authorityIsComplete(authority) && !hasAuthorityFidelityGap(fidelity, authority),
    )
  ) {
    return invalidManifest("fidelity", "Transcript authority gap is not declared");
  }
  if (missingExactKind && !hasFidelityGap(fidelity, "transcript_incomplete")) {
    return invalidManifest("fidelity", "Transcript completeness gap is not declared");
  }
  if (!attestations.runtime.exact && !hasFidelityGap(fidelity, "runtime_mismatch")) {
    return invalidManifest("fidelity", "Runtime mismatch is not declared");
  }
  if (!attestations.state.exact && !hasFidelityGap(fidelity, "state_mismatch")) {
    return invalidManifest("fidelity", "State mismatch is not declared");
  }
  if (!sequencesExact && !hasFidelityGap(fidelity, "deterministic_sequence_missing")) {
    return invalidManifest("fidelity", "Deterministic input gap is not declared");
  }
  if (
    determinism.cassetteAuthorities.some((authority) => authority.status === "missing") &&
    !hasFidelityGap(fidelity, "cassette_source_missing")
  ) {
    return invalidManifest("fidelity", "Cassette source gap is not declared");
  }
  if (
    determinism.cassetteAuthorities.some(
      (authority) =>
        authority.status === "captured" &&
        authority.authoritativeCount !== authority.cassetteCount,
    ) &&
    !hasFidelityGap(fidelity, "cassette_count_mismatch")
  ) {
    return invalidManifest("fidelity", "Cassette count gap is not declared");
  }
  if (fidelity.target !== episode.target) {
    return invalidManifest("fidelity", "Replay target does not match capture episode");
  }
  if (
    fidelity.target === "live_provider" &&
    !hasFidelityGap(fidelity, "live_provider_nondeterminism")
  ) {
    return invalidManifest("fidelity", "Live-provider nondeterminism is not declared");
  }

  const exactEligible =
    episode.exactEligible &&
    episode.captureMode === "prospective_window" &&
    episode.classification === "deterministic_cassette_exact" &&
    fidelity.target === "deterministic_cassette" &&
    attestations.runtime.exact &&
    attestations.state.exact &&
    transcriptExact &&
    sequencesExact &&
    cassettesExact &&
    fidelity.gaps.length === 0;

  let classification: TranscriptFidelity;
  if (episode.captureMode === "historical_final_state_only" || !inputComplete) {
    classification = "historical_best_effort";
  } else if (!stateComplete) classification = "complete_input";
  else if (fidelity.target === "live_provider") classification = "live_provider_semantic";
  else if (exactEligible) classification = "deterministic_cassette_exact";
  else classification = "state_equivalent";

  if (fidelity.exactEligible !== exactEligible || fidelity.classification !== classification) {
    return invalidManifest("fidelity", "Replay fidelity claim exceeds captured evidence");
  }
  return ok(undefined);
}

function validateBlobReferences(
  manifest: ProductionReplayBundleUnsignedManifest,
): Result<void, ProductionReplayBundleError> {
  const blobs = new Map<string, ReplayBundleBlob>();
  for (const blob of manifest.vault.blobs) blobs.set(blob.digestSha256, blob);
  const referenced = new Set<string>();
  const requireBlob = (
    digestSha256: string,
    kind: ReplayBundleBlobKind,
  ): Result<void, ProductionReplayBundleError> => {
    const blob = blobs.get(digestSha256);
    if (blob?.kind !== kind) return invalidManifest("vault.blobs", "Blob reference is unresolved");
    referenced.add(digestSha256);
    return ok(undefined);
  };

  const fixedReferences: readonly [string, ReplayBundleBlobKind][] = [
    [manifest.attestations.source.evidenceBlobDigestSha256, "source_evidence"],
    [manifest.attestations.target.evidenceBlobDigestSha256, "target_evidence"],
    [manifest.attestations.runtime.archiveBlobDigestSha256, "runtime_archive"],
    [manifest.attestations.state.archiveBlobDigestSha256, "state_archive"],
    [manifest.attestations.state.snapshotManifestBlobDigestSha256, "snapshot_manifest"],
    [manifest.episode.blobDigestSha256, "capture_episode"],
    [manifest.transcript.blobDigestSha256, "canonical_transcript"],
    [manifest.expected.outputBlobDigestSha256, "expected_outputs"],
    [manifest.expected.finalStateBlobDigestSha256, "expected_state"],
  ];
  for (const [digestSha256, kind] of fixedReferences) {
    const result = requireBlob(digestSha256, kind);
    if (!result.ok) return result;
  }
  for (const sequence of manifest.determinism.sequences) {
    if (sequence.blobDigestSha256 === null) continue;
    const result = requireBlob(sequence.blobDigestSha256, `${sequence.kind}_sequence`);
    if (!result.ok) return result;
  }
  for (const cassette of manifest.determinism.cassettes) {
    const request = requireBlob(cassette.requestBlobDigestSha256, "cassette_request");
    if (!request.ok) return request;
    const response = requireBlob(cassette.responseBlobDigestSha256, "cassette_response");
    if (!response.ok) return response;
  }
  if (
    referenced.size !== blobs.size ||
    manifest.vault.blobs.some((blob) => !referenced.has(blob.digestSha256))
  ) {
    return invalidManifest("vault.blobs", "Encrypted blob inventory contains an orphan");
  }
  return ok(undefined);
}

function validateUnsigned(
  raw: unknown,
): Result<ProductionReplayBundleUnsignedManifest, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, UNSIGNED_KEYS) ||
    raw.schema !== "comis-production-replay-bundle" ||
    raw.schemaVersion !== 1 ||
    !isSafeId(raw.bundleId) ||
    !isNonNegativeSafeInteger(raw.createdAtMs)
  ) {
    return invalidManifest("header");
  }
  const attestations = validateAttestations(raw.attestations);
  if (!attestations.ok) return attestations;
  const vault = validateVault(raw.vault);
  if (!vault.ok) return vault;
  const episode = validateEpisode(raw.episode);
  if (!episode.ok) return episode;
  const transcript = validateTranscript(raw.transcript);
  if (!transcript.ok) return transcript;
  const determinism = validateDeterminism(raw.determinism);
  if (!determinism.ok) return determinism;
  const expected = validateExpected(raw.expected);
  if (!expected.ok) return expected;
  const fidelity = validateFidelity(raw.fidelity);
  if (!fidelity.ok) return fidelity;

  const manifest = raw as unknown as ProductionReplayBundleUnsignedManifest;
  if (
    manifest.bundleId !== episode.value.episodeId ||
    manifest.transcript.captureId !== episode.value.episodeId ||
    manifest.createdAtMs < episode.value.windowEndAtMs ||
    (episode.value.initialCheckpointSnapshotManifestDigestSha256 !== null &&
      episode.value.initialCheckpointSnapshotManifestDigestSha256 !==
        attestations.value.state.snapshotManifestBlobDigestSha256)
  ) {
    return invalidManifest("episode", "Capture episode identity does not reconcile");
  }
  const references = validateBlobReferences(manifest);
  if (!references.ok) return references;
  const fidelityClaims = validateFidelityClaims(
    attestations.value,
    episode.value,
    transcript.value,
    determinism.value,
    fidelity.value,
  );
  if (!fidelityClaims.ok) return fidelityClaims;
  return ok(manifest);
}

function validateSealShape(
  raw: unknown,
): Result<ProductionReplayBundleSeal, ProductionReplayBundleError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "algorithm",
      "canonicalization",
      "keyIdSha256",
      "manifestDigestSha256",
      "authenticationTagSha256",
    ]) ||
    raw.algorithm !== "hmac-sha256" ||
    raw.canonicalization !== "comis-json-c14n-v1" ||
    !isDigest(raw.keyIdSha256) ||
    !isDigest(raw.manifestDigestSha256) ||
    !isDigest(raw.authenticationTagSha256)
  ) {
    return invalidSeal();
  }
  return ok(raw as unknown as ProductionReplayBundleSeal);
}

function validateSealKey(
  key: Uint8Array,
): Result<Uint8Array, ProductionReplayBundleError> {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 64) {
    return invalidSealKey();
  }
  return ok(key);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("Unsupported canonical JSON value");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sealKeyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("comis-production-replay-seal-key-v1\0")
    .update(key)
    .digest("hex");
}

function sealTag(canonical: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(canonical).digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function sealProductionReplayBundleManifest(
  unsigned: ProductionReplayBundleUnsignedManifest,
  key: Uint8Array,
): Result<ProductionReplayBundleManifest, ProductionReplayBundleError> {
  const validKey = validateSealKey(key);
  if (!validKey.ok) return validKey;
  const validated = validateUnsigned(unsigned);
  if (!validated.ok) return validated;
  const canonical = canonicalJson(validated.value);
  const seal: ProductionReplayBundleSeal = {
    algorithm: "hmac-sha256",
    canonicalization: "comis-json-c14n-v1",
    keyIdSha256: sealKeyId(validKey.value),
    manifestDigestSha256: sha256(canonical),
    authenticationTagSha256: sealTag(canonical, validKey.value),
  };
  return ok({ ...validated.value, seal });
}

export function formatProductionReplayBundleManifest(
  manifest: ProductionReplayBundleManifest,
): string {
  return `${PRODUCTION_REPLAY_BUNDLE_BEGIN}\n${canonicalJson(manifest)}\n${PRODUCTION_REPLAY_BUNDLE_END}\n`;
}

export function parseProductionReplayBundleManifest(
  raw: string,
  key: Uint8Array,
): Result<ProductionReplayBundleManifest, ProductionReplayBundleError> {
  const validKey = validateSealKey(key);
  if (!validKey.ok) return validKey;
  if (
    Buffer.byteLength(raw, "utf8") > MAX_PRODUCTION_REPLAY_BUNDLE_BYTES ||
    raw.includes("\r") ||
    raw.includes("\0")
  ) {
    return invalidManifest("envelope");
  }
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines.at(0) !== PRODUCTION_REPLAY_BUNDLE_BEGIN ||
    lines.at(2) !== PRODUCTION_REPLAY_BUNDLE_END
  ) {
    return invalidManifest("envelope");
  }
  const decoded = tryCatch(() => JSON.parse(lines.at(1) as string) as unknown);
  if (
    !decoded.ok ||
    !isRecord(decoded.value) ||
    !hasExactKeys(decoded.value, MANIFEST_KEYS) ||
    lines.at(1) !== canonicalJson(decoded.value)
  ) {
    return invalidManifest("manifest");
  }
  const seal = validateSealShape(decoded.value.seal);
  if (!seal.ok) return seal;
  const { seal: _seal, ...unsignedRaw } = decoded.value;
  const unsigned = validateUnsigned(unsignedRaw);
  if (!unsigned.ok) return unsigned;
  const canonical = canonicalJson(unsigned.value);
  const expectedKeyId = sealKeyId(validKey.value);
  const expectedDigest = sha256(canonical);
  const expectedTag = sealTag(canonical, validKey.value);
  if (
    !equalDigest(seal.value.keyIdSha256, expectedKeyId) ||
    !equalDigest(seal.value.manifestDigestSha256, expectedDigest) ||
    !equalDigest(seal.value.authenticationTagSha256, expectedTag)
  ) {
    return invalidSeal();
  }
  return ok({ ...unsigned.value, seal: seal.value });
}
