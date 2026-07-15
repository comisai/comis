// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { err, ok } from "@comis/shared";
import { describe, expect, it } from "vitest";

import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  formatProductionReplayBundleManifest,
  sealProductionReplayBundleManifest,
  type ProductionReplayBundleUnsignedManifest,
  type ReplayBundleBlob,
  type ReplayCassette,
} from "./production-bundle.js";
import {
  CASSETTE_COVERAGE_KINDS,
  DETERMINISTIC_INPUT_KINDS,
  formatProductionCaptureEpisode,
  type ProductionCaptureEpisode,
} from "./production-episode.js";
import { TRANSCRIPT_EXACT_SOURCE_KINDS } from "./production-transcript.js";
import {
  advanceProductionCampaign,
  createProductionCampaign,
  parseProductionCampaign,
  parseProductionCampaignIdentity,
  serializeProductionCampaign,
  type ProductionCampaign,
  type ProductionCampaignAction,
  type ProductionCampaignArtifact,
  type ProductionCampaignArtifactResolver,
  type ProductionCampaignIdentity,
} from "./production-campaign.js";

const SEAL_KEY = Buffer.alloc(32, 7);
const T0 = 1_752_560_000_000;

function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function makeEpisode(): ProductionCaptureEpisode {
  return {
    schema: "comis-production-capture-episode",
    schemaVersion: 1,
    episodeId: "episode-a",
    captureMode: "prospective_window",
    window: {
      startAtMs: T0,
      endAtMs: T0 + 60_000,
      startBoundaryDigestSha256: digest(31),
      endBoundaryDigestSha256: digest(32),
      boundaryLedgerDigestSha256: digest(33),
      captureControllerIdentityDigestSha256: digest(34),
    },
    initialCheckpoint: {
      status: "captured",
      phase: "pre_window",
      capturedAtMs: T0 - 1_000,
      quiescence: "verified",
      quiescenceAttestationDigestSha256: digest(35),
      snapshotManifestDigestSha256: digest(5),
      stateTreeDigestSha256: digest(6),
      entryCount: 2_100,
      bytes: 301_000_000,
    },
    sourceAuthorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind, index) => ({
      kind,
      sourceIdDigestSha256: digest(100 + index),
      status: "covered" as const,
      startWatermark: { sequence: 10, ledgerDigestSha256: digest(200 + index) },
      endWatermark: { sequence: 11, ledgerDigestSha256: digest(300 + index) },
      authoritativeCount: 1,
      transcriptCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: digest(400 + index),
      gapReason: null,
    })),
    deterministicInputs: DETERMINISTIC_INPUT_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: { sequence: 20, ledgerDigestSha256: digest(500 + index) },
      endWatermark: { sequence: 22, ledgerDigestSha256: digest(510 + index) },
      authoritativeCount: 2,
      capturedCount: 2,
      contiguous: true,
      coverageAttestationDigestSha256: digest(520 + index),
      gapReason: null,
    })),
    cassetteAuthorities: CASSETTE_COVERAGE_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: { sequence: 30, ledgerDigestSha256: digest(600 + index) },
      endWatermark: { sequence: 31, ledgerDigestSha256: digest(610 + index) },
      authoritativeCount: 1,
      cassetteCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: digest(620 + index),
      gapReason: null,
    })),
    finalObservation: {
      status: "captured",
      phase: "post_window",
      observedAtMs: T0 + 61_000,
      observerMode: "independent",
      observerIdentityDigestSha256: digest(36),
      observationAttestationDigestSha256: digest(37),
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
      production: { observationDigestSha256: digest(11), verdict: "fail" },
      desired: { observationDigestSha256: digest(14), verdict: "pass" },
    },
  };
}

