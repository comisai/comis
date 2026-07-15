// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  sealProductionReplayBundleManifest,
  type ProductionReplayBundleManifest,
  type ProductionReplayBundleUnsignedManifest,
  type ReplayBundleBlobKind,
  type ReplayStateIdentity,
} from "./production-bundle.js";
import {
  compareProductionEvidenceReports,
  parseProductionEvidenceFacts,
} from "./production-evidence.js";
import { parseProductionCaptureEpisode } from "./production-episode.js";
import {
  deriveProductionSnapshotTreeIdentity,
  parseProductionSnapshotManifest,
  type ProductionSnapshotManifest,
} from "./production-snapshot.js";
import { parseCanonicalProductionTranscript } from "./production-transcript.js";
import {
  decryptProductionVaultBlob,
  productionVaultKeyIdSha256,
  type DecryptedProductionVaultBlob,
  type EncryptedProductionVaultBlob,
} from "./production-vault.js";

export interface ProductionReplayBundleAssemblyRequest {
  readonly unsignedManifest: ProductionReplayBundleUnsignedManifest;
  readonly encryptedBlobs: readonly EncryptedProductionVaultBlob[];
  /** Supplied by a controller-side key lifecycle; never sourced from environment or CLI state. */
  readonly vaultKey: Uint8Array;
  /** Independently supplied manifest authentication key. */
  readonly sealKey: Uint8Array;
}

export interface ProductionReplayBundleArtifactFact {
  readonly digestSha256: string;
  readonly bytes: number;
  readonly kind: ReplayBundleBlobKind;
}

export interface ProductionReplayBundleAssembly {
  readonly manifest: ProductionReplayBundleManifest;
  readonly artifacts: readonly ProductionReplayBundleArtifactFact[];
  readonly transcript: {
    readonly captureId: string;
    readonly eventCount: number;
  };
  readonly episode: {
    readonly episodeId: string;
    readonly captureMode: "prospective_window" | "historical_final_state_only";
    readonly windowStartAtMs: number;
    readonly windowEndAtMs: number;
    readonly inputSetDigestSha256: string;
    readonly classification:
      | "historical_best_effort"
      | "prospective_bounded"
      | "deterministic_cassette_exact"
      | "live_provider_semantic";
    readonly exactEligible: boolean;
  };
  readonly snapshot: {
    readonly runId: string;
    readonly captureMode: "offline" | "bounded-freeze";
    readonly entryCount: number;
    readonly bytes: number;
    readonly treeDigestSha256: string;
  };
  readonly evidence: {
    readonly consistency: "live_non_atomic";
    readonly sourceObservedAtMs: number;
    readonly targetObservedAtMs: number;
    readonly itemCount: number;
    readonly gapCount: number;
  };
}

export type ProductionReplayBundleAssemblyError =
  | {
      readonly kind: "vault_authentication_failed";
      readonly message: "A production vault artifact failed authentication";
    }
  | {
      readonly kind: "vault_inventory_mismatch";
      readonly message: "Production vault inventory does not match the bundle manifest";
    }
  | {
      readonly kind: "authority_artifact_invalid";
      readonly artifact:
        | "canonical_transcript"
        | "snapshot_manifest"
        | "source_evidence"
        | "target_evidence"
        | "capture_episode";
      readonly message: "A production authority artifact failed strict validation";
    }
  | {
      readonly kind: "artifact_reconciliation_failed";
      readonly field: "transcript" | "snapshot" | "state" | "evidence" | "episode";
      readonly message: "Production authority facts do not reconcile with the bundle manifest";
    }
  | {
      readonly kind: "bundle_seal_failed";
      readonly message: "Production replay bundle claims failed validation before sealing";
    };

const MAX_ASSEMBLY_BLOBS = 200_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;

function vaultAuthenticationFailed(): Result<never, ProductionReplayBundleAssemblyError> {
  return err({
    kind: "vault_authentication_failed",
    message: "A production vault artifact failed authentication",
  });
}

function vaultInventoryMismatch(): Result<never, ProductionReplayBundleAssemblyError> {
  return err({
    kind: "vault_inventory_mismatch",
    message: "Production vault inventory does not match the bundle manifest",
  });
}

function invalidAuthority(
  artifact:
    | "canonical_transcript"
    | "snapshot_manifest"
    | "source_evidence"
    | "target_evidence"
    | "capture_episode",
): Result<never, ProductionReplayBundleAssemblyError> {
  return err({
    kind: "authority_artifact_invalid",
    artifact,
    message: "A production authority artifact failed strict validation",
  });
}

