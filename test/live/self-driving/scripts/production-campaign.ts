// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  parseProductionReplayBundleManifest,
  type ProductionReplayBundleManifest,
} from "./production-bundle.js";
import {
  parseProductionCaptureEpisode,
  type ProductionCaptureEpisode,
} from "./production-episode.js";

const MAX_CAMPAIGN_BYTES = 4 * 1024 * 1024;
const MAX_CASES = 100_000;
const MAX_EVIDENCE = 1_000_000;
const MAX_EXACT_BLOCKERS = 1_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/u;
const SAFE_TEST_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+/-]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ProductionCampaignStatus = "ready" | "running" | "completed";
export type ProductionCampaignCaseStatus =
  | "pending"
  | "running"
  | "passed"
  | "passed_after_fix";
export type ProductionCampaignFailureClass =
  | "comis_failure"
  | "false_success"
  | "hard_oracle_failure"
  | "observability_failure"
  | "replay_divergence";
export type ProductionCampaignDefectStatus =
  | "red_reproduced"
  | "diagnosed"
  | "green_built"
  | "deployed"
  | "verified";
export type ProductionCampaignReproductionCorrectness =
  | "red_reproduced"
  | "desired_passed";
export type ProductionCampaignVerificationCorrectness = "green_verified";

interface ProductionCampaignArtifactBase {
  readonly kind: ProductionCampaignArtifactKind;
  readonly artifactRef: string;
  readonly artifactDigestSha256: string;
  readonly authorityKeyIdSha256: string;
  readonly authenticationTagSha256: string;
}

export type ProductionCampaignArtifactKind =
  | "bundle_manifest"
  | "capture_episode"
  | "clean_restore"
  | "replay_report"
  | "replay_observation"
  | "oracle_report"
  | "source_checkout"
  | "source_patch"
  | "diagnosis"
  | "regression_gate"
  | "patch_build"
  | "deployment"
  | "forced_failure_proof";

export interface ProductionCampaignBundleArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "bundle_manifest";
  readonly bundleId: string;
  readonly manifestDigestSha256: string;
}

export interface ProductionCampaignEpisodeArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "capture_episode";
  readonly bundleId: string;
  readonly episodeId: string;
  readonly blobDigestSha256: string;
  readonly contentDigestSha256: string;
}

export interface ProductionCampaignRestoreArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "clean_restore";
  readonly restoreId: string;
  readonly bundleId: string;
  readonly episodeId: string;
  readonly targetMachineIdSha256: string;
  readonly snapshotManifestDigestSha256: string;
  readonly stateTreeDigestSha256: string;
  readonly result: "exact" | "mismatch" | "failed";
  readonly completedAtMs: number;
}

export interface ProductionCampaignReplayArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "replay_report";
  readonly runId: string;
  readonly caseId: string;
  readonly bundleId: string;
  readonly episodeId: string;
  readonly restoreId: string;
  readonly targetMachineIdSha256: string;
  readonly runtimeDigestSha256: string;
  readonly inputSetDigestSha256: string;
  readonly engineKind: "comis_operational" | "generic_contract";
  readonly engineReportDigestSha256: string;
  readonly exact: boolean;
  readonly exactBlockers: readonly string[];
  readonly fidelity: "matched" | "diverged";
  readonly result: "completed" | "failed";
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

export interface ProductionCampaignObservationArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "replay_observation";
  readonly runId: string;
  readonly caseId: string;
  readonly phase: "reproduction" | "verification";
  readonly observerMode: "independent" | "replay_driver";
  readonly observationDigestSha256: string;
  readonly verdict: "pass" | "fail";
  readonly observedAtMs: number;
}

export interface ProductionCampaignOracleArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "oracle_report";
  readonly runId: string;
  readonly caseId: string;
  readonly phase: "reproduction" | "verification";
  readonly oracleSetDigestSha256: string;
  readonly verdict: "pass" | "fail";
  readonly evaluatedAtMs: number;
}

export interface ProductionCampaignSourceCheckoutArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "source_checkout";
  readonly checkoutId: string;
  readonly treeDigestSha256: string;
  readonly baselineRuntimeDigestSha256: string;
  readonly clean: boolean;
  readonly capturedAtMs: number;
}

export interface ProductionCampaignSourcePatchArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "source_patch";
  readonly patchId: string;
  readonly sourceCheckoutId: string;
  readonly baseTreeDigestSha256: string;
  readonly patchedTreeDigestSha256: string;
  readonly patchDigestSha256: string;
  readonly producedAtMs: number;
}

export interface ProductionCampaignDiagnosisArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "diagnosis";
  readonly defectId: string;
  readonly replayRunId: string;
  readonly sourceCheckoutId: string;
  readonly rootCauseDigestSha256: string;
  readonly authoritativeLayer: string;
  readonly recordedAtMs: number;
}

export interface ProductionCampaignRegressionArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "regression_gate";
  readonly gateId: string;
  readonly phase: "pre_patch" | "post_patch" | "deployed";
  readonly subjectId: string;
  readonly runtimeDigestSha256: string;
  readonly testPath: string;
  readonly commandDigestSha256: string;
  readonly result: "pass" | "fail";
  readonly failureShapeDigestSha256: string | null;
  readonly completedAtMs: number;
}

export interface ProductionCampaignBuildArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "patch_build";
  readonly buildId: string;
  readonly sourceCheckoutId: string;
  readonly patchArtifactRef: string;
  readonly sourceTreeDigestSha256: string;
  readonly patchDigestSha256: string;
  readonly runtimeDigestSha256: string;
  readonly result: "success" | "failed";
  readonly builtAtMs: number;
}

export interface ProductionCampaignDeploymentArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "deployment";
  readonly deploymentId: string;
  readonly buildId: string;
  readonly targetMachineIdSha256: string;
  readonly runtimeDigestSha256: string;
  readonly result: "complete" | "failed";
  readonly completedAtMs: number;
}

export interface ProductionCampaignForcedFailureArtifact extends ProductionCampaignArtifactBase {
  readonly kind: "forced_failure_proof";
  readonly runId: string;
  readonly deploymentId: string;
  readonly observerMode: "independent" | "replay_driver";
  readonly expectedFailureObserved: boolean;
  readonly logProofDigestSha256: string;
  readonly eventProofDigestSha256: string;
  readonly hintProofDigestSha256: string;
  readonly completedAtMs: number;
}

export type ProductionCampaignArtifact =
  | ProductionCampaignBundleArtifact
  | ProductionCampaignEpisodeArtifact
  | ProductionCampaignRestoreArtifact
  | ProductionCampaignReplayArtifact
  | ProductionCampaignObservationArtifact
  | ProductionCampaignOracleArtifact
  | ProductionCampaignSourceCheckoutArtifact
  | ProductionCampaignSourcePatchArtifact
  | ProductionCampaignDiagnosisArtifact
  | ProductionCampaignRegressionArtifact
  | ProductionCampaignBuildArtifact
  | ProductionCampaignDeploymentArtifact
  | ProductionCampaignForcedFailureArtifact;

export type ProductionCampaignArtifactResolutionError =
  | { readonly kind: "artifact_unavailable"; readonly message: string }
  | { readonly kind: "artifact_unauthenticated"; readonly message: string };

export interface ProductionCampaignArtifactResolver {
  resolve(
    artifactRef: string,
  ): Result<ProductionCampaignArtifact, ProductionCampaignArtifactResolutionError>;
}

export interface ProductionCampaignIdentity {
  readonly bundleId: string;
  readonly captureId: string;
  readonly bundleManifestDigestSha256: string;
  readonly episodeId: string;
  readonly episodeBlobDigestSha256: string;
  readonly episodeContentDigestSha256: string;
  readonly inputSetDigestSha256: string;
  readonly initialSnapshotManifestDigestSha256: string;
  readonly initialStateTreeDigestSha256: string;
  readonly targetMachineIdSha256: string;
  readonly sourceRuntimeDigestSha256: string;
  readonly productionObservationDigestSha256: string;
  readonly productionVerdict: "pass" | "fail";
  readonly desiredObservationDigestSha256: string;
  readonly desiredVerdict: "pass" | "fail";
  readonly oracleSetDigestSha256: string;
}

export interface ParseProductionCampaignIdentityInput {
  readonly bundleEnvelope: string;
  readonly bundleSealKey: Uint8Array;
  readonly episodeEnvelope: string;
}

export interface ProductionCampaignEvidenceBinding {
  readonly artifactRef: string;
  readonly kind: ProductionCampaignArtifactKind;
  readonly artifactDigestSha256: string;
  readonly authorityKeyIdSha256: string;
  readonly authenticationTagSha256: string;
}