function makeUnsignedBundle(episode: ProductionCaptureEpisode): ProductionReplayBundleUnsignedManifest {
  const episodeEnvelope = formatProductionCaptureEpisode(episode);
  if (!episodeEnvelope.ok) throw new Error("episode fixture was invalid");
  let nextDigest = 700;
  const blobs: ReplayBundleBlob[] = [];
  const addBlob = (kind: ReplayBundleBlob["kind"], fixed?: string): string => {
    const digestSha256 = fixed ?? digest(nextDigest++);
    blobs.push({ digestSha256, bytes: 128 + nextDigest, kind });
    return digestSha256;
  };
  const runtimeArchive = addBlob("runtime_archive");
  const stateArchive = addBlob("state_archive");
  const snapshotManifest = addBlob("snapshot_manifest", digest(5));
  const sourceEvidence = addBlob("source_evidence");
  const targetEvidence = addBlob("target_evidence");
  const captureEpisode = addBlob("capture_episode");
  const transcript = addBlob("canonical_transcript");
  const sequenceBlobs = new Map(
    DETERMINISTIC_SEQUENCE_KINDS.map((kind) => [kind, addBlob(`${kind}_sequence`)] as const),
  );
  const cassettes: ReplayCassette[] = CASSETTE_KINDS.map((kind) => ({
    cassetteId: `${kind}-1`,
    kind,
    ordinal: 1,
    requestBlobDigestSha256: addBlob("cassette_request"),
    responseBlobDigestSha256: addBlob("cassette_response"),
    outcome: "success",
    latencyMs: 25,
  }));
  const expectedOutputs = addBlob("expected_outputs");
  const expectedState = addBlob("expected_state");
  const runtime = { digestSha256: digest(1), entryCount: 9_000, bytes: 3_000_000_000, version: "1.0.53" };
  const state = { treeDigestSha256: digest(6), entryCount: 2_100, bytes: 301_000_000 };
  return {
    schema: "comis-production-replay-bundle",
    schemaVersion: 1,
    bundleId: episode.episodeId,
    createdAtMs: T0 + 62_000,
    attestations: {
      source: { role: "production_source", machineIdSha256: digest(2), profileDigestSha256: digest(3), evidenceBlobDigestSha256: sourceEvidence },
      target: { role: "replay_target", machineIdSha256: digest(4), profileDigestSha256: digest(40), evidenceBlobDigestSha256: targetEvidence },
      runtime: { archiveBlobDigestSha256: runtimeArchive, source: runtime, target: { ...runtime }, exact: true },
      state: { snapshotManifestBlobDigestSha256: snapshotManifest, archiveBlobDigestSha256: stateArchive, captureMode: "offline", source: state, target: { ...state }, exact: true },
    },
    vault: { format: "aes-256-gcm-detached-v1", encryptionKeyIdSha256: digest(41), blobs },
    episode: {
      blobDigestSha256: captureEpisode,
      contentDigestSha256: createHash("sha256").update(episodeEnvelope.value).digest("hex"),
      episodeId: episode.episodeId,
      captureMode: episode.captureMode,
      windowStartAtMs: episode.window.startAtMs,
      windowEndAtMs: episode.window.endAtMs,
      initialCheckpointSnapshotManifestDigestSha256: episode.initialCheckpoint.snapshotManifestDigestSha256,
      inputSetDigestSha256: episode.replayInput.inputSetDigestSha256,
      target: episode.replayInput.target,
      classification: episode.replayInput.classification,
      exactEligible: true,
    },
    transcript: {
      blobDigestSha256: transcript,
      captureId: episode.episodeId,
      eventCount: TRANSCRIPT_EXACT_SOURCE_KINDS.length,
      authorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => ({ kind, sourceId: `${kind}-source`, status: "available" as const, authoritativeCount: 1, transcriptCount: 1, gapReasons: [] })),
    },
    determinism: {
      sequences: DETERMINISTIC_SEQUENCE_KINDS.map((kind) => ({ kind, status: "captured" as const, recordCount: 2, blobDigestSha256: sequenceBlobs.get(kind) as string, gapReason: null })),
      cassetteAuthorities: CASSETTE_KINDS.map((kind) => ({ kind, status: "captured" as const, authoritativeCount: 1, cassetteCount: 1, gapReason: null })),
      cassettes,
    },
    expected: { outputCount: 12, outputBlobDigestSha256: expectedOutputs, finalStateRecordCount: 2_100, finalStateBlobDigestSha256: expectedState, finalStateDigestSha256: digest(10) },
    fidelity: { classification: "deterministic_cassette_exact", target: "deterministic_cassette", exactEligible: true, gaps: [] },
  };
}