function reconciliationFailed(
  field: "transcript" | "snapshot" | "state" | "evidence" | "episode",
): Result<never, ProductionReplayBundleAssemblyError> {
  return err({
    kind: "artifact_reconciliation_failed",
    field,
    message: "Production authority facts do not reconcile with the bundle manifest",
  });
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function decodePrivateText(plaintext: Uint8Array): Result<string, ProductionReplayBundleAssemblyError> {
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  if (!decoded.ok) {
    return err({
      kind: "authority_artifact_invalid",
      artifact: "canonical_transcript",
      message: "A production authority artifact failed strict validation",
    });
  }
  return ok(decoded.value);
}

function stateIdentity(
  manifest: Pick<
    ProductionSnapshotManifest,
    "entries" | "metadataIdentity" | "treeIdentitySha256"
  >,
): ReplayStateIdentity | null {
  let bytes = 0;
  for (const entry of manifest.entries) {
    if (entry.type !== "file") continue;
    bytes += entry.size;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  const treeDigestSha256 = deriveProductionSnapshotTreeIdentity(manifest);
  if (!equalDigest(treeDigestSha256, manifest.treeIdentitySha256)) return null;
  return {
    treeDigestSha256,
    entryCount: manifest.entries.length,
    bytes,
  };
}

export function deriveProductionSnapshotStateIdentity(
  manifest: Pick<
    ProductionSnapshotManifest,
    "entries" | "metadataIdentity" | "treeIdentitySha256"
  >,
): Result<ReplayStateIdentity, ProductionReplayBundleAssemblyError> {
  const identity = stateIdentity(manifest);
  return identity === null ? reconciliationFailed("state") : ok(identity);
}

function stateIdentitiesEqual(left: ReplayStateIdentity, right: ReplayStateIdentity): boolean {
  return (
    equalDigest(left.treeDigestSha256, right.treeDigestSha256) &&
    left.entryCount === right.entryCount &&
    left.bytes === right.bytes
  );
}

function sourceIdDigest(sourceId: string): string {
  return createHash("sha256").update(sourceId).digest("hex");
}

function decryptInventory(
  request: ProductionReplayBundleAssemblyRequest,
  decrypted: DecryptedProductionVaultBlob[],
): Result<Map<string, DecryptedProductionVaultBlob>, ProductionReplayBundleAssemblyError> {
  if (
    !Array.isArray(request.encryptedBlobs) ||
    request.encryptedBlobs.length === 0 ||
    request.encryptedBlobs.length > MAX_ASSEMBLY_BLOBS
  ) {
    return vaultInventoryMismatch();
  }
  const keyId = productionVaultKeyIdSha256(request.vaultKey);
  if (
    !keyId.ok ||
    !equalDigest(request.unsignedManifest.vault.encryptionKeyIdSha256, keyId.value)
  ) {
    return vaultAuthenticationFailed();
  }
  const byDigest = new Map<string, DecryptedProductionVaultBlob>();
  for (const encrypted of request.encryptedBlobs) {
    const result = decryptProductionVaultBlob(encrypted, request.vaultKey);
    if (!result.ok) return vaultAuthenticationFailed();
    decrypted.push(result.value);
    if (byDigest.has(result.value.digestSha256)) return vaultInventoryMismatch();
    byDigest.set(result.value.digestSha256, result.value);
  }
  return ok(byDigest);
}

function reconcileInventory(
  manifest: ProductionReplayBundleUnsignedManifest,
  actual: ReadonlyMap<string, DecryptedProductionVaultBlob>,
): Result<readonly ProductionReplayBundleArtifactFact[], ProductionReplayBundleAssemblyError> {
  if (
    !Array.isArray(manifest.vault.blobs) ||
    manifest.vault.blobs.length !== actual.size ||
    manifest.vault.blobs.length > MAX_ASSEMBLY_BLOBS
  ) {
    return vaultInventoryMismatch();
  }
  const declared = new Set<string>();
  const facts: ProductionReplayBundleArtifactFact[] = [];
  for (const blob of manifest.vault.blobs) {
    if (declared.has(blob.digestSha256)) return vaultInventoryMismatch();
    declared.add(blob.digestSha256);
    const candidate = actual.get(blob.digestSha256);
    if (
      candidate === undefined ||
      candidate.kind !== blob.kind ||
      candidate.bytes !== blob.bytes ||
      !equalDigest(candidate.digestSha256, blob.digestSha256)
    ) {
      return vaultInventoryMismatch();
    }
    facts.push({
      digestSha256: candidate.digestSha256,
      bytes: candidate.bytes,
      kind: candidate.kind,
    });
  }
  if ([...actual.keys()].some((digestSha256) => !declared.has(digestSha256))) {
    return vaultInventoryMismatch();
  }
  return ok(facts);
}

function requiredArtifact(
  actual: ReadonlyMap<string, DecryptedProductionVaultBlob>,
  digestSha256: string,
  kind: ReplayBundleBlobKind,
): Result<DecryptedProductionVaultBlob, ProductionReplayBundleAssemblyError> {
  const artifact = actual.get(digestSha256);
  if (artifact === undefined || artifact.kind !== kind) return vaultInventoryMismatch();
  return ok(artifact);
}

function reconcileAuthorities(
  request: ProductionReplayBundleAssemblyRequest,
  actual: ReadonlyMap<string, DecryptedProductionVaultBlob>,
): Result<
  Omit<ProductionReplayBundleAssembly, "manifest" | "artifacts">,
  ProductionReplayBundleAssemblyError
> {
  const transcriptBlob = requiredArtifact(
    actual,
    request.unsignedManifest.transcript.blobDigestSha256,
    "canonical_transcript",
  );
  if (!transcriptBlob.ok) return transcriptBlob;
  const transcriptText = decodePrivateText(transcriptBlob.value.plaintext);
  if (!transcriptText.ok) return invalidAuthority("canonical_transcript");
  const transcript = parseCanonicalProductionTranscript(transcriptText.value);
  if (!transcript.ok) return invalidAuthority("canonical_transcript");

  const episodeBlob = requiredArtifact(
    actual,
    request.unsignedManifest.episode.blobDigestSha256,
    "capture_episode",
  );
  if (!episodeBlob.ok) return episodeBlob;
  const episodeText = decodePrivateText(episodeBlob.value.plaintext);
  if (!episodeText.ok) return invalidAuthority("capture_episode");
  if (
    createHash("sha256").update(episodeBlob.value.plaintext).digest("hex") !==
    request.unsignedManifest.episode.contentDigestSha256
  ) {
    return reconciliationFailed("episode");
  }
  const episode = parseProductionCaptureEpisode(episodeText.value);
  if (!episode.ok) return invalidAuthority("capture_episode");

  const transcriptCounts = new Map<string, number>();
  for (const event of transcript.value.events) {
    const key = `${event.source.kind}\0${event.source.id}`;
    transcriptCounts.set(key, (transcriptCounts.get(key) ?? 0) + 1);
    if (event.replay.blobDigest !== null && !actual.has(event.replay.blobDigest)) {
      return reconciliationFailed("transcript");
    }
  }
  const declaredSources = new Set<string>();
  for (const authority of request.unsignedManifest.transcript.authorities) {
    const key = `${authority.kind}\0${authority.sourceId}`;
    declaredSources.add(key);
    if ((transcriptCounts.get(key) ?? 0) !== authority.transcriptCount) {
      return reconciliationFailed("transcript");
    }
  }
  if (
    transcript.value.captureId !== request.unsignedManifest.transcript.captureId ||
    transcript.value.events.length !== request.unsignedManifest.transcript.eventCount ||
    [...transcriptCounts.keys()].some((key) => !declaredSources.has(key))
  ) {
    return reconciliationFailed("transcript");
  }

  const snapshotBlob = requiredArtifact(
    actual,
    request.unsignedManifest.attestations.state.snapshotManifestBlobDigestSha256,
    "snapshot_manifest",
  );
  if (!snapshotBlob.ok) return snapshotBlob;
  const snapshotText = decodePrivateText(snapshotBlob.value.plaintext);
  if (!snapshotText.ok) return invalidAuthority("snapshot_manifest");
  const snapshot = parseProductionSnapshotManifest(snapshotText.value);
  if (!snapshot.ok) return invalidAuthority("snapshot_manifest");
  if (
    snapshot.value.sourceMachineIdSha256 !==
      request.unsignedManifest.attestations.source.machineIdSha256 ||
    snapshot.value.captureMode !== request.unsignedManifest.attestations.state.captureMode
  ) {
    return reconciliationFailed("snapshot");
  }
  const computedState = deriveProductionSnapshotStateIdentity(snapshot.value);
  if (!computedState.ok) return computedState;
  if (!stateIdentitiesEqual(computedState.value, request.unsignedManifest.attestations.state.source)) {
    return reconciliationFailed("state");
  }

  const manifestEpisode = request.unsignedManifest.episode;
  if (
    snapshot.value.metadataIdentity.gaps.length > 0 &&
    (episode.value.replayInput.exactEligible ||
      manifestEpisode.exactEligible ||
      request.unsignedManifest.fidelity.exactEligible)
  ) {
    return reconciliationFailed("snapshot");
  }
  const checkpoint = episode.value.initialCheckpoint;
  const finalObservation = episode.value.finalObservation;
  const episodeSourceAuthorities = new Map(
    episode.value.sourceAuthorities.map((authority) => [
      `${authority.kind}\0${authority.sourceIdDigestSha256}`,
      authority,
    ] as const),
  );
  const transcriptAuthoritiesReconcile =
    episodeSourceAuthorities.size === request.unsignedManifest.transcript.authorities.length &&
    request.unsignedManifest.transcript.authorities.every((authority) => {
      const captured = episodeSourceAuthorities.get(
        `${authority.kind}\0${sourceIdDigest(authority.sourceId)}`,
      );
      return (
        captured !== undefined &&
        captured.transcriptCount === authority.transcriptCount &&
        captured.authoritativeCount === authority.authoritativeCount
      );
    });
  const deterministicInputsReconcile = request.unsignedManifest.determinism.sequences.every(
    (sequence) => {
      const captured = episode.value.deterministicInputs.find(
        (authority) => authority.kind === sequence.kind,
      );
      return (
        captured !== undefined &&
        captured.capturedCount === sequence.recordCount &&
        (captured.status === "covered") === (sequence.status === "captured")
      );
    },
  );
  const cassetteAuthoritiesReconcile =
    episode.value.cassetteAuthorities.length ===
      request.unsignedManifest.determinism.cassetteAuthorities.length &&
    request.unsignedManifest.determinism.cassetteAuthorities.every((authority) => {
      const captured = episode.value.cassetteAuthorities.find(
        (candidate) => candidate.kind === authority.kind,
      );
      return (
        captured !== undefined &&
        captured.cassetteCount === authority.cassetteCount &&
        captured.authoritativeCount === authority.authoritativeCount &&
        (captured.status === "covered") === (authority.status === "captured")
      );
    });
  const checkpointReconciles =
    checkpoint.status === "missing"
      ? manifestEpisode.initialCheckpointSnapshotManifestDigestSha256 === null
      : checkpoint.snapshotManifestDigestSha256 ===
          manifestEpisode.initialCheckpointSnapshotManifestDigestSha256 &&
        checkpoint.snapshotManifestDigestSha256 ===
          request.unsignedManifest.attestations.state.snapshotManifestBlobDigestSha256 &&
        checkpoint.capturedAtMs === snapshot.value.captureCompletedAtMs &&
        checkpoint.stateTreeDigestSha256 === computedState.value.treeDigestSha256 &&
        checkpoint.entryCount === computedState.value.entryCount &&
        checkpoint.bytes === computedState.value.bytes;
  if (
    episode.value.episodeId !== manifestEpisode.episodeId ||
    episode.value.episodeId !== request.unsignedManifest.bundleId ||
    episode.value.episodeId !== transcript.value.captureId ||
    episode.value.episodeId !== snapshot.value.runId ||
    episode.value.captureMode !== manifestEpisode.captureMode ||
    episode.value.window.startAtMs !== manifestEpisode.windowStartAtMs ||
    episode.value.window.endAtMs !== manifestEpisode.windowEndAtMs ||
    episode.value.replayInput.inputSetDigestSha256 !== manifestEpisode.inputSetDigestSha256 ||
    episode.value.replayInput.target !== manifestEpisode.target ||
    episode.value.replayInput.classification !== manifestEpisode.classification ||
    episode.value.replayInput.exactEligible !== manifestEpisode.exactEligible ||
    episode.value.replayInput.target !== request.unsignedManifest.fidelity.target ||
    !checkpointReconciles ||
    finalObservation.outputIndexDigestSha256 !==
      request.unsignedManifest.expected.outputBlobDigestSha256 ||
    finalObservation.outputCount !== request.unsignedManifest.expected.outputCount ||
    finalObservation.finalStateDigestSha256 !==
      request.unsignedManifest.expected.finalStateDigestSha256 ||
    finalObservation.finalStateRecordCount !==
      request.unsignedManifest.expected.finalStateRecordCount ||
    !transcriptAuthoritiesReconcile ||
    !deterministicInputsReconcile ||
    !cassetteAuthoritiesReconcile
  ) {
    return reconciliationFailed("episode");
  }

  const sourceEvidenceBlob = requiredArtifact(
    actual,
    request.unsignedManifest.attestations.source.evidenceBlobDigestSha256,
    "source_evidence",
  );
  if (!sourceEvidenceBlob.ok) return sourceEvidenceBlob;
  const targetEvidenceBlob = requiredArtifact(
    actual,
    request.unsignedManifest.attestations.target.evidenceBlobDigestSha256,
    "target_evidence",
  );
  if (!targetEvidenceBlob.ok) return targetEvidenceBlob;
  const sourceEvidenceText = decodePrivateText(sourceEvidenceBlob.value.plaintext);
  if (!sourceEvidenceText.ok) return invalidAuthority("source_evidence");
  const targetEvidenceText = decodePrivateText(targetEvidenceBlob.value.plaintext);
  if (!targetEvidenceText.ok) return invalidAuthority("target_evidence");
  const sourceEvidence = parseProductionEvidenceFacts(sourceEvidenceText.value);
  if (!sourceEvidence.ok) return invalidAuthority("source_evidence");
  const targetEvidence = parseProductionEvidenceFacts(targetEvidenceText.value);
  if (!targetEvidence.ok) return invalidAuthority("target_evidence");
  const evidenceParity = compareProductionEvidenceReports(
    sourceEvidence.value,
    targetEvidence.value,
  );
  if (!evidenceParity.ok) return reconciliationFailed("evidence");
  if (
    !request.unsignedManifest.fidelity.gaps.some(
      ({ kind, componentId, sourceKind }) =>
        kind === "capture_consistency_gap" && componentId === null && sourceKind === null,
    )
  ) {
    return reconciliationFailed("evidence");
  }

  return ok({
    episode: {
      episodeId: episode.value.episodeId,
      captureMode: episode.value.captureMode,
      windowStartAtMs: episode.value.window.startAtMs,
      windowEndAtMs: episode.value.window.endAtMs,
      inputSetDigestSha256: episode.value.replayInput.inputSetDigestSha256,
      classification: episode.value.replayInput.classification,
      exactEligible: episode.value.replayInput.exactEligible,
    },
    transcript: {
      captureId: transcript.value.captureId,
      eventCount: transcript.value.events.length,
    },
    snapshot: {
      runId: snapshot.value.runId,
      captureMode: snapshot.value.captureMode,
      entryCount: computedState.value.entryCount,
      bytes: computedState.value.bytes,
      treeDigestSha256: computedState.value.treeDigestSha256,
    },
    evidence: {
      consistency: sourceEvidence.value.consistency,
      sourceObservedAtMs: sourceEvidence.value.observedAtMs,
      targetObservedAtMs: targetEvidence.value.observedAtMs,
      itemCount: evidenceParity.value.itemCount,
      gapCount: evidenceParity.value.gapCount,
    },
  });
}

function assemble(
  request: ProductionReplayBundleAssemblyRequest,
  decrypted: DecryptedProductionVaultBlob[],
): Result<ProductionReplayBundleAssembly, ProductionReplayBundleAssemblyError> {
  const inventory = decryptInventory(request, decrypted);
  if (!inventory.ok) return inventory;
  const facts = reconcileInventory(request.unsignedManifest, inventory.value);
  if (!facts.ok) return facts;
  const authorityFacts = reconcileAuthorities(request, inventory.value);
  if (!authorityFacts.ok) return authorityFacts;

  const sealed = sealProductionReplayBundleManifest(request.unsignedManifest, request.sealKey);
  if (!sealed.ok) {
    return err({
      kind: "bundle_seal_failed",
      message: "Production replay bundle claims failed validation before sealing",
    });
  }
  return ok({
    manifest: sealed.value,
    artifacts: facts.value,
    ...authorityFacts.value,
  });
}

export function assembleProductionReplayBundle(
  request: ProductionReplayBundleAssemblyRequest,
): Result<ProductionReplayBundleAssembly, ProductionReplayBundleAssemblyError> {
  const decrypted: DecryptedProductionVaultBlob[] = [];
  // The typed assembler is a private-content boundary. Runtime callers may still pass
  // decoded untyped input, so translate any shape failure immediately to a content-free Result.
  const attempted = tryCatch(() => assemble(request, decrypted));
  const result: Result<ProductionReplayBundleAssembly, ProductionReplayBundleAssemblyError> =
    attempted.ok
      ? attempted.value
      : err({
          kind: "bundle_seal_failed",
          message: "Production replay bundle claims failed validation before sealing",
        });
  for (const artifact of decrypted) artifact.plaintext.fill(0);
  return result;
}