export interface ProductionCampaignCase {
  readonly caseId: string;
  readonly status: ProductionCampaignCaseStatus;
  readonly replayRunId: string | null;
  readonly initialRestoreArtifactRef: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly reproductionReplayArtifactRef: string | null;
  readonly reproductionObservationArtifactRef: string | null;
  readonly reproductionOracleArtifactRef: string | null;
  readonly reproductionFidelity: "matched" | null;
  readonly reproductionCorrectness: ProductionCampaignReproductionCorrectness | null;
  readonly verificationRestoreArtifactRef: string | null;
  readonly verificationReplayArtifactRef: string | null;
  readonly verificationObservationArtifactRef: string | null;
  readonly verificationOracleArtifactRef: string | null;
  readonly verificationCorrectness: ProductionCampaignVerificationCorrectness | null;
  readonly defectId: string | null;
}

export interface ProductionCampaignDefect {
  readonly defectId: string;
  readonly caseId: string;
  readonly status: ProductionCampaignDefectStatus;
  readonly failureClass: ProductionCampaignFailureClass;
  readonly replayRunId: string;
  readonly sourceCheckoutArtifactRef: string | null;
  readonly diagnosisArtifactRef: string | null;
  readonly prePatchRegressionArtifactRef: string | null;
  readonly patchBuildArtifactRef: string | null;
  readonly greenRegressionArtifactRef: string | null;
  readonly deploymentArtifactRef: string | null;
  readonly forcedFailureArtifactRef: string | null;
  readonly deployedRegressionArtifactRef: string | null;
  readonly openedAtMs: number;
  readonly updatedAtMs: number;
}

export interface ProductionCampaign {
  readonly schema: "comis-production-replay-campaign";
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly captureId: string;
  readonly bundleId: string;
  readonly bundleManifestDigestSha256: string;
  readonly bundleArtifactRef: string;
  readonly episodeId: string;
  readonly episodeBlobDigestSha256: string;
  readonly episodeContentDigestSha256: string;
  readonly episodeArtifactRef: string;
  readonly inputSetDigestSha256: string;
  readonly initialSnapshotManifestDigestSha256: string;
  readonly initialStateTreeDigestSha256: string;
  readonly targetMachineIdSha256: string;
  readonly sourceRuntimeDigestSha256: string;
  readonly activeRuntimeDigestSha256: string;
  readonly productionObservationDigestSha256: string;
  readonly productionVerdict: "pass" | "fail";
  readonly desiredObservationDigestSha256: string;
  readonly desiredVerdict: "pass" | "fail";
  readonly oracleSetDigestSha256: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly status: ProductionCampaignStatus;
  readonly exactEligible: true;
  readonly cursor: number;
  readonly openDefectId: string | null;
  readonly cases: readonly ProductionCampaignCase[];
  readonly defects: readonly ProductionCampaignDefect[];
  readonly evidence: readonly ProductionCampaignEvidenceBinding[];
}

export interface CreateProductionCampaignInput {
  readonly campaignId: string;
  readonly identity: ProductionCampaignIdentity;
  readonly bundleArtifactRef: string;
  readonly episodeArtifactRef: string;
  readonly caseIds: readonly string[];
  readonly createdAtMs: number;
}

export type ProductionCampaignAction =
  | {
      readonly kind: "begin_case";
      readonly caseId: string;
      readonly replayRunId: string;
      readonly restoreArtifactRef: string;
      readonly startedAtMs: number;
    }
  | {
      readonly kind: "record_reproduction";
      readonly caseId: string;
      readonly defectId: string | null;
      readonly failureClass: ProductionCampaignFailureClass | null;
      readonly replayReportArtifactRef: string;
      readonly observationArtifactRef: string;
      readonly oracleReportArtifactRef: string;
      readonly completedAtMs: number;
    }
  | {
      readonly kind: "record_diagnosis";
      readonly defectId: string;
      readonly sourceCheckoutArtifactRef: string;
      readonly diagnosisArtifactRef: string;
      readonly prePatchRegressionArtifactRef: string;
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_green";
      readonly defectId: string;
      readonly patchBuildArtifactRef: string;
      readonly regressionGateArtifactRef: string;
      readonly recordedAtMs: number;
    }
  | {
      readonly kind: "record_deployment";
      readonly defectId: string;
      readonly deploymentArtifactRef: string;
      readonly deployedAtMs: number;
    }
  | {
      readonly kind: "verify_fix";
      readonly defectId: string;
      readonly restoreArtifactRef: string;
      readonly replayReportArtifactRef: string;
      readonly observationArtifactRef: string;
      readonly oracleReportArtifactRef: string;
      readonly forcedFailureArtifactRef: string;
      readonly regressionGateArtifactRef: string;
      readonly verifiedAtMs: number;
    };

export type ProductionCampaignError =
  | { readonly kind: "invalid_identity"; readonly message: string }
  | { readonly kind: "invalid_campaign"; readonly message: string }
  | { readonly kind: "malformed_campaign"; readonly message: string }
  | { readonly kind: "invalid_action"; readonly message: string }
  | { readonly kind: "invalid_transition"; readonly message: string }
  | { readonly kind: "open_defect"; readonly message: string }
  | { readonly kind: "artifact_resolution"; readonly message: string }
  | { readonly kind: "artifact_mismatch"; readonly message: string };

const authenticatedIdentities = new WeakSet<object>();
const ARTIFACT_BASE_KEYS = [
  "kind",
  "artifactRef",
  "artifactDigestSha256",
  "authorityKeyIdSha256",
  "authenticationTagSha256",
] as const;
const ARTIFACT_SPECIFIC_KEYS: Record<ProductionCampaignArtifactKind, readonly string[]> = {
  bundle_manifest: ["bundleId", "manifestDigestSha256"],
  capture_episode: ["bundleId", "episodeId", "blobDigestSha256", "contentDigestSha256"],
  clean_restore: ["restoreId", "bundleId", "episodeId", "targetMachineIdSha256", "snapshotManifestDigestSha256", "stateTreeDigestSha256", "result", "completedAtMs"],
  replay_report: ["runId", "caseId", "bundleId", "episodeId", "restoreId", "targetMachineIdSha256", "runtimeDigestSha256", "inputSetDigestSha256", "engineKind", "engineReportDigestSha256", "exact", "exactBlockers", "fidelity", "result", "startedAtMs", "completedAtMs"],
  replay_observation: ["runId", "caseId", "phase", "observerMode", "observationDigestSha256", "verdict", "observedAtMs"],
  oracle_report: ["runId", "caseId", "phase", "oracleSetDigestSha256", "verdict", "evaluatedAtMs"],
  source_checkout: ["checkoutId", "treeDigestSha256", "baselineRuntimeDigestSha256", "clean", "capturedAtMs"],
  source_patch: ["patchId", "sourceCheckoutId", "baseTreeDigestSha256", "patchedTreeDigestSha256", "patchDigestSha256", "producedAtMs"],
  diagnosis: ["defectId", "replayRunId", "sourceCheckoutId", "rootCauseDigestSha256", "authoritativeLayer", "recordedAtMs"],
  regression_gate: ["gateId", "phase", "subjectId", "runtimeDigestSha256", "testPath", "commandDigestSha256", "result", "failureShapeDigestSha256", "completedAtMs"],
  patch_build: ["buildId", "sourceCheckoutId", "patchArtifactRef", "sourceTreeDigestSha256", "patchDigestSha256", "runtimeDigestSha256", "result", "builtAtMs"],
  deployment: ["deploymentId", "buildId", "targetMachineIdSha256", "runtimeDigestSha256", "result", "completedAtMs"],
  forced_failure_proof: ["runId", "deploymentId", "observerMode", "expectedFailureObserved", "logProofDigestSha256", "eventProofDigestSha256", "hintProofDigestSha256", "completedAtMs"],
};
const ARTIFACT_KINDS = new Set<string>(Object.keys(ARTIFACT_SPECIFIC_KEYS));
const FAILURE_CLASSES = new Set<string>([
  "comis_failure",
  "false_success",
  "hard_oracle_failure",
  "observability_failure",
  "replay_divergence",
]);
const CAMPAIGN_KEYS = [
  "schema", "schemaVersion", "campaignId", "captureId", "bundleId",
  "bundleManifestDigestSha256", "bundleArtifactRef", "episodeId",
  "episodeBlobDigestSha256", "episodeContentDigestSha256", "episodeArtifactRef",
  "inputSetDigestSha256", "initialSnapshotManifestDigestSha256",
  "initialStateTreeDigestSha256", "targetMachineIdSha256", "sourceRuntimeDigestSha256",
  "activeRuntimeDigestSha256", "productionObservationDigestSha256", "productionVerdict",
  "desiredObservationDigestSha256", "desiredVerdict", "oracleSetDigestSha256",
  "createdAtMs", "updatedAtMs", "status", "exactEligible", "cursor",
  "openDefectId", "cases", "defects", "evidence",
] as const;
const CASE_KEYS = [
  "caseId", "status", "replayRunId", "initialRestoreArtifactRef", "startedAtMs",
  "completedAtMs", "reproductionReplayArtifactRef", "reproductionObservationArtifactRef",
  "reproductionOracleArtifactRef", "reproductionFidelity", "reproductionCorrectness",
  "verificationRestoreArtifactRef", "verificationReplayArtifactRef",
  "verificationObservationArtifactRef", "verificationOracleArtifactRef",
  "verificationCorrectness", "defectId",
] as const;
const DEFECT_KEYS = [
  "defectId", "caseId", "status", "failureClass", "replayRunId",
  "sourceCheckoutArtifactRef", "diagnosisArtifactRef", "prePatchRegressionArtifactRef",
  "patchBuildArtifactRef", "greenRegressionArtifactRef", "deploymentArtifactRef",
  "forcedFailureArtifactRef", "deployedRegressionArtifactRef", "openedAtMs", "updatedAtMs",
] as const;
const EVIDENCE_KEYS = [
  "artifactRef", "kind", "artifactDigestSha256", "authorityKeyIdSha256",
  "authenticationTagSha256",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_LABEL.test(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableRef(value: unknown): value is string | null {
  return value === null || isRef(value);
}

function invalidIdentity(): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_identity", message: "Campaign identity is not an authenticated exact episode" });
}

function invalidCampaign(): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_campaign", message: "Campaign input is invalid" });
}