function makeIdentity(): ProductionCampaignIdentity {
  const episode = makeEpisode();
  const sealed = sealProductionReplayBundleManifest(makeUnsignedBundle(episode), SEAL_KEY);
  const episodeEnvelope = formatProductionCaptureEpisode(episode);
  expect(sealed.ok).toBe(true);
  expect(episodeEnvelope.ok).toBe(true);
  if (!sealed.ok || !episodeEnvelope.ok) throw new Error("identity fixture was invalid");
  const identity = parseProductionCampaignIdentity({
    bundleEnvelope: formatProductionReplayBundleManifest(sealed.value),
    bundleSealKey: SEAL_KEY,
    episodeEnvelope: episodeEnvelope.value,
  });
  expect(identity.ok).toBe(true);
  if (!identity.ok) throw new Error(`identity fixture failed: ${identity.error.kind}`);
  return identity.value;
}

function baseArtifact<Kind extends ProductionCampaignArtifact["kind"]>(
  kind: Kind,
  artifactRef: string,
  index: number,
) {
  return {
    kind,
    artifactRef,
    artifactDigestSha256: digest(1_000 + index),
    authorityKeyIdSha256: digest(900),
    authenticationTagSha256: digest(901 + index),
  } as const;
}

function makeArtifacts(identity: ProductionCampaignIdentity): Map<string, ProductionCampaignArtifact> {
  const target = identity.targetMachineIdSha256;
  const artifacts: ProductionCampaignArtifact[] = [
    { ...baseArtifact("bundle_manifest", "artifact:bundle", 1), bundleId: identity.bundleId, manifestDigestSha256: identity.bundleManifestDigestSha256 },
    { ...baseArtifact("capture_episode", "artifact:episode", 2), bundleId: identity.bundleId, episodeId: identity.episodeId, blobDigestSha256: identity.episodeBlobDigestSha256, contentDigestSha256: identity.episodeContentDigestSha256 },
    { ...baseArtifact("clean_restore", "artifact:restore-red", 3), restoreId: "restore-red", bundleId: identity.bundleId, episodeId: identity.episodeId, targetMachineIdSha256: target, snapshotManifestDigestSha256: identity.initialSnapshotManifestDigestSha256, stateTreeDigestSha256: identity.initialStateTreeDigestSha256, result: "exact", completedAtMs: T0 + 70_000 },
    { ...baseArtifact("replay_report", "artifact:replay-red", 4), runId: "run-red", caseId: "case-a", bundleId: identity.bundleId, episodeId: identity.episodeId, restoreId: "restore-red", targetMachineIdSha256: target, runtimeDigestSha256: identity.sourceRuntimeDigestSha256, inputSetDigestSha256: identity.inputSetDigestSha256, fidelity: "matched", result: "completed", startedAtMs: T0 + 71_000, completedAtMs: T0 + 72_000 },
    { ...baseArtifact("replay_observation", "artifact:observation-red", 5), runId: "run-red", caseId: "case-a", phase: "reproduction", observerMode: "independent", observationDigestSha256: identity.productionObservationDigestSha256, verdict: "fail", observedAtMs: T0 + 72_100 },
    { ...baseArtifact("oracle_report", "artifact:oracle-red", 6), runId: "run-red", caseId: "case-a", phase: "reproduction", oracleSetDigestSha256: identity.oracleSetDigestSha256, verdict: "fail", evaluatedAtMs: T0 + 72_200 },
    { ...baseArtifact("source_checkout", "artifact:checkout", 7), checkoutId: "checkout-a", treeDigestSha256: digest(20), baselineRuntimeDigestSha256: identity.sourceRuntimeDigestSha256, clean: true, capturedAtMs: T0 + 72_300 },
    { ...baseArtifact("diagnosis", "artifact:diagnosis", 8), defectId: "defect-a", replayRunId: "run-red", sourceCheckoutId: "checkout-a", rootCauseDigestSha256: digest(22), authoritativeLayer: "orchestrator-ingress", recordedAtMs: T0 + 72_400 },
    { ...baseArtifact("regression_gate", "artifact:regression-red", 9), gateId: "gate-red", phase: "pre_patch", subjectId: "checkout-a", runtimeDigestSha256: identity.sourceRuntimeDigestSha256, testPath: "packages/agent/src/example.test.ts", commandDigestSha256: digest(23), result: "fail", failureShapeDigestSha256: digest(24), completedAtMs: T0 + 72_500 },
    { ...baseArtifact("patch_build", "artifact:build", 10), buildId: "build-a", sourceCheckoutId: "checkout-a", sourceTreeDigestSha256: digest(20), patchDigestSha256: digest(25), runtimeDigestSha256: digest(26), result: "success", builtAtMs: T0 + 73_000 },
    { ...baseArtifact("regression_gate", "artifact:regression-green", 11), gateId: "gate-green", phase: "post_patch", subjectId: "build-a", runtimeDigestSha256: digest(26), testPath: "packages/agent/src/example.test.ts", commandDigestSha256: digest(23), result: "pass", failureShapeDigestSha256: null, completedAtMs: T0 + 73_100 },
    { ...baseArtifact("deployment", "artifact:deployment", 12), deploymentId: "deployment-a", buildId: "build-a", targetMachineIdSha256: target, runtimeDigestSha256: digest(26), result: "complete", completedAtMs: T0 + 74_000 },
    { ...baseArtifact("clean_restore", "artifact:restore-green", 13), restoreId: "restore-green", bundleId: identity.bundleId, episodeId: identity.episodeId, targetMachineIdSha256: target, snapshotManifestDigestSha256: identity.initialSnapshotManifestDigestSha256, stateTreeDigestSha256: identity.initialStateTreeDigestSha256, result: "exact", completedAtMs: T0 + 75_000 },
    { ...baseArtifact("replay_report", "artifact:replay-green", 14), runId: "run-green", caseId: "case-a", bundleId: identity.bundleId, episodeId: identity.episodeId, restoreId: "restore-green", targetMachineIdSha256: target, runtimeDigestSha256: digest(26), inputSetDigestSha256: identity.inputSetDigestSha256, fidelity: "matched", result: "completed", startedAtMs: T0 + 75_100, completedAtMs: T0 + 76_000 },
    { ...baseArtifact("replay_observation", "artifact:observation-green", 15), runId: "run-green", caseId: "case-a", phase: "verification", observerMode: "independent", observationDigestSha256: identity.desiredObservationDigestSha256, verdict: "pass", observedAtMs: T0 + 76_100 },
    { ...baseArtifact("oracle_report", "artifact:oracle-green", 16), runId: "run-green", caseId: "case-a", phase: "verification", oracleSetDigestSha256: identity.oracleSetDigestSha256, verdict: "pass", evaluatedAtMs: T0 + 76_200 },
    { ...baseArtifact("forced_failure_proof", "artifact:forced-failure", 17), runId: "run-green", deploymentId: "deployment-a", observerMode: "independent", expectedFailureObserved: true, logProofDigestSha256: digest(27), eventProofDigestSha256: digest(28), hintProofDigestSha256: digest(29), completedAtMs: T0 + 76_300 },
    { ...baseArtifact("regression_gate", "artifact:regression-deployed", 18), gateId: "gate-deployed", phase: "deployed", subjectId: "deployment-a", runtimeDigestSha256: digest(26), testPath: "packages/agent/src/example.test.ts", commandDigestSha256: digest(23), result: "pass", failureShapeDigestSha256: null, completedAtMs: T0 + 76_400 },
  ];
  return new Map(artifacts.map((artifact) => [artifact.artifactRef, artifact]));
}

function makeResolver(artifacts: Map<string, ProductionCampaignArtifact>): ProductionCampaignArtifactResolver {
  return {
    resolve(artifactRef) {
      const artifact = artifacts.get(artifactRef);
      return artifact === undefined
        ? err({ kind: "artifact_unavailable", message: "Artifact is unavailable" })
        : ok(artifact);
    },
  };
}

function createFixture(): { campaign: ProductionCampaign; resolver: ProductionCampaignArtifactResolver; artifacts: Map<string, ProductionCampaignArtifact> } {
  const identity = makeIdentity();
  const artifacts = makeArtifacts(identity);
  const resolver = makeResolver(artifacts);
  const result = createProductionCampaign({
    campaignId: "campaign-a",
    identity,
    bundleArtifactRef: "artifact:bundle",
    episodeArtifactRef: "artifact:episode",
    caseIds: ["case-a"],
    createdAtMs: T0 + 69_000,
  }, resolver);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`campaign fixture failed: ${result.error.kind}`);
  return { campaign: result.value, resolver, artifacts };
}

function advance(campaign: ProductionCampaign, action: ProductionCampaignAction, resolver: ProductionCampaignArtifactResolver): ProductionCampaign {
  const result = advanceProductionCampaign(campaign, action, resolver);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`fixture transition failed: ${result.error.kind}`);
  return result.value;
}