function invalidAction(): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_action", message: "Campaign action is invalid" });
}

function invalidTransition(message: string): Result<never, ProductionCampaignError> {
  return err({ kind: "invalid_transition", message });
}

function artifactMismatch(): Result<never, ProductionCampaignError> {
  return err({ kind: "artifact_mismatch", message: "Authenticated artifact does not match the required campaign evidence" });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateIdentityReconciliation(
  bundle: ProductionReplayBundleManifest,
  episode: ProductionCaptureEpisode,
): boolean {
  const checkpoint = episode.initialCheckpoint;
  const observation = episode.finalObservation;
  return (
    bundle.fidelity.exactEligible &&
    bundle.fidelity.classification === "deterministic_cassette_exact" &&
    bundle.fidelity.target === "deterministic_cassette" &&
    bundle.fidelity.gaps.length === 0 &&
    bundle.attestations.runtime.exact &&
    bundle.attestations.state.exact &&
    bundle.episode.exactEligible &&
    episode.captureMode === "prospective_window" &&
    episode.replayInput.exactEligible &&
    episode.replayInput.classification === "deterministic_cassette_exact" &&
    episode.replayInput.target === "deterministic_cassette" &&
    episode.replayInput.gaps.length === 0 &&
    checkpoint.status === "captured" &&
    checkpoint.quiescence === "verified" &&
    checkpoint.snapshotManifestDigestSha256 !== null &&
    checkpoint.stateTreeDigestSha256 !== null &&
    observation.status === "captured" &&
    observation.observerMode === "independent" &&
    observation.oracleObservationDigestSha256 === episode.correctness.production.observationDigestSha256 &&
    episode.correctness.desired.verdict === "pass" &&
    bundle.bundleId === episode.episodeId &&
    bundle.transcript.captureId === episode.episodeId &&
    bundle.episode.episodeId === episode.episodeId &&
    bundle.episode.captureMode === episode.captureMode &&
    bundle.episode.windowStartAtMs === episode.window.startAtMs &&
    bundle.episode.windowEndAtMs === episode.window.endAtMs &&
    bundle.episode.initialCheckpointSnapshotManifestDigestSha256 === checkpoint.snapshotManifestDigestSha256 &&
    bundle.episode.inputSetDigestSha256 === episode.replayInput.inputSetDigestSha256 &&
    bundle.episode.classification === episode.replayInput.classification &&
    bundle.episode.target === episode.replayInput.target &&
    bundle.attestations.state.source.treeDigestSha256 === checkpoint.stateTreeDigestSha256 &&
    bundle.expected.outputCount === observation.outputCount &&
    bundle.expected.finalStateRecordCount === observation.finalStateRecordCount &&
    bundle.expected.finalStateDigestSha256 === observation.finalStateDigestSha256
  );
}

export function parseProductionCampaignIdentity(
  input: ParseProductionCampaignIdentityInput,
): Result<ProductionCampaignIdentity, ProductionCampaignError> {
  const bundle = parseProductionReplayBundleManifest(input.bundleEnvelope, input.bundleSealKey);
  if (!bundle.ok) return invalidIdentity();
  const episode = parseProductionCaptureEpisode(input.episodeEnvelope);
  if (
    !episode.ok ||
    bundle.value.episode.contentDigestSha256 !== sha256(input.episodeEnvelope) ||
    !validateIdentityReconciliation(bundle.value, episode.value)
  ) {
    return invalidIdentity();
  }
  const checkpoint = episode.value.initialCheckpoint;
  if (
    checkpoint.snapshotManifestDigestSha256 === null ||
    checkpoint.stateTreeDigestSha256 === null
  ) {
    return invalidIdentity();
  }
  const identity: ProductionCampaignIdentity = {
    bundleId: bundle.value.bundleId,
    captureId: bundle.value.transcript.captureId,
    bundleManifestDigestSha256: bundle.value.seal.manifestDigestSha256,
    episodeId: episode.value.episodeId,
    episodeBlobDigestSha256: bundle.value.episode.blobDigestSha256,
    episodeContentDigestSha256: bundle.value.episode.contentDigestSha256,
    inputSetDigestSha256: episode.value.replayInput.inputSetDigestSha256,
    initialSnapshotManifestDigestSha256: checkpoint.snapshotManifestDigestSha256,
    initialStateTreeDigestSha256: checkpoint.stateTreeDigestSha256,
    targetMachineIdSha256: bundle.value.attestations.target.machineIdSha256,
    sourceRuntimeDigestSha256: bundle.value.attestations.runtime.source.digestSha256,
    productionObservationDigestSha256: episode.value.correctness.production.observationDigestSha256,
    productionVerdict: episode.value.correctness.production.verdict,
    desiredObservationDigestSha256: episode.value.correctness.desired.observationDigestSha256,
    desiredVerdict: episode.value.correctness.desired.verdict,
    oracleSetDigestSha256: episode.value.correctness.oracleSetDigestSha256,
  };
  const immutableIdentity = Object.freeze(identity);
  authenticatedIdentities.add(immutableIdentity);
  return ok(immutableIdentity);
}

function validateArtifact(raw: unknown): raw is ProductionCampaignArtifact {
  if (!isRecord(raw) || typeof raw.kind !== "string" || !ARTIFACT_KINDS.has(raw.kind)) return false;
  const kind = raw.kind as ProductionCampaignArtifactKind;
  // eslint-disable-next-line security/detect-object-injection -- the key is checked against the closed artifact-kind set above.
  if (!hasExactKeys(raw, [...ARTIFACT_BASE_KEYS, ...ARTIFACT_SPECIFIC_KEYS[kind]])) return false;
  if (!isRef(raw.artifactRef) || !isDigest(raw.artifactDigestSha256) || !isDigest(raw.authorityKeyIdSha256) || !isDigest(raw.authenticationTagSha256)) return false;
  switch (kind) {
    case "bundle_manifest":
      return isId(raw.bundleId) && isDigest(raw.manifestDigestSha256);
    case "capture_episode":
      return isId(raw.bundleId) && isId(raw.episodeId) && isDigest(raw.blobDigestSha256) && isDigest(raw.contentDigestSha256);
    case "clean_restore":
      return isId(raw.restoreId) && isId(raw.bundleId) && isId(raw.episodeId) && isDigest(raw.targetMachineIdSha256) && isDigest(raw.snapshotManifestDigestSha256) && isDigest(raw.stateTreeDigestSha256) && (raw.result === "exact" || raw.result === "mismatch" || raw.result === "failed") && isTime(raw.completedAtMs);
    case "replay_report":
      return isId(raw.runId) && isId(raw.caseId) && isId(raw.bundleId) && isId(raw.episodeId) && isId(raw.restoreId) && isDigest(raw.targetMachineIdSha256) && isDigest(raw.runtimeDigestSha256) && isDigest(raw.inputSetDigestSha256) && (raw.engineKind === "comis_operational" || raw.engineKind === "generic_contract") && isDigest(raw.engineReportDigestSha256) && typeof raw.exact === "boolean" && Array.isArray(raw.exactBlockers) && raw.exactBlockers.length <= MAX_EXACT_BLOCKERS && raw.exactBlockers.every((blocker) => typeof blocker === "string" && SAFE_LABEL.test(blocker)) && new Set(raw.exactBlockers).size === raw.exactBlockers.length && (raw.fidelity === "matched" || raw.fidelity === "diverged") && (raw.result === "completed" || raw.result === "failed") && isTime(raw.startedAtMs) && isTime(raw.completedAtMs) && raw.completedAtMs >= raw.startedAtMs;
    case "replay_observation":
      return isId(raw.runId) && isId(raw.caseId) && (raw.phase === "reproduction" || raw.phase === "verification") && (raw.observerMode === "independent" || raw.observerMode === "replay_driver") && isDigest(raw.observationDigestSha256) && (raw.verdict === "pass" || raw.verdict === "fail") && isTime(raw.observedAtMs);
    case "oracle_report":
      return isId(raw.runId) && isId(raw.caseId) && (raw.phase === "reproduction" || raw.phase === "verification") && isDigest(raw.oracleSetDigestSha256) && (raw.verdict === "pass" || raw.verdict === "fail") && isTime(raw.evaluatedAtMs);
    case "source_checkout":
      return isId(raw.checkoutId) && isDigest(raw.treeDigestSha256) && isDigest(raw.baselineRuntimeDigestSha256) && typeof raw.clean === "boolean" && isTime(raw.capturedAtMs);
    case "source_patch":
      return isId(raw.patchId) && isId(raw.sourceCheckoutId) && isDigest(raw.baseTreeDigestSha256) && isDigest(raw.patchedTreeDigestSha256) && isDigest(raw.patchDigestSha256) && isTime(raw.producedAtMs);
    case "diagnosis":
      return isId(raw.defectId) && isId(raw.replayRunId) && isId(raw.sourceCheckoutId) && isDigest(raw.rootCauseDigestSha256) && typeof raw.authoritativeLayer === "string" && SAFE_LABEL.test(raw.authoritativeLayer) && isTime(raw.recordedAtMs);
    case "regression_gate":
      return isId(raw.gateId) && (raw.phase === "pre_patch" || raw.phase === "post_patch" || raw.phase === "deployed") && isId(raw.subjectId) && isDigest(raw.runtimeDigestSha256) && typeof raw.testPath === "string" && SAFE_TEST_PATH.test(raw.testPath) && isDigest(raw.commandDigestSha256) && (raw.result === "pass" || raw.result === "fail") && (raw.failureShapeDigestSha256 === null || isDigest(raw.failureShapeDigestSha256)) && isTime(raw.completedAtMs) && ((raw.result === "fail") === (raw.failureShapeDigestSha256 !== null));
    case "patch_build":
      return isId(raw.buildId) && isId(raw.sourceCheckoutId) && isRef(raw.patchArtifactRef) && isDigest(raw.sourceTreeDigestSha256) && isDigest(raw.patchDigestSha256) && isDigest(raw.runtimeDigestSha256) && (raw.result === "success" || raw.result === "failed") && isTime(raw.builtAtMs);
    case "deployment":
      return isId(raw.deploymentId) && isId(raw.buildId) && isDigest(raw.targetMachineIdSha256) && isDigest(raw.runtimeDigestSha256) && (raw.result === "complete" || raw.result === "failed") && isTime(raw.completedAtMs);
    case "forced_failure_proof":
      return isId(raw.runId) && isId(raw.deploymentId) && (raw.observerMode === "independent" || raw.observerMode === "replay_driver") && typeof raw.expectedFailureObserved === "boolean" && isDigest(raw.logProofDigestSha256) && isDigest(raw.eventProofDigestSha256) && isDigest(raw.hintProofDigestSha256) && isTime(raw.completedAtMs);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function bindingOf(artifact: ProductionCampaignArtifact): ProductionCampaignEvidenceBinding {
  return {
    artifactRef: artifact.artifactRef,
    kind: artifact.kind,
    artifactDigestSha256: artifact.artifactDigestSha256,
    authorityKeyIdSha256: artifact.authorityKeyIdSha256,
    authenticationTagSha256: artifact.authenticationTagSha256,
  };
}

function equalBinding(left: ProductionCampaignEvidenceBinding, right: ProductionCampaignEvidenceBinding): boolean {
  return left.artifactRef === right.artifactRef && left.kind === right.kind && left.artifactDigestSha256 === right.artifactDigestSha256 && left.authorityKeyIdSha256 === right.authorityKeyIdSha256 && left.authenticationTagSha256 === right.authenticationTagSha256;
}

function resolveArtifact<K extends ProductionCampaignArtifactKind>(
  resolver: ProductionCampaignArtifactResolver,
  artifactRef: string,
  expectedKind: K,
): Result<Extract<ProductionCampaignArtifact, { readonly kind: K }>, ProductionCampaignError> {
  if (!isRef(artifactRef)) return invalidAction();
  const resolved = resolver.resolve(artifactRef);
  if (!resolved.ok) return err({ kind: "artifact_resolution", message: "Authenticated campaign artifact could not be resolved" });
  if (!validateArtifact(resolved.value) || resolved.value.artifactRef !== artifactRef || resolved.value.kind !== expectedKind) return artifactMismatch();
  return ok(resolved.value as Extract<ProductionCampaignArtifact, { readonly kind: K }>);
}

function appendEvidence(
  existing: readonly ProductionCampaignEvidenceBinding[],
  artifacts: readonly ProductionCampaignArtifact[],
): Result<readonly ProductionCampaignEvidenceBinding[], ProductionCampaignError> {
  const next = [...existing];
  for (const artifact of artifacts) {
    const binding = bindingOf(artifact);
    const prior = next.find((candidate) => candidate.artifactRef === binding.artifactRef);
    if (prior !== undefined && !equalBinding(prior, binding)) return artifactMismatch();
    if (prior === undefined) next.push(binding);
  }
  return next.length <= MAX_EVIDENCE ? ok(next) : invalidCampaign();
}

function reauthenticateEvidence(
  campaign: ProductionCampaign,
  resolver: ProductionCampaignArtifactResolver,
): Result<void, ProductionCampaignError> {
  for (const binding of campaign.evidence) {
    const resolved = resolveArtifact(resolver, binding.artifactRef, binding.kind);
    if (!resolved.ok) return resolved;
    if (!equalBinding(binding, bindingOf(resolved.value))) return artifactMismatch();
  }
  return ok(undefined);
}

function emptyCase(caseId: string): ProductionCampaignCase {
  return {
    caseId,
    status: "pending",
    replayRunId: null,
    initialRestoreArtifactRef: null,
    startedAtMs: null,
    completedAtMs: null,
    reproductionReplayArtifactRef: null,
    reproductionObservationArtifactRef: null,
    reproductionOracleArtifactRef: null,
    reproductionFidelity: null,
    reproductionCorrectness: null,
    verificationRestoreArtifactRef: null,
    verificationReplayArtifactRef: null,
    verificationObservationArtifactRef: null,
    verificationOracleArtifactRef: null,
    verificationCorrectness: null,
    defectId: null,
  };
}

export function createProductionCampaign(
  input: CreateProductionCampaignInput,
  resolver: ProductionCampaignArtifactResolver,
): Result<ProductionCampaign, ProductionCampaignError> {
  if (!authenticatedIdentities.has(input.identity as object)) return invalidIdentity();
  if (!isId(input.campaignId) || !isRef(input.bundleArtifactRef) || !isRef(input.episodeArtifactRef) || !isTime(input.createdAtMs) || input.caseIds.length === 0 || input.caseIds.length > MAX_CASES || input.caseIds.some((caseId) => !isId(caseId)) || new Set(input.caseIds).size !== input.caseIds.length) return invalidCampaign();
  const bundleArtifact = resolveArtifact(resolver, input.bundleArtifactRef, "bundle_manifest");
  if (!bundleArtifact.ok) return bundleArtifact;
  const episodeArtifact = resolveArtifact(resolver, input.episodeArtifactRef, "capture_episode");
  if (!episodeArtifact.ok) return episodeArtifact;
  const identity = input.identity;
  if (bundleArtifact.value.bundleId !== identity.bundleId || bundleArtifact.value.manifestDigestSha256 !== identity.bundleManifestDigestSha256 || episodeArtifact.value.bundleId !== identity.bundleId || episodeArtifact.value.episodeId !== identity.episodeId || episodeArtifact.value.blobDigestSha256 !== identity.episodeBlobDigestSha256 || episodeArtifact.value.contentDigestSha256 !== identity.episodeContentDigestSha256) return artifactMismatch();
  const evidence = appendEvidence([], [bundleArtifact.value, episodeArtifact.value]);
  if (!evidence.ok) return evidence;
  return ok({
    schema: "comis-production-replay-campaign",
    schemaVersion: 1,
    campaignId: input.campaignId,
    captureId: identity.captureId,
    bundleId: identity.bundleId,
    bundleManifestDigestSha256: identity.bundleManifestDigestSha256,
    bundleArtifactRef: input.bundleArtifactRef,
    episodeId: identity.episodeId,
    episodeBlobDigestSha256: identity.episodeBlobDigestSha256,
    episodeContentDigestSha256: identity.episodeContentDigestSha256,
    episodeArtifactRef: input.episodeArtifactRef,
    inputSetDigestSha256: identity.inputSetDigestSha256,
    initialSnapshotManifestDigestSha256: identity.initialSnapshotManifestDigestSha256,
    initialStateTreeDigestSha256: identity.initialStateTreeDigestSha256,
    targetMachineIdSha256: identity.targetMachineIdSha256,
    sourceRuntimeDigestSha256: identity.sourceRuntimeDigestSha256,
    activeRuntimeDigestSha256: identity.sourceRuntimeDigestSha256,
    productionObservationDigestSha256: identity.productionObservationDigestSha256,
    productionVerdict: identity.productionVerdict,
    desiredObservationDigestSha256: identity.desiredObservationDigestSha256,
    desiredVerdict: identity.desiredVerdict,
    oracleSetDigestSha256: identity.oracleSetDigestSha256,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.createdAtMs,
    status: "ready",
    exactEligible: true,
    cursor: 0,
    openDefectId: null,
    cases: input.caseIds.map(emptyCase),
    defects: [],
    evidence: evidence.value,
  });
}

function actionTimestamp(action: ProductionCampaignAction): number {
  switch (action.kind) {
    case "begin_case": return action.startedAtMs;
    case "record_reproduction": return action.completedAtMs;
    case "record_deployment": return action.deployedAtMs;
    case "verify_fix": return action.verifiedAtMs;
    case "record_diagnosis":
    case "record_green": return action.recordedAtMs;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function validateActionShape(action: unknown): action is ProductionCampaignAction {
  if (!isRecord(action) || typeof action.kind !== "string") return false;
  switch (action.kind) {
    case "begin_case":
      return hasExactKeys(action, ["kind", "caseId", "replayRunId", "restoreArtifactRef", "startedAtMs"]) && isId(action.caseId) && isId(action.replayRunId) && isRef(action.restoreArtifactRef) && isTime(action.startedAtMs);
    case "record_reproduction":
      return hasExactKeys(action, ["kind", "caseId", "defectId", "failureClass", "replayReportArtifactRef", "observationArtifactRef", "oracleReportArtifactRef", "completedAtMs"]) && isId(action.caseId) && (action.defectId === null || isId(action.defectId)) && (action.failureClass === null || (typeof action.failureClass === "string" && FAILURE_CLASSES.has(action.failureClass))) && isRef(action.replayReportArtifactRef) && isRef(action.observationArtifactRef) && isRef(action.oracleReportArtifactRef) && isTime(action.completedAtMs);
    case "record_diagnosis":
      return hasExactKeys(action, ["kind", "defectId", "sourceCheckoutArtifactRef", "diagnosisArtifactRef", "prePatchRegressionArtifactRef", "recordedAtMs"]) && isId(action.defectId) && isRef(action.sourceCheckoutArtifactRef) && isRef(action.diagnosisArtifactRef) && isRef(action.prePatchRegressionArtifactRef) && isTime(action.recordedAtMs);
    case "record_green":
      return hasExactKeys(action, ["kind", "defectId", "patchBuildArtifactRef", "regressionGateArtifactRef", "recordedAtMs"]) && isId(action.defectId) && isRef(action.patchBuildArtifactRef) && isRef(action.regressionGateArtifactRef) && isTime(action.recordedAtMs);
    case "record_deployment":
      return hasExactKeys(action, ["kind", "defectId", "deploymentArtifactRef", "deployedAtMs"]) && isId(action.defectId) && isRef(action.deploymentArtifactRef) && isTime(action.deployedAtMs);
    case "verify_fix":
      return hasExactKeys(action, ["kind", "defectId", "restoreArtifactRef", "replayReportArtifactRef", "observationArtifactRef", "oracleReportArtifactRef", "forcedFailureArtifactRef", "regressionGateArtifactRef", "verifiedAtMs"]) && isId(action.defectId) && isRef(action.restoreArtifactRef) && isRef(action.replayReportArtifactRef) && isRef(action.observationArtifactRef) && isRef(action.oracleReportArtifactRef) && isRef(action.forcedFailureArtifactRef) && isRef(action.regressionGateArtifactRef) && isTime(action.verifiedAtMs);
    default:
      return false;
  }
}

function replaceCase(campaign: ProductionCampaign, index: number, replacement: ProductionCampaignCase, timestamp: number, evidence: readonly ProductionCampaignEvidenceBinding[], runtimeDigest = campaign.activeRuntimeDigestSha256): ProductionCampaign {
  const cases = campaign.cases.map((candidate, candidateIndex) => candidateIndex === index ? replacement : candidate);
  const terminal = replacement.status === "passed" || replacement.status === "passed_after_fix";
  const cursor = terminal && index === campaign.cursor ? campaign.cursor + 1 : campaign.cursor;
  return { ...campaign, cases, cursor, evidence, activeRuntimeDigestSha256: runtimeDigest, updatedAtMs: timestamp, status: cursor === cases.length ? "completed" : "running" };
}

function replaceDefect(campaign: ProductionCampaign, index: number, replacement: ProductionCampaignDefect, timestamp: number, evidence: readonly ProductionCampaignEvidenceBinding[]): ProductionCampaign {
  return { ...campaign, defects: campaign.defects.map((candidate, candidateIndex) => candidateIndex === index ? replacement : candidate), evidence, updatedAtMs: timestamp, status: "running" };
}

function openDefect(campaign: ProductionCampaign, defectId: string): { index: number; defect: ProductionCampaignDefect } | null {
  if (campaign.openDefectId !== defectId) return null;
  const index = campaign.defects.findIndex((candidate) => candidate.defectId === defectId);
  const defect = campaign.defects.at(index);
  return defect === undefined ? null : { index, defect };
}

function validateRestore(campaign: ProductionCampaign, artifact: ProductionCampaignRestoreArtifact): boolean {
  return artifact.bundleId === campaign.bundleId && artifact.episodeId === campaign.episodeId && artifact.targetMachineIdSha256 === campaign.targetMachineIdSha256 && artifact.snapshotManifestDigestSha256 === campaign.initialSnapshotManifestDigestSha256 && artifact.stateTreeDigestSha256 === campaign.initialStateTreeDigestSha256 && artifact.result === "exact";
}

function isOperationalExactReplay(artifact: ProductionCampaignReplayArtifact): boolean {
  return artifact.engineKind === "comis_operational" && artifact.exact && artifact.exactBlockers.length === 0;
}

export function advanceProductionCampaign(
  campaign: ProductionCampaign,
  rawAction: ProductionCampaignAction,
  resolver: ProductionCampaignArtifactResolver,
): Result<ProductionCampaign, ProductionCampaignError> {
  const validCampaign = validateCampaign(campaign);
  if (!validCampaign.ok) return validCampaign;
  const authenticated = reauthenticateEvidence(campaign, resolver);
  if (!authenticated.ok) return authenticated;
  if (!validateActionShape(rawAction)) return invalidAction();
  const action = rawAction;
  const timestamp = actionTimestamp(action);
  if (timestamp < campaign.updatedAtMs) return invalidAction();

  if (action.kind === "begin_case") {
    if (campaign.openDefectId !== null) return err({ kind: "open_defect", message: "The open defect must be closed before another replay case begins" });
    const index = campaign.cursor;
    const item = campaign.cases.at(index);
    if (item === undefined || item.caseId !== action.caseId || item.status !== "pending") return invalidTransition("Only the next pending replay case may begin");
    const restore = resolveArtifact(resolver, action.restoreArtifactRef, "clean_restore");
    if (!restore.ok) return restore;
    if (!validateRestore(campaign, restore.value) || restore.value.completedAtMs > timestamp) return artifactMismatch();
    const evidence = appendEvidence(campaign.evidence, [restore.value]);
    if (!evidence.ok) return evidence;
    return ok(replaceCase(campaign, index, { ...item, status: "running", replayRunId: action.replayRunId, initialRestoreArtifactRef: restore.value.artifactRef, startedAtMs: timestamp }, timestamp, evidence.value));
  }

  if (action.kind === "record_reproduction") {
    const index = campaign.cursor;
    const item = campaign.cases.at(index);
    if (item === undefined || item.caseId !== action.caseId || item.status !== "running" || item.replayRunId === null || item.initialRestoreArtifactRef === null) return invalidTransition("Only the running replay case may record reproduction evidence");
    const restore = resolveArtifact(resolver, item.initialRestoreArtifactRef, "clean_restore");
    if (!restore.ok) return restore;
    const replay = resolveArtifact(resolver, action.replayReportArtifactRef, "replay_report");
    if (!replay.ok) return replay;
    const observation = resolveArtifact(resolver, action.observationArtifactRef, "replay_observation");
    if (!observation.ok) return observation;
    const oracle = resolveArtifact(resolver, action.oracleReportArtifactRef, "oracle_report");
    if (!oracle.ok) return oracle;
    const linkedReplay = isOperationalExactReplay(replay.value) && replay.value.runId === item.replayRunId && replay.value.caseId === item.caseId && replay.value.bundleId === campaign.bundleId && replay.value.episodeId === campaign.episodeId && replay.value.restoreId === restore.value.restoreId && replay.value.targetMachineIdSha256 === campaign.targetMachineIdSha256 && replay.value.runtimeDigestSha256 === campaign.activeRuntimeDigestSha256 && replay.value.inputSetDigestSha256 === campaign.inputSetDigestSha256 && replay.value.fidelity === "matched" && replay.value.result === "completed" && replay.value.startedAtMs >= restore.value.completedAtMs && replay.value.completedAtMs <= timestamp;
    const linkedObservation = observation.value.runId === item.replayRunId && observation.value.caseId === item.caseId && observation.value.phase === "reproduction" && observation.value.observerMode === "independent" && observation.value.observedAtMs >= replay.value.completedAtMs && observation.value.observedAtMs <= timestamp;
    const linkedOracle = oracle.value.runId === item.replayRunId && oracle.value.caseId === item.caseId && oracle.value.phase === "reproduction" && oracle.value.oracleSetDigestSha256 === campaign.oracleSetDigestSha256 && oracle.value.evaluatedAtMs >= observation.value.observedAtMs && oracle.value.evaluatedAtMs <= timestamp;
    if (!linkedReplay || !linkedObservation || !linkedOracle) return artifactMismatch();
    const evidence = appendEvidence(campaign.evidence, [replay.value, observation.value, oracle.value]);
    if (!evidence.ok) return evidence;
    if (oracle.value.verdict === "pass") {
      if (action.defectId !== null || action.failureClass !== null || observation.value.observationDigestSha256 !== campaign.desiredObservationDigestSha256 || observation.value.verdict !== campaign.desiredVerdict) return artifactMismatch();
      return ok(replaceCase(campaign, index, { ...item, status: "passed", completedAtMs: timestamp, reproductionReplayArtifactRef: replay.value.artifactRef, reproductionObservationArtifactRef: observation.value.artifactRef, reproductionOracleArtifactRef: oracle.value.artifactRef, reproductionFidelity: "matched", reproductionCorrectness: "desired_passed" }, timestamp, evidence.value));
    }
    if (action.defectId === null || action.failureClass === null || campaign.defects.some((candidate) => candidate.defectId === action.defectId) || observation.value.observationDigestSha256 !== campaign.productionObservationDigestSha256 || observation.value.verdict !== campaign.productionVerdict) return artifactMismatch();
    const defect: ProductionCampaignDefect = { defectId: action.defectId, caseId: item.caseId, status: "red_reproduced", failureClass: action.failureClass, replayRunId: item.replayRunId, sourceCheckoutArtifactRef: null, diagnosisArtifactRef: null, prePatchRegressionArtifactRef: null, patchBuildArtifactRef: null, greenRegressionArtifactRef: null, deploymentArtifactRef: null, forcedFailureArtifactRef: null, deployedRegressionArtifactRef: null, openedAtMs: timestamp, updatedAtMs: timestamp };
    return ok({ ...campaign, cases: campaign.cases.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, defectId: action.defectId, reproductionReplayArtifactRef: replay.value.artifactRef, reproductionObservationArtifactRef: observation.value.artifactRef, reproductionOracleArtifactRef: oracle.value.artifactRef, reproductionFidelity: "matched", reproductionCorrectness: "red_reproduced" } : candidate), defects: [...campaign.defects, defect], openDefectId: action.defectId, evidence: evidence.value, updatedAtMs: timestamp, status: "running" });
  }

  const selected = openDefect(campaign, action.defectId);
  if (selected === null) return invalidTransition("Action does not target the single open defect");
  const { index: defectIndex, defect } = selected;

  if (action.kind === "record_diagnosis") {
    if (defect.status !== "red_reproduced") return invalidTransition("Diagnosis requires faithfully reproduced RED evidence");
    const checkout = resolveArtifact(resolver, action.sourceCheckoutArtifactRef, "source_checkout");
    if (!checkout.ok) return checkout;
    const diagnosis = resolveArtifact(resolver, action.diagnosisArtifactRef, "diagnosis");
    if (!diagnosis.ok) return diagnosis;
    const regression = resolveArtifact(resolver, action.prePatchRegressionArtifactRef, "regression_gate");
    if (!regression.ok) return regression;
    if (!checkout.value.clean || checkout.value.baselineRuntimeDigestSha256 !== campaign.activeRuntimeDigestSha256 || checkout.value.capturedAtMs > timestamp || diagnosis.value.defectId !== defect.defectId || diagnosis.value.replayRunId !== defect.replayRunId || diagnosis.value.sourceCheckoutId !== checkout.value.checkoutId || diagnosis.value.recordedAtMs > timestamp || regression.value.phase !== "pre_patch" || regression.value.subjectId !== checkout.value.checkoutId || regression.value.runtimeDigestSha256 !== campaign.activeRuntimeDigestSha256 || regression.value.result !== "fail" || regression.value.failureShapeDigestSha256 === null || regression.value.completedAtMs > timestamp) return artifactMismatch();
    const evidence = appendEvidence(campaign.evidence, [checkout.value, diagnosis.value, regression.value]);
    if (!evidence.ok) return evidence;
    return ok(replaceDefect(campaign, defectIndex, { ...defect, status: "diagnosed", sourceCheckoutArtifactRef: checkout.value.artifactRef, diagnosisArtifactRef: diagnosis.value.artifactRef, prePatchRegressionArtifactRef: regression.value.artifactRef, updatedAtMs: timestamp }, timestamp, evidence.value));
  }

  if (action.kind === "record_green") {
    if (defect.status !== "diagnosed" || defect.sourceCheckoutArtifactRef === null || defect.prePatchRegressionArtifactRef === null) return invalidTransition("GREEN requires diagnosed RED evidence");
    const checkout = resolveArtifact(resolver, defect.sourceCheckoutArtifactRef, "source_checkout");
    if (!checkout.ok) return checkout;
    const redGate = resolveArtifact(resolver, defect.prePatchRegressionArtifactRef, "regression_gate");
    if (!redGate.ok) return redGate;
    const build = resolveArtifact(resolver, action.patchBuildArtifactRef, "patch_build");
    if (!build.ok) return build;
    const patch = resolveArtifact(resolver, build.value.patchArtifactRef, "source_patch");
    if (!patch.ok) return patch;
    const gate = resolveArtifact(resolver, action.regressionGateArtifactRef, "regression_gate");
    if (!gate.ok) return gate;
    if (patch.value.sourceCheckoutId !== checkout.value.checkoutId || patch.value.baseTreeDigestSha256 !== checkout.value.treeDigestSha256 || patch.value.patchedTreeDigestSha256 === patch.value.baseTreeDigestSha256 || patch.value.producedAtMs < checkout.value.capturedAtMs || patch.value.producedAtMs > build.value.builtAtMs || build.value.sourceCheckoutId !== checkout.value.checkoutId || build.value.patchArtifactRef !== patch.value.artifactRef || build.value.patchDigestSha256 !== patch.value.patchDigestSha256 || build.value.sourceTreeDigestSha256 !== patch.value.patchedTreeDigestSha256 || build.value.result !== "success" || build.value.builtAtMs > timestamp || gate.value.phase !== "post_patch" || gate.value.subjectId !== build.value.buildId || gate.value.runtimeDigestSha256 !== build.value.runtimeDigestSha256 || gate.value.testPath !== redGate.value.testPath || gate.value.commandDigestSha256 !== redGate.value.commandDigestSha256 || gate.value.result !== "pass" || gate.value.failureShapeDigestSha256 !== null || gate.value.completedAtMs < build.value.builtAtMs || gate.value.completedAtMs > timestamp) return artifactMismatch();
    const evidence = appendEvidence(campaign.evidence, [patch.value, build.value, gate.value]);
    if (!evidence.ok) return evidence;
    return ok(replaceDefect(campaign, defectIndex, { ...defect, status: "green_built", patchBuildArtifactRef: build.value.artifactRef, greenRegressionArtifactRef: gate.value.artifactRef, updatedAtMs: timestamp }, timestamp, evidence.value));
  }

  if (action.kind === "record_deployment") {
    if (defect.status !== "green_built" || defect.patchBuildArtifactRef === null || defect.greenRegressionArtifactRef === null) return invalidTransition("Deployment requires a GREEN build and regression gate");
    const build = resolveArtifact(resolver, defect.patchBuildArtifactRef, "patch_build");
    if (!build.ok) return build;
    const gate = resolveArtifact(resolver, defect.greenRegressionArtifactRef, "regression_gate");
    if (!gate.ok) return gate;
    const deployment = resolveArtifact(resolver, action.deploymentArtifactRef, "deployment");
    if (!deployment.ok) return deployment;
    if (deployment.value.buildId !== build.value.buildId || deployment.value.targetMachineIdSha256 !== campaign.targetMachineIdSha256 || deployment.value.runtimeDigestSha256 !== build.value.runtimeDigestSha256 || deployment.value.result !== "complete" || deployment.value.completedAtMs < gate.value.completedAtMs || deployment.value.completedAtMs > timestamp) return artifactMismatch();
    const evidence = appendEvidence(campaign.evidence, [deployment.value]);
    if (!evidence.ok) return evidence;
    return ok(replaceDefect(campaign, defectIndex, { ...defect, status: "deployed", deploymentArtifactRef: deployment.value.artifactRef, updatedAtMs: timestamp }, timestamp, evidence.value));
  }

  if (action.kind === "verify_fix") {
    if (defect.status !== "deployed" || defect.deploymentArtifactRef === null || defect.greenRegressionArtifactRef === null) return invalidTransition("Verification requires a deployed GREEN build");
    const deployment = resolveArtifact(resolver, defect.deploymentArtifactRef, "deployment");
    if (!deployment.ok) return deployment;
    const greenGate = resolveArtifact(resolver, defect.greenRegressionArtifactRef, "regression_gate");
    if (!greenGate.ok) return greenGate;
    const restore = resolveArtifact(resolver, action.restoreArtifactRef, "clean_restore");
    if (!restore.ok) return restore;
    const replay = resolveArtifact(resolver, action.replayReportArtifactRef, "replay_report");
    if (!replay.ok) return replay;
    const observation = resolveArtifact(resolver, action.observationArtifactRef, "replay_observation");
    if (!observation.ok) return observation;
    const oracle = resolveArtifact(resolver, action.oracleReportArtifactRef, "oracle_report");
    if (!oracle.ok) return oracle;
    const forced = resolveArtifact(resolver, action.forcedFailureArtifactRef, "forced_failure_proof");
    if (!forced.ok) return forced;
    const regression = resolveArtifact(resolver, action.regressionGateArtifactRef, "regression_gate");
    if (!regression.ok) return regression;
    const caseIndex = campaign.cases.findIndex((candidate) => candidate.caseId === defect.caseId);
    const item = campaign.cases.at(caseIndex);
    if (item === undefined) return invalidCampaign();
    const valid = validateRestore(campaign, restore.value) && restore.value.completedAtMs >= deployment.value.completedAtMs && restore.value.completedAtMs <= timestamp && isOperationalExactReplay(replay.value) && replay.value.runId !== defect.replayRunId && replay.value.caseId === defect.caseId && replay.value.bundleId === campaign.bundleId && replay.value.episodeId === campaign.episodeId && replay.value.restoreId === restore.value.restoreId && replay.value.targetMachineIdSha256 === campaign.targetMachineIdSha256 && replay.value.runtimeDigestSha256 === deployment.value.runtimeDigestSha256 && replay.value.inputSetDigestSha256 === campaign.inputSetDigestSha256 && replay.value.fidelity === "matched" && replay.value.result === "completed" && replay.value.startedAtMs >= restore.value.completedAtMs && replay.value.completedAtMs <= timestamp && observation.value.runId === replay.value.runId && observation.value.caseId === defect.caseId && observation.value.phase === "verification" && observation.value.observerMode === "independent" && observation.value.observationDigestSha256 === campaign.desiredObservationDigestSha256 && observation.value.verdict === campaign.desiredVerdict && observation.value.observedAtMs >= replay.value.completedAtMs && observation.value.observedAtMs <= timestamp && oracle.value.runId === replay.value.runId && oracle.value.caseId === defect.caseId && oracle.value.phase === "verification" && oracle.value.oracleSetDigestSha256 === campaign.oracleSetDigestSha256 && oracle.value.verdict === "pass" && oracle.value.evaluatedAtMs >= observation.value.observedAtMs && oracle.value.evaluatedAtMs <= timestamp && forced.value.runId === replay.value.runId && forced.value.deploymentId === deployment.value.deploymentId && forced.value.observerMode === "independent" && forced.value.expectedFailureObserved && new Set([forced.value.logProofDigestSha256, forced.value.eventProofDigestSha256, forced.value.hintProofDigestSha256]).size === 3 && forced.value.completedAtMs >= oracle.value.evaluatedAtMs && forced.value.completedAtMs <= timestamp && regression.value.phase === "deployed" && regression.value.subjectId === deployment.value.deploymentId && regression.value.runtimeDigestSha256 === deployment.value.runtimeDigestSha256 && regression.value.testPath === greenGate.value.testPath && regression.value.commandDigestSha256 === greenGate.value.commandDigestSha256 && regression.value.result === "pass" && regression.value.failureShapeDigestSha256 === null && regression.value.completedAtMs >= deployment.value.completedAtMs && regression.value.completedAtMs <= timestamp;
    if (!valid) return artifactMismatch();
    const evidence = appendEvidence(campaign.evidence, [restore.value, replay.value, observation.value, oracle.value, forced.value, regression.value]);
    if (!evidence.ok) return evidence;
    const verified = replaceDefect(campaign, defectIndex, { ...defect, status: "verified", forcedFailureArtifactRef: forced.value.artifactRef, deployedRegressionArtifactRef: regression.value.artifactRef, updatedAtMs: timestamp }, timestamp, evidence.value);
    return ok(replaceCase({ ...verified, openDefectId: null }, caseIndex, { ...item, status: "passed_after_fix", replayRunId: replay.value.runId, completedAtMs: timestamp, verificationRestoreArtifactRef: restore.value.artifactRef, verificationReplayArtifactRef: replay.value.artifactRef, verificationObservationArtifactRef: observation.value.artifactRef, verificationOracleArtifactRef: oracle.value.artifactRef, verificationCorrectness: "green_verified" }, timestamp, evidence.value, deployment.value.runtimeDigestSha256));
  }

  const exhaustive: never = action;
  return exhaustive;
}

function validateEvidence(raw: unknown): raw is ProductionCampaignEvidenceBinding {
  return isRecord(raw) && hasExactKeys(raw, EVIDENCE_KEYS) && isRef(raw.artifactRef) && typeof raw.kind === "string" && ARTIFACT_KINDS.has(raw.kind) && isDigest(raw.artifactDigestSha256) && isDigest(raw.authorityKeyIdSha256) && isDigest(raw.authenticationTagSha256);
}

function validateCase(raw: unknown): raw is ProductionCampaignCase {
  if (!isRecord(raw) || !hasExactKeys(raw, CASE_KEYS)) return false;
  if (!isId(raw.caseId) || (raw.status !== "pending" && raw.status !== "running" && raw.status !== "passed" && raw.status !== "passed_after_fix") || (raw.replayRunId !== null && !isId(raw.replayRunId)) || !nullableRef(raw.initialRestoreArtifactRef) || (raw.startedAtMs !== null && !isTime(raw.startedAtMs)) || (raw.completedAtMs !== null && !isTime(raw.completedAtMs)) || !nullableRef(raw.reproductionReplayArtifactRef) || !nullableRef(raw.reproductionObservationArtifactRef) || !nullableRef(raw.reproductionOracleArtifactRef) || (raw.reproductionFidelity !== null && raw.reproductionFidelity !== "matched") || (raw.reproductionCorrectness !== null && raw.reproductionCorrectness !== "red_reproduced" && raw.reproductionCorrectness !== "desired_passed") || !nullableRef(raw.verificationRestoreArtifactRef) || !nullableRef(raw.verificationReplayArtifactRef) || !nullableRef(raw.verificationObservationArtifactRef) || !nullableRef(raw.verificationOracleArtifactRef) || (raw.verificationCorrectness !== null && raw.verificationCorrectness !== "green_verified") || (raw.defectId !== null && !isId(raw.defectId))) return false;

  const reproductionComplete = raw.reproductionReplayArtifactRef !== null && raw.reproductionObservationArtifactRef !== null && raw.reproductionOracleArtifactRef !== null && raw.reproductionFidelity === "matched";
  const reproductionAbsent = raw.reproductionReplayArtifactRef === null && raw.reproductionObservationArtifactRef === null && raw.reproductionOracleArtifactRef === null && raw.reproductionFidelity === null && raw.reproductionCorrectness === null;
  const verificationComplete = raw.verificationRestoreArtifactRef !== null && raw.verificationReplayArtifactRef !== null && raw.verificationObservationArtifactRef !== null && raw.verificationOracleArtifactRef !== null && raw.verificationCorrectness === "green_verified";
  const verificationAbsent = raw.verificationRestoreArtifactRef === null && raw.verificationReplayArtifactRef === null && raw.verificationObservationArtifactRef === null && raw.verificationOracleArtifactRef === null && raw.verificationCorrectness === null;
  const started = raw.replayRunId !== null && raw.initialRestoreArtifactRef !== null && raw.startedAtMs !== null;
  const completedAfterStart = raw.completedAtMs !== null && raw.startedAtMs !== null && raw.completedAtMs >= raw.startedAtMs;

  switch (raw.status) {
    case "pending":
      return !started && raw.replayRunId === null && raw.initialRestoreArtifactRef === null && raw.startedAtMs === null && raw.completedAtMs === null && reproductionAbsent && verificationAbsent && raw.defectId === null;
    case "running":
      return started && raw.completedAtMs === null && verificationAbsent && (reproductionAbsent ? raw.defectId === null : reproductionComplete && raw.reproductionCorrectness === "red_reproduced" && raw.defectId !== null);
    case "passed":
      return started && completedAfterStart && reproductionComplete && raw.reproductionCorrectness === "desired_passed" && verificationAbsent && raw.defectId === null;
    case "passed_after_fix":
      return started && completedAfterStart && reproductionComplete && raw.reproductionCorrectness === "red_reproduced" && verificationComplete && raw.defectId !== null;
    default: {
      const exhaustive: never = raw.status;
      return exhaustive;
    }
  }
}

function validateDefect(raw: unknown): raw is ProductionCampaignDefect {
  if (!isRecord(raw) || !hasExactKeys(raw, DEFECT_KEYS)) return false;
  if (!isId(raw.defectId) || !isId(raw.caseId) || (raw.status !== "red_reproduced" && raw.status !== "diagnosed" && raw.status !== "green_built" && raw.status !== "deployed" && raw.status !== "verified") || typeof raw.failureClass !== "string" || !FAILURE_CLASSES.has(raw.failureClass) || !isId(raw.replayRunId) || !nullableRef(raw.sourceCheckoutArtifactRef) || !nullableRef(raw.diagnosisArtifactRef) || !nullableRef(raw.prePatchRegressionArtifactRef) || !nullableRef(raw.patchBuildArtifactRef) || !nullableRef(raw.greenRegressionArtifactRef) || !nullableRef(raw.deploymentArtifactRef) || !nullableRef(raw.forcedFailureArtifactRef) || !nullableRef(raw.deployedRegressionArtifactRef) || !isTime(raw.openedAtMs) || !isTime(raw.updatedAtMs) || raw.updatedAtMs < raw.openedAtMs) return false;
  const diagnosisComplete = raw.sourceCheckoutArtifactRef !== null && raw.diagnosisArtifactRef !== null && raw.prePatchRegressionArtifactRef !== null;
  const diagnosisAbsent = raw.sourceCheckoutArtifactRef === null && raw.diagnosisArtifactRef === null && raw.prePatchRegressionArtifactRef === null;
  const greenComplete = raw.patchBuildArtifactRef !== null && raw.greenRegressionArtifactRef !== null;
  const greenAbsent = raw.patchBuildArtifactRef === null && raw.greenRegressionArtifactRef === null;
  const verificationComplete = raw.forcedFailureArtifactRef !== null && raw.deployedRegressionArtifactRef !== null;
  const verificationAbsent = raw.forcedFailureArtifactRef === null && raw.deployedRegressionArtifactRef === null;
  switch (raw.status) {
    case "red_reproduced": return diagnosisAbsent && greenAbsent && raw.deploymentArtifactRef === null && verificationAbsent;
    case "diagnosed": return diagnosisComplete && greenAbsent && raw.deploymentArtifactRef === null && verificationAbsent;
    case "green_built": return diagnosisComplete && greenComplete && raw.deploymentArtifactRef === null && verificationAbsent;
    case "deployed": return diagnosisComplete && greenComplete && raw.deploymentArtifactRef !== null && verificationAbsent;
    case "verified": return diagnosisComplete && greenComplete && raw.deploymentArtifactRef !== null && verificationComplete;
    default: {
      const exhaustive: never = raw.status;
      return exhaustive;
    }
  }
}

function referenceHasKind(campaign: ProductionCampaign, reference: string | null, kind: ProductionCampaignArtifactKind): boolean {
  return reference === null || campaign.evidence.some((binding) => binding.artifactRef === reference && binding.kind === kind);
}

function validateCampaign(raw: unknown): Result<ProductionCampaign, ProductionCampaignError> {
  if (!isRecord(raw) || !hasExactKeys(raw, CAMPAIGN_KEYS)) return err({ kind: "malformed_campaign", message: "Campaign shape is not strict" });
  if (raw.schema !== "comis-production-replay-campaign" || raw.schemaVersion !== 1 || !isId(raw.campaignId) || !isId(raw.captureId) || !isId(raw.bundleId) || !isDigest(raw.bundleManifestDigestSha256) || !isRef(raw.bundleArtifactRef) || !isId(raw.episodeId) || !isDigest(raw.episodeBlobDigestSha256) || !isDigest(raw.episodeContentDigestSha256) || !isRef(raw.episodeArtifactRef) || !isDigest(raw.inputSetDigestSha256) || !isDigest(raw.initialSnapshotManifestDigestSha256) || !isDigest(raw.initialStateTreeDigestSha256) || !isDigest(raw.targetMachineIdSha256) || !isDigest(raw.sourceRuntimeDigestSha256) || !isDigest(raw.activeRuntimeDigestSha256) || !isDigest(raw.productionObservationDigestSha256) || (raw.productionVerdict !== "pass" && raw.productionVerdict !== "fail") || !isDigest(raw.desiredObservationDigestSha256) || raw.desiredVerdict !== "pass" || !isDigest(raw.oracleSetDigestSha256) || !isTime(raw.createdAtMs) || !isTime(raw.updatedAtMs) || raw.updatedAtMs < raw.createdAtMs || (raw.status !== "ready" && raw.status !== "running" && raw.status !== "completed") || raw.exactEligible !== true || !Number.isSafeInteger(raw.cursor) || (raw.cursor as number) < 0 || (raw.openDefectId !== null && !isId(raw.openDefectId)) || !Array.isArray(raw.cases) || raw.cases.length === 0 || raw.cases.length > MAX_CASES || !raw.cases.every(validateCase) || !Array.isArray(raw.defects) || !raw.defects.every(validateDefect) || !Array.isArray(raw.evidence) || raw.evidence.length < 2 || raw.evidence.length > MAX_EVIDENCE || !raw.evidence.every(validateEvidence)) return err({ kind: "malformed_campaign", message: "Campaign fields are invalid" });
  const campaign = raw as unknown as ProductionCampaign;
  const open = campaign.defects.filter((defect) => defect.status !== "verified");
  if (campaign.cursor > campaign.cases.length || new Set(campaign.cases.map((item) => item.caseId)).size !== campaign.cases.length || new Set(campaign.defects.map((item) => item.defectId)).size !== campaign.defects.length || new Set(campaign.evidence.map((item) => item.artifactRef)).size !== campaign.evidence.length || campaign.cases.slice(0, campaign.cursor).some((item) => item.status !== "passed" && item.status !== "passed_after_fix") || campaign.cases.slice(campaign.cursor + 1).some((item) => item.status !== "pending") || open.length > 1 || (open.length === 0) !== (campaign.openDefectId === null) || (open.length === 1 && open[0]?.defectId !== campaign.openDefectId) || (campaign.status === "ready" && (campaign.cursor !== 0 || campaign.updatedAtMs !== campaign.createdAtMs)) || (campaign.status === "completed") !== (campaign.cursor === campaign.cases.length) || !referenceHasKind(campaign, campaign.bundleArtifactRef, "bundle_manifest") || !referenceHasKind(campaign, campaign.episodeArtifactRef, "capture_episode") || campaign.cases.some((item) => !referenceHasKind(campaign, item.initialRestoreArtifactRef, "clean_restore") || !referenceHasKind(campaign, item.reproductionReplayArtifactRef, "replay_report") || !referenceHasKind(campaign, item.reproductionObservationArtifactRef, "replay_observation") || !referenceHasKind(campaign, item.reproductionOracleArtifactRef, "oracle_report") || !referenceHasKind(campaign, item.verificationRestoreArtifactRef, "clean_restore") || !referenceHasKind(campaign, item.verificationReplayArtifactRef, "replay_report") || !referenceHasKind(campaign, item.verificationObservationArtifactRef, "replay_observation") || !referenceHasKind(campaign, item.verificationOracleArtifactRef, "oracle_report")) || campaign.defects.some((defect) => !campaign.cases.some((item) => item.caseId === defect.caseId && item.defectId === defect.defectId) || !referenceHasKind(campaign, defect.sourceCheckoutArtifactRef, "source_checkout") || !referenceHasKind(campaign, defect.diagnosisArtifactRef, "diagnosis") || !referenceHasKind(campaign, defect.prePatchRegressionArtifactRef, "regression_gate") || !referenceHasKind(campaign, defect.patchBuildArtifactRef, "patch_build") || !referenceHasKind(campaign, defect.greenRegressionArtifactRef, "regression_gate") || !referenceHasKind(campaign, defect.deploymentArtifactRef, "deployment") || !referenceHasKind(campaign, defect.forcedFailureArtifactRef, "forced_failure_proof") || !referenceHasKind(campaign, defect.deployedRegressionArtifactRef, "regression_gate"))) return err({ kind: "malformed_campaign", message: "Campaign state invariants are invalid" });
  return ok(campaign);
}

export function serializeProductionCampaign(campaign: ProductionCampaign): Result<string, ProductionCampaignError> {
  const valid = validateCampaign(campaign);
  if (!valid.ok) return valid;
  const encoded = tryCatch(() => JSON.stringify(valid.value));
  return encoded.ok ? ok(encoded.value) : err({ kind: "malformed_campaign", message: "Campaign could not be serialized" });
}

export function parseProductionCampaign(raw: string): Result<ProductionCampaign, ProductionCampaignError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_CAMPAIGN_BYTES || raw.includes("\0") || raw.includes("\r")) return err({ kind: "malformed_campaign", message: "Campaign envelope is invalid" });
  const parsed = tryCatch(() => JSON.parse(raw) as unknown);
  if (!parsed.ok) return err({ kind: "malformed_campaign", message: "Campaign is not valid JSON" });
  return validateCampaign(parsed.value);
}