function beginAndReproduceRed(campaign: ProductionCampaign, resolver: ProductionCampaignArtifactResolver): ProductionCampaign {
  campaign = advance(campaign, { kind: "begin_case", caseId: "case-a", replayRunId: "run-red", restoreArtifactRef: "artifact:restore-red", startedAtMs: T0 + 71_000 }, resolver);
  return advance(campaign, { kind: "record_reproduction", caseId: "case-a", defectId: "defect-a", failureClass: "false_success", replayReportArtifactRef: "artifact:replay-red", observationArtifactRef: "artifact:observation-red", oracleReportArtifactRef: "artifact:oracle-red", completedAtMs: T0 + 72_200 }, resolver);
}

function campaignAtDeployment(): { campaign: ProductionCampaign; resolver: ProductionCampaignArtifactResolver; artifacts: Map<string, ProductionCampaignArtifact> } {
  const fixture = createFixture();
  let campaign = beginAndReproduceRed(fixture.campaign, fixture.resolver);
  campaign = advance(campaign, { kind: "record_diagnosis", defectId: "defect-a", sourceCheckoutArtifactRef: "artifact:checkout", diagnosisArtifactRef: "artifact:diagnosis", prePatchRegressionArtifactRef: "artifact:regression-red", recordedAtMs: T0 + 72_500 }, fixture.resolver);
  campaign = advance(campaign, { kind: "record_green", defectId: "defect-a", patchBuildArtifactRef: "artifact:build", regressionGateArtifactRef: "artifact:regression-green", recordedAtMs: T0 + 73_100 }, fixture.resolver);
  campaign = advance(campaign, { kind: "record_deployment", defectId: "defect-a", deploymentArtifactRef: "artifact:deployment", deployedAtMs: T0 + 74_000 }, fixture.resolver);
  return { ...fixture, campaign };
}

describe("authenticated production feedback campaign", () => {
  it("binds creation to authenticated exact bundle and prospective episode artifacts", () => {
    const { campaign } = createFixture();
    expect(campaign).toMatchObject({
      schema: "comis-production-replay-campaign",
      schemaVersion: 1,
      status: "ready",
      exactEligible: true,
      bundleId: "episode-a",
      episodeId: "episode-a",
      sourceRuntimeDigestSha256: digest(1),
      activeRuntimeDigestSha256: digest(1),
    });
    expect(campaign.evidence.map(({ kind }) => kind)).toEqual(["bundle_manifest", "capture_episode"]);
  });

  it("rejects a copied identity that did not come directly from authenticated parsing", () => {
    const parsed = makeIdentity();
    const copied = { ...parsed };
    const artifacts = makeArtifacts(parsed);
    const result = createProductionCampaign({
      campaignId: "campaign-forged",
      identity: copied,
      bundleArtifactRef: "artifact:bundle",
      episodeArtifactRef: "artifact:episode",
      caseIds: ["case-a"],
      createdAtMs: T0 + 69_000,
    }, makeResolver(artifacts));

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_identity" } });
  });

  it("rejects an episode envelope whose correctness contract is not bound to the signed bundle", () => {
    const episode = makeEpisode();
    const sealed = sealProductionReplayBundleManifest(makeUnsignedBundle(episode), SEAL_KEY);
    const tampered = formatProductionCaptureEpisode({
      ...episode,
      correctness: {
        ...episode.correctness,
        desired: { ...episode.correctness.desired, observationDigestSha256: digest(999) },
      },
    });
    expect(sealed.ok).toBe(true);
    expect(tampered.ok).toBe(true);
    if (!sealed.ok || !tampered.ok) return;

    expect(parseProductionCampaignIdentity({
      bundleEnvelope: formatProductionReplayBundleManifest(sealed.value),
      bundleSealKey: SEAL_KEY,
      episodeEnvelope: tampered.value,
    })).toMatchObject({ ok: false, error: { kind: "invalid_identity" } });
  });

  it("returns an immutable authenticated identity", () => {
    const identity = makeIdentity();
    const original = identity.desiredObservationDigestSha256;
    const changed = Reflect.set(identity, "desiredObservationDigestSha256", digest(999));

    expect(changed).toBe(false);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity.desiredObservationDigestSha256).toBe(original);
  });

  it("records RED only when exact inputs reproduce production and the desired oracle fails", () => {
    const { campaign: initial, resolver } = createFixture();
    const campaign = beginAndReproduceRed(initial, resolver);
    expect(campaign.cases[0]).toMatchObject({
      status: "running",
      reproductionFidelity: "matched",
      reproductionCorrectness: "red_reproduced",
      defectId: "defect-a",
    });
    expect(campaign.defects[0]).toMatchObject({ status: "red_reproduced", replayRunId: "run-red" });
  });

  it("rejects caller-supplied matching digest strings as campaign proof", () => {
    const { campaign, resolver } = createFixture();
    const arbitrary = digest(888);
    const result = advanceProductionCampaign(campaign, {
      kind: "record_pass",
      caseId: "case-a",
      observedDigest: arbitrary,
      expectedDigest: arbitrary,
      oracleDigests: [arbitrary, digest(889)],
      evidenceRefs: [],
      completedAtMs: T0 + 71_000,
    } as unknown as ProductionCampaignAction, resolver);
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_action" } });
  });

  it("rejects skipped clean restore before reproduction and unavailable evidence", () => {
    const { campaign, resolver } = createFixture();
    const skipped = advanceProductionCampaign(campaign, {
      kind: "begin_case",
      caseId: "case-a",
      replayRunId: "run-red",
      restoreArtifactRef: "artifact:missing-restore",
      startedAtMs: T0 + 71_000,
    }, resolver);
    expect(skipped).toMatchObject({ ok: false, error: { kind: "artifact_resolution" } });
  });

  it("requires checkout, prepatch failure, patch build, regression pass, and deployment in order", () => {
    const { campaign: initial, resolver } = createFixture();
    const red = beginAndReproduceRed(initial, resolver);
    const earlyGreen = advanceProductionCampaign(red, {
      kind: "record_green",
      defectId: "defect-a",
      patchBuildArtifactRef: "artifact:build",
      regressionGateArtifactRef: "artifact:regression-green",
      recordedAtMs: T0 + 73_100,
    }, resolver);
    expect(earlyGreen).toMatchObject({ ok: false, error: { kind: "invalid_transition" } });
  });

  it("verifies GREEN against desired correctness even when it intentionally differs from production", () => {
    const { campaign: deployed, resolver } = campaignAtDeployment();
    const result = advanceProductionCampaign(deployed, {
      kind: "verify_fix",
      defectId: "defect-a",
      restoreArtifactRef: "artifact:restore-green",
      replayReportArtifactRef: "artifact:replay-green",
      observationArtifactRef: "artifact:observation-green",
      oracleReportArtifactRef: "artifact:oracle-green",
      forcedFailureArtifactRef: "artifact:forced-failure",
      regressionGateArtifactRef: "artifact:regression-deployed",
      verifiedAtMs: T0 + 76_400,
    }, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productionObservationDigestSha256).not.toBe(result.value.desiredObservationDigestSha256);
    expect(result.value.cases[0]).toMatchObject({ status: "passed_after_fix", verificationCorrectness: "green_verified" });
    expect(result.value.defects[0]).toMatchObject({ status: "verified" });
    expect(result.value.activeRuntimeDigestSha256).toBe(digest(26));
  });

  it("cannot pass verification when deployment or the post-deployment clean restore is skipped", () => {
    const fixture = createFixture();
    let campaign = beginAndReproduceRed(fixture.campaign, fixture.resolver);
    campaign = advance(campaign, { kind: "record_diagnosis", defectId: "defect-a", sourceCheckoutArtifactRef: "artifact:checkout", diagnosisArtifactRef: "artifact:diagnosis", prePatchRegressionArtifactRef: "artifact:regression-red", recordedAtMs: T0 + 72_500 }, fixture.resolver);
    campaign = advance(campaign, { kind: "record_green", defectId: "defect-a", patchBuildArtifactRef: "artifact:build", regressionGateArtifactRef: "artifact:regression-green", recordedAtMs: T0 + 73_100 }, fixture.resolver);
    const withoutDeployment = advanceProductionCampaign(campaign, {
      kind: "verify_fix",
      defectId: "defect-a",
      restoreArtifactRef: "artifact:restore-green",
      replayReportArtifactRef: "artifact:replay-green",
      observationArtifactRef: "artifact:observation-green",
      oracleReportArtifactRef: "artifact:oracle-green",
      forcedFailureArtifactRef: "artifact:forced-failure",
      regressionGateArtifactRef: "artifact:regression-deployed",
      verifiedAtMs: T0 + 76_400,
    }, fixture.resolver);
    expect(withoutDeployment).toMatchObject({ ok: false, error: { kind: "invalid_transition" } });

    const deployed = advance(campaign, { kind: "record_deployment", defectId: "defect-a", deploymentArtifactRef: "artifact:deployment", deployedAtMs: T0 + 74_000 }, fixture.resolver);
    const wrongRestore = advanceProductionCampaign(deployed, {
      kind: "verify_fix",
      defectId: "defect-a",
      restoreArtifactRef: "artifact:restore-red",
      replayReportArtifactRef: "artifact:replay-green",
      observationArtifactRef: "artifact:observation-green",
      oracleReportArtifactRef: "artifact:oracle-green",
      forcedFailureArtifactRef: "artifact:forced-failure",
      regressionGateArtifactRef: "artifact:regression-deployed",
      verifiedAtMs: T0 + 76_400,
    }, fixture.resolver);
    expect(wrongRestore).toMatchObject({ ok: false, error: { kind: "artifact_mismatch" } });
  });

  it("rejects a forged observability proof and reauthenticates stored evidence on every action", () => {
    const { campaign, resolver, artifacts } = campaignAtDeployment();
    const forced = artifacts.get("artifact:forced-failure");
    if (forced?.kind !== "forced_failure_proof") throw new Error("forced failure fixture is absent");
    artifacts.set("artifact:forced-failure", { ...forced, expectedFailureObserved: false });
    const forged = advanceProductionCampaign(campaign, {
      kind: "verify_fix",
      defectId: "defect-a",
      restoreArtifactRef: "artifact:restore-green",
      replayReportArtifactRef: "artifact:replay-green",
      observationArtifactRef: "artifact:observation-green",
      oracleReportArtifactRef: "artifact:oracle-green",
      forcedFailureArtifactRef: "artifact:forced-failure",
      regressionGateArtifactRef: "artifact:regression-deployed",
      verifiedAtMs: T0 + 76_400,
    }, resolver);
    expect(forged).toMatchObject({ ok: false, error: { kind: "artifact_mismatch" } });

    const bundle = artifacts.get("artifact:bundle");
    if (bundle === undefined) throw new Error("bundle fixture is absent");
    artifacts.set("artifact:bundle", { ...bundle, artifactDigestSha256: digest(999) });
    const rebound = advanceProductionCampaign(campaign, {
      kind: "verify_fix",
      defectId: "defect-a",
      restoreArtifactRef: "artifact:restore-green",
      replayReportArtifactRef: "artifact:replay-green",
      observationArtifactRef: "artifact:observation-green",
      oracleReportArtifactRef: "artifact:oracle-green",
      forcedFailureArtifactRef: "artifact:forced-failure",
      regressionGateArtifactRef: "artifact:regression-deployed",
      verifiedAtMs: T0 + 76_400,
    }, resolver);
    expect(rebound).toMatchObject({ ok: false, error: { kind: "artifact_mismatch" } });
  });

  it("round-trips a strict content-free campaign envelope", () => {
    const { campaign } = createFixture();
    const serialized = serializeProductionCampaign(campaign);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseProductionCampaign(serialized.value)).toEqual({ ok: true, value: campaign });
    const appended = JSON.parse(serialized.value) as Record<string, unknown>;
    appended.promptBody = "PRIVATE_USER_PROMPT";
    const result = parseProductionCampaign(JSON.stringify(appended));
    expect(result).toMatchObject({ ok: false, error: { kind: "malformed_campaign" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_USER_PROMPT");
  });

  it("rejects a forged completed case that has no restore replay observation or oracle evidence", () => {
    const { campaign } = createFixture();
    const forged = structuredClone(campaign) as {
      status: string;
      cursor: number;
      updatedAtMs: number;
      cases: Array<Record<string, unknown>>;
    };
    forged.status = "completed";
    forged.cursor = 1;
    forged.updatedAtMs = campaign.createdAtMs + 1;
    forged.cases[0] = {
      ...forged.cases[0],
      status: "passed",
      completedAtMs: campaign.createdAtMs + 1,
    };

    expect(parseProductionCampaign(JSON.stringify(forged))).toMatchObject({
      ok: false,
      error: { kind: "malformed_campaign" },
    });
  });
});
