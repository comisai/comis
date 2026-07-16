// SPDX-License-Identifier: Apache-2.0
import { createHash, createPublicKey } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

const MAX_BLUEPRINT_BYTES = 32 * 1024;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_HISTORY_EVENTS = 256;
const MAX_RUN_ID_BYTES = 128;
const MAX_LEASE_MS = 120_000;
const MAX_RETENTION_MS = 86_400_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ATTEMPT_ID_RE = /^[a-f0-9]{32}$/u;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CHALLENGE_NONCE_RE = /^[A-Za-z0-9+/]{43}=$/u;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/u;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/u;
const MAX_PUBLIC_KEY_DER_BYTES = 128;

const AUTHORIZATION_ROLE_KEY_FIELDS = Object.freeze([
  Object.freeze({
    role: "operator" as const,
    keyIdField: "operatorSigningKeyIdSha256" as const,
    publicKeyField: "operatorSigningPublicKeyDerBase64" as const,
  }),
  Object.freeze({
    role: "controller" as const,
    keyIdField: "controllerSigningKeyIdSha256" as const,
    publicKeyField: "controllerSigningPublicKeyDerBase64" as const,
  }),
  Object.freeze({
    role: "source" as const,
    keyIdField: "sourceSigningKeyIdSha256" as const,
    publicKeyField: "sourceSigningPublicKeyDerBase64" as const,
  }),
  Object.freeze({
    role: "target" as const,
    keyIdField: "targetSigningKeyIdSha256" as const,
    publicKeyField: "targetSigningPublicKeyDerBase64" as const,
  }),
  Object.freeze({
    role: "destruction" as const,
    keyIdField: "destructionSigningKeyIdSha256" as const,
    publicKeyField: "destructionSigningPublicKeyDerBase64" as const,
  }),
] as const);

type AuthorizationRole = (typeof AUTHORIZATION_ROLE_KEY_FIELDS)[number]["role"];

export const PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES = Object.freeze([
  "target_challenge_issue",
  "target_challenge_expire",
  "operator_grant_record",
  "controller_grant_record",
  "target_challenge_consume",
  "target_capture_authorize_and_begin",
  "source_capture_consume_under_stop_lease",
  "source_capture_resume_same_staging",
  "source_manifest_attest",
  "source_bind_exact_manifest_state_tree_ciphertext_and_staging",
  "target_transfer_authorize_and_begin",
  "target_receive_encrypted_staging",
  "target_verify_source_manifest_attestation",
  "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding",
  "target_restore_verified_state_to_quarantine",
  "target_promote_restored_state",
  "target_finalize",
  "target_abort",
  "target_destroy_and_attest",
] as const);

export type ProductionLiveCopyDurableStage =
  (typeof PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES)[number];

export const PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS = Object.freeze([
  "immutable_authority_pin_store_not_implemented",
  "trusted_time_signature_verification_authority_not_implemented",
  "global_durable_replay_prevention_authority_not_implemented",
  "external_monotonic_artifact_use_registry_not_implemented",
  "artifact_signature_verification_authority_not_implemented",
  "receipt_signature_verification_authority_not_implemented",
  "target_recipient_key_possession_signature_verification_not_implemented",
  "durable_target_challenge_issue_not_implemented",
  "durable_target_challenge_expiry_not_implemented",
  "durable_target_challenge_consume_not_implemented",
  "durable_operator_grant_not_implemented",
  "durable_controller_grant_not_implemented",
  "target_capture_authority_transaction_not_implemented",
  "source_stop_lease_capture_transaction_not_implemented",
  "resumable_encrypted_source_staging_not_implemented",
  "source_manifest_attestation_authority_not_implemented",
  "exact_manifest_state_tree_ciphertext_staging_binding_not_implemented",
  "target_transfer_authority_transaction_not_implemented",
  "target_source_manifest_attestation_verification_not_implemented",
  "target_manifest_attestation_verification_not_implemented",
  "target_restore_transaction_not_integrated",
  "durable_atomic_lifecycle_transition_store_not_implemented",
  "durable_sequence_head_no_fork_store_not_implemented",
  "destruction_receipt_authority_not_implemented",
] as const);

export const PRODUCTION_LIVE_COPY_ARTIFACT_USE_REGISTRY_AUTHORITY_PIN_PATHS =
  Object.freeze([
    "artifactUseRegistryStoreIdentitySha256",
    "artifactUseRegistryStoreHeadDigestSha256",
    "artifactUseRegistrySigningKeyIdSha256",
  ] as const);

export const PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS = Object.freeze([
  "source.immutableMachineTrustRootStoreIdentitySha256",
  "source.immutableMachineTrustRootHeadDigestSha256",
  "target.immutableMachineTrustRootStoreIdentitySha256",
  "target.immutableMachineTrustRootHeadDigestSha256",
  "operatorTrustRootStoreIdentitySha256",
  "operatorTrustRootHeadDigestSha256",
  "controllerTrustRootStoreIdentitySha256",
  "controllerTrustRootHeadDigestSha256",
  "targetAuthorityStoreIdentitySha256",
  "targetAuthorityStoreHeadDigestSha256",
  "sourceAuthorityStoreIdentitySha256",
  "sourceAuthorityStoreHeadDigestSha256",
  "sequenceAuthorityStoreIdentitySha256",
  "sequenceAuthorityStoreHeadDigestSha256",
  "trustedTimeAuthorityStoreIdentitySha256",
  "trustedTimeAuthorityStoreHeadDigestSha256",
  "trustedTimeSigningKeyIdSha256",
  ...PRODUCTION_LIVE_COPY_ARTIFACT_USE_REGISTRY_AUTHORITY_PIN_PATHS,
  "retentionPolicy.destructionAuthorityStoreIdentitySha256",
  "retentionPolicy.destructionAuthorityStoreHeadDigestSha256",
] as const);

export const PRODUCTION_LIVE_COPY_TARGET_RECIPIENT_POSSESSION_AUTHORITY_CONTRACT =
  Object.freeze({
    receiptSignerKeyIdField:
      "targetRecipientKeyPossessionSignerKeyIdSha256" as const,
    blueprintSignerKeyIdPath:
      "target.recipientKeyPossessionSignerKeyIdSha256" as const,
    authorityStoreIdentityPinPath:
      "target.immutableMachineTrustRootStoreIdentitySha256" as const,
    authorityStoreHeadDigestPinPath:
      "target.immutableMachineTrustRootHeadDigestSha256" as const,
    authorizationRule:
      "require_signer_membership_at_exact_pinned_target_machine_trust_root_head" as const,
  });

export const PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS = Object.freeze([
  "source.machineIdentityDigestSha256",
  "source.endpointAttestationDigestSha256",
  "source.endpointAttestationGenerationSha256",
  "source.serviceCommitmentSha256",
  "source.dataDirCommitmentSha256",
  "source.immutableMachineTrustRootStoreIdentitySha256",
  "source.immutableMachineTrustRootHeadDigestSha256",
  "target.machineIdentityDigestSha256",
  "target.endpointAttestationDigestSha256",
  "target.endpointAttestationGenerationSha256",
  "target.serviceCommitmentSha256",
  "target.dataDirCommitmentSha256",
  "target.recipientKeyPossessionAttestationDigestSha256",
  "target.recipientKeyPossessionSignedPayloadDigestSha256",
  "target.recipientKeyPossessionSignerKeyIdSha256",
  "target.immutableMachineTrustRootStoreIdentitySha256",
  "target.immutableMachineTrustRootHeadDigestSha256",
  "operatorTrustRootStoreIdentitySha256",
  "operatorTrustRootHeadDigestSha256",
  "controllerTrustRootStoreIdentitySha256",
  "controllerTrustRootHeadDigestSha256",
  "targetAuthorityStoreIdentitySha256",
  "targetAuthorityStoreHeadDigestSha256",
  "sourceAuthorityStoreIdentitySha256",
  "sourceAuthorityStoreHeadDigestSha256",
  "sequenceAuthorityStoreIdentitySha256",
  "sequenceAuthorityStoreHeadDigestSha256",
  "trustedTimeAuthorityStoreIdentitySha256",
  "trustedTimeAuthorityStoreHeadDigestSha256",
  "trustedTimeSigningKeyIdSha256",
  "artifactUseRegistryStoreIdentitySha256",
  "artifactUseRegistryStoreHeadDigestSha256",
  "artifactUseRegistrySigningKeyIdSha256",
  "retentionPolicy.destructionAuthorityStoreIdentitySha256",
  "retentionPolicy.destructionAuthorityStoreHeadDigestSha256",
  "sourceStoppedGenerationSha256",
  "sourceStopLeaseIdentitySha256",
  "targetQuarantineGenerationSha256",
  "targetQuarantineLeaseIdentitySha256",
  "encryptionRecipientKeyIdSha256",
  "operatorSigningKeyIdSha256",
  "controllerSigningKeyIdSha256",
  "sourceSigningKeyIdSha256",
  "targetSigningKeyIdSha256",
  "destructionSigningKeyIdSha256",
  "stagingNamespaceDigestSha256",
] as const);

const COMMON_BINDING_FIELDS = [
  "schema",
  "schemaVersion",
  "artifactKind",
  "bindingSetDigestSha256",
  "blueprintDigestSha256",
  "runId",
  "attemptId",
  "targetChallengeDigestSha256",
  "sourceEndpointAttestationDigestSha256",
  "targetEndpointAttestationDigestSha256",
  "sourceMachineTrustRootHeadDigestSha256",
  "targetMachineTrustRootHeadDigestSha256",
  "operatorTrustRootHeadDigestSha256",
  "controllerTrustRootHeadDigestSha256",
  "targetAuthorityStoreHeadDigestSha256",
  "sourceAuthorityStoreHeadDigestSha256",
  "sequenceAuthorityStoreHeadDigestSha256",
  "trustedTimeAuthorityStoreHeadDigestSha256",
  "trustedTimeSigningKeyIdSha256",
  "destructionAuthorityStoreHeadDigestSha256",
  "sourceEndpointAttestationGenerationSha256",
  "targetEndpointAttestationGenerationSha256",
  "sourceStoppedGenerationSha256",
  "sourceStopLeaseIdentitySha256",
  "sourceStopLeaseDeadlineUnixMs",
  "targetQuarantineGenerationSha256",
  "targetQuarantineLeaseIdentitySha256",
  "targetQuarantineLeaseDeadlineUnixMs",
  "encryptionRecipientKeyIdSha256",
  "targetRecipientKeyPossessionAttestationDigestSha256",
  "targetRecipientKeyPossessionSignedPayloadDigestSha256",
  "targetRecipientKeyPossessionSignerKeyIdSha256",
  "scope",
  "issuedAtUnixMs",
  "issuanceTimeReceiptDigestSha256",
  "captureAuthorizationDeadlineUnixMs",
  "transferAuthorizationDeadlineUnixMs",
  "retentionDestructionDeadlineUnixMs",
  "sequencePredecessorDigestSha256",
  "sequenceHeadDigestSha256",
  "sequenceNoForkProofDigestSha256",
  "stagingNamespaceDigestSha256",
  "signerKeyIdSha256",
  "signatureBase64",
] as const;

export const PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS = Object.freeze({
  operatorGrant: Object.freeze([
    ...COMMON_BINDING_FIELDS,
    "grantorIdentityDigestSha256",
    "sourceAttestationContractDigestSha256",
    "targetAttestationContractDigestSha256",
    "sourceSnapshotManifestBindingContractDigestSha256",
    "sourceStateTreeBindingContractDigestSha256",
    "encryptedCiphertextBindingContractDigestSha256",
  ] as const),
  controllerGrant: Object.freeze([
    ...COMMON_BINDING_FIELDS,
    "grantorIdentityDigestSha256",
    "operatorGrantDigestSha256",
    "sourceAttestationContractDigestSha256",
    "targetAttestationContractDigestSha256",
    "sourceSnapshotManifestBindingContractDigestSha256",
    "sourceStateTreeBindingContractDigestSha256",
    "encryptedCiphertextBindingContractDigestSha256",
  ] as const),
  sourceAttestation: Object.freeze([
    ...COMMON_BINDING_FIELDS,
    "operatorGrantDigestSha256",
    "controllerGrantDigestSha256",
    "sourceSnapshotManifestDigestSha256",
    "sourceStateTreeDigestSha256",
    "encryptedCiphertextDigestSha256",
  ] as const),
  targetAttestation: Object.freeze([
    ...COMMON_BINDING_FIELDS,
    "operatorGrantDigestSha256",
    "controllerGrantDigestSha256",
    "sourceAttestationDigestSha256",
    "sourceSnapshotManifestDigestSha256",
    "sourceStateTreeDigestSha256",
    "encryptedCiphertextDigestSha256",
    "targetVerificationResultDigestSha256",
  ] as const),
} as const);

const ARTIFACT_AUTHENTICATION_FIELDS = Object.freeze([
  "schema",
  "schemaVersion",
  "runId",
  "attemptId",
  "stage",
  "kind",
  "digestSha256",
  "subjectKind",
  "subjectDigestSha256",
  "predecessorArtifactKind",
  "predecessorArtifactDigestSha256",
  "recoverySequence",
  "recoveryGenerationSha256",
  "previousRecoveryArtifactDigestSha256",
  "createdSensitiveSubjects",
  "cleanupSubjects",
  "cleanupInventoryDigestSha256",
  "cleanupAttestations",
  "authenticationKind",
  "signerRole",
  "signerKeyIdSha256",
  "signedPayloadDigestSha256",
  "signatureBase64",
] as const);

export const PRODUCTION_LIVE_COPY_REQUIRED_ARTIFACT_SCHEMAS = Object.freeze({
  challenge: Object.freeze({ stage: "target_challenge_issue", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  challenge_expiry: Object.freeze({ stage: "target_challenge_expire", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  operator_grant: Object.freeze({ stage: "operator_grant_record", signerRole: "operator", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  controller_grant: Object.freeze({ stage: "controller_grant_record", signerRole: "controller", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  challenge_consumption: Object.freeze({ stage: "target_challenge_consume", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  capture_authorization: Object.freeze({ stage: "target_capture_authorize_and_begin", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  source_capture_staging: Object.freeze({ stage: "source_capture_consume_under_stop_lease", signerRole: "source", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  recovery_contract: Object.freeze({ stage: "source_capture_resume_same_staging", signerRole: "source", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  source_attestation: Object.freeze({ stage: "source_manifest_attest", signerRole: "source", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  source_binding: Object.freeze({ stage: "source_bind_exact_manifest_state_tree_ciphertext_and_staging", signerRole: "source", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  transfer_authorization: Object.freeze({ stage: "target_transfer_authorize_and_begin", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  encrypted_staging_receipt: Object.freeze({ stage: "target_receive_encrypted_staging", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  source_manifest_verification: Object.freeze({ stage: "target_verify_source_manifest_attestation", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  target_attestation: Object.freeze({ stage: "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  quarantine_restore: Object.freeze({ stage: "target_restore_verified_state_to_quarantine", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  promotion: Object.freeze({ stage: "target_promote_restored_state", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  abort: Object.freeze({ stage: "target_abort", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  finalization: Object.freeze({ stage: "target_finalize", signerRole: "target", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
  destruction_attestation: Object.freeze({ stage: "target_destroy_and_attest", signerRole: "destruction", fields: ARTIFACT_AUTHENTICATION_FIELDS }),
} as const);

const RECEIPT_FIELDS = Object.freeze([
  "schema",
  "schemaVersion",
  "kind",
  "runId",
  "attemptId",
  "stage",
  "sequence",
  "authorityStoreIdentitySha256",
  "authorityStoreHeadDigestSha256",
  "sequenceAuthorityStoreIdentitySha256",
  "sequenceAuthorityStoreHeadDigestSha256",
  "sequencePredecessorDigestSha256",
  "sequenceHeadDigestSha256",
  "sourceStoppedGenerationSha256",
  "sourceStopLeaseIdentitySha256",
  "sourceStopLeaseDeadlineUnixMs",
  "targetQuarantineGenerationSha256",
  "targetQuarantineLeaseIdentitySha256",
  "targetQuarantineLeaseDeadlineUnixMs",
  "encryptionRecipientKeyIdSha256",
  "targetRecipientKeyPossessionAttestationDigestSha256",
  "targetRecipientKeyPossessionSignedPayloadDigestSha256",
  "targetRecipientKeyPossessionSignerKeyIdSha256",
  "artifactKind",
  "artifactDigestSha256",
  "subjectKind",
  "subjectDigestSha256",
  "predecessorArtifactKind",
  "predecessorArtifactDigestSha256",
  "observedAtUnixMs",
  "trustedTimeAuthorityStoreIdentitySha256",
  "trustedTimeAuthorityStoreHeadDigestSha256",
  "trustedTimeReceiptDigestSha256",
  "authenticationKind",
  "signerRole",
  "signerKeyIdSha256",
  "signedPayloadDigestSha256",
  "signatureBase64",
  "trustedTimeAuthenticationKind",
  "trustedTimeSignerKeyIdSha256",
  "trustedTimeSignedPayloadDigestSha256",
  "trustedTimeSignatureBase64",
  "receiptDigestSha256",
] as const);

export const PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS = Object.freeze({
  challenge: RECEIPT_FIELDS,
  authorization: RECEIPT_FIELDS,
  recovery: RECEIPT_FIELDS,
  receive: RECEIPT_FIELDS,
  restore: RECEIPT_FIELDS,
  promotion: RECEIPT_FIELDS,
  abort: RECEIPT_FIELDS,
  finalize: RECEIPT_FIELDS,
  destruction: RECEIPT_FIELDS,
} as const);

export type ProductionLiveCopyReceiptKind =
  keyof typeof PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS;

export const PRODUCTION_LIVE_COPY_DURABLE_LIFECYCLE = Object.freeze({
  challengeSuccessfulPath: Object.freeze([
    "target_challenge_issue",
    "operator_grant_record",
    "controller_grant_record",
    "target_challenge_consume",
    "target_capture_authorize_and_begin",
  ] as const),
  challengeExpiredTerminalPaths: Object.freeze([
    Object.freeze(["target_challenge_issue", "target_challenge_expire"] as const),
    Object.freeze([
      "target_challenge_issue",
      "operator_grant_record",
      "target_challenge_expire",
    ] as const),
    Object.freeze([
      "target_challenge_issue",
      "operator_grant_record",
      "controller_grant_record",
      "target_challenge_expire",
    ] as const),
  ] as const),
  sourceCaptureUninterruptedPath: Object.freeze([
    "source_capture_consume_under_stop_lease",
    "source_manifest_attest",
    "source_bind_exact_manifest_state_tree_ciphertext_and_staging",
  ] as const),
  sourceCaptureRecoveryPath: Object.freeze([
    "source_capture_consume_under_stop_lease",
    "source_capture_resume_same_staging",
    "source_manifest_attest",
    "source_bind_exact_manifest_state_tree_ciphertext_and_staging",
  ] as const),
  targetRestoreSuccessfulPath: Object.freeze([
    "target_transfer_authorize_and_begin",
    "target_receive_encrypted_staging",
    "target_verify_source_manifest_attestation",
    "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding",
    "target_restore_verified_state_to_quarantine",
    "target_promote_restored_state",
    "target_finalize",
  ] as const),
  restoreTransactionTerminalStages: Object.freeze([
    "target_finalize",
    "target_abort",
  ] as const),
  retainedCopyTerminalStage: "target_destroy_and_attest" as const,
});

export const PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS = Object.freeze({
  authorizationKeyMaterial: "comis-production-live-copy-ed25519-public-key-v1",
  authorizationRoleKeyId: "comis-production-live-copy-authorization-key-id-v1",
  issuanceTime: "comis-production-live-copy-issued-time-v1",
  observedTime: "comis-production-live-copy-observed-time-v1",
  auditTime: "comis-production-live-copy-audit-time-v1",
  recipientPossession: "comis-production-live-copy-recipient-possession-v1",
  authenticatedEnvelope: "comis-production-live-copy-authenticated-envelope-v1",
  artifactPayload: "comis-production-live-copy-artifact-payload-v1",
  artifact: "comis-production-live-copy-artifact-v1",
  cleanupInventory: "comis-production-live-copy-cleanup-inventory-v1",
  cleanupAttestation: "comis-production-live-copy-cleanup-attestation-v1",
  receiptHead: "comis-production-live-copy-receipt-head-v1",
  receipt: "comis-production-live-copy-stage-receipt-v1",
  event: "comis-production-live-copy-lifecycle-event-v1",
  noFork: "comis-production-live-copy-lifecycle-no-fork-v1",
  globalReplay: "comis-production-live-copy-global-replay-v1",
  artifactUseSet: "comis-production-live-copy-artifact-use-set-v1",
  artifactUseRegistryHead: "comis-production-live-copy-artifact-use-registry-head-v1",
} as const);

export const PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT = Object.freeze({
  mode: "external_atomic_artifact_registry_compare_append" as const,
  scope: "all_histories_and_attempts" as const,
  keyFields: Object.freeze([
    "challengeDigestSha256",
    "sourceStoppedGenerationSha256",
    "sourceStopLeaseIdentitySha256",
    "targetQuarantineGenerationSha256",
    "targetQuarantineLeaseIdentitySha256",
    "encryptionRecipientKeyIdSha256",
    "stagingNamespaceDigestSha256",
  ] as const),
  authorityPinPaths:
    PRODUCTION_LIVE_COPY_ARTIFACT_USE_REGISTRY_AUTHORITY_PIN_PATHS,
  identityClasses: Object.freeze([
    "artifact",
    "ciphertext",
    "receipt",
    "attestation",
    "finalization",
    "destruction",
    "sensitive_subject",
    "event",
    "authority_generation",
  ] as const),
  requiredInvariants: Object.freeze([
    "no_cross_attempt_artifact_reuse",
    "no_sibling_head_forks",
    "no_entry_deletion_or_rollback",
    "compare_exact_external_predecessor_head",
  ] as const),
  requiredOperation:
    "atomically_reserve_every_unused_identity_and_compare_append_registry_head" as const,
  reusePolicy: "deny_every_identity_forever_across_histories_and_attempts" as const,
});

export interface ProductionLiveCopyEndpointBlueprint {
  readonly role: "production" | "test";
  readonly machineIdentityDigestSha256: string;
  readonly endpointAttestationDigestSha256: string;
  readonly serviceCommitmentSha256: string;
  readonly dataDirCommitmentSha256: string;
  readonly endpointAttestationGenerationSha256: string;
  readonly recipientKeyPossessionAttestationDigestSha256: string | null;
  readonly recipientKeyPossessionSignedPayloadDigestSha256: string | null;
  readonly recipientKeyPossessionSignerKeyIdSha256: string | null;
  readonly recipientKeyPossessionAuthenticationKind: "ed25519_signature" | null;
  readonly recipientKeyPossessionSignatureBase64: string | null;
  readonly immutableMachineTrustRootStoreIdentitySha256: string;
  readonly immutableMachineTrustRootHeadDigestSha256: string;
}

export interface ProductionLiveCopyRetentionPolicy {
  readonly destructionDeadlineUnixMs: number;
  readonly destructionRequired: true;
  readonly destructionAuthorityStoreIdentitySha256: string;
  readonly destructionAuthorityStoreHeadDigestSha256: string;
}

export interface ProductionLiveCopyBlueprint {
  readonly schema: "comis-production-live-copy-blueprint";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly challengeNonceBase64: string;
  readonly source: ProductionLiveCopyEndpointBlueprint & {
    readonly role: "production";
    readonly recipientKeyPossessionAttestationDigestSha256: null;
    readonly recipientKeyPossessionSignedPayloadDigestSha256: null;
    readonly recipientKeyPossessionSignerKeyIdSha256: null;
    readonly recipientKeyPossessionAuthenticationKind: null;
    readonly recipientKeyPossessionSignatureBase64: null;
  };
  readonly target: ProductionLiveCopyEndpointBlueprint & {
    readonly role: "test";
    readonly recipientKeyPossessionAttestationDigestSha256: string;
    readonly recipientKeyPossessionSignedPayloadDigestSha256: string;
    readonly recipientKeyPossessionSignerKeyIdSha256: string;
    readonly recipientKeyPossessionAuthenticationKind: "ed25519_signature";
    readonly recipientKeyPossessionSignatureBase64: string;
  };
  readonly operatorTrustRootStoreIdentitySha256: string;
  readonly operatorTrustRootHeadDigestSha256: string;
  readonly controllerTrustRootStoreIdentitySha256: string;
  readonly controllerTrustRootHeadDigestSha256: string;
  readonly targetAuthorityStoreIdentitySha256: string;
  readonly targetAuthorityStoreHeadDigestSha256: string;
  readonly sourceAuthorityStoreIdentitySha256: string;
  readonly sourceAuthorityStoreHeadDigestSha256: string;
  readonly sequenceAuthorityStoreIdentitySha256: string;
  readonly sequenceAuthorityStoreHeadDigestSha256: string;
  readonly trustedTimeAuthorityStoreIdentitySha256: string;
  readonly trustedTimeAuthorityStoreHeadDigestSha256: string;
  readonly trustedTimeSigningKeyIdSha256: string;
  readonly artifactUseRegistryStoreIdentitySha256: string;
  readonly artifactUseRegistryStoreHeadDigestSha256: string;
  readonly artifactUseRegistrySigningKeyIdSha256: string;
  readonly sourceStoppedGenerationSha256: string;
  readonly sourceStopLeaseIdentitySha256: string;
  readonly sourceStopLeaseDeadlineUnixMs: number;
  readonly targetQuarantineGenerationSha256: string;
  readonly targetQuarantineLeaseIdentitySha256: string;
  readonly targetQuarantineLeaseDeadlineUnixMs: number;
  readonly encryptionRecipientKeyIdSha256: string;
  readonly operatorSigningKeyIdSha256: string;
  readonly operatorSigningPublicKeyDerBase64: string;
  readonly controllerSigningKeyIdSha256: string;
  readonly controllerSigningPublicKeyDerBase64: string;
  readonly sourceSigningKeyIdSha256: string;
  readonly sourceSigningPublicKeyDerBase64: string;
  readonly targetSigningKeyIdSha256: string;
  readonly targetSigningPublicKeyDerBase64: string;
  readonly destructionSigningKeyIdSha256: string;
  readonly destructionSigningPublicKeyDerBase64: string;
  readonly stagingNamespaceDigestSha256: string;
  readonly issuedAtUnixMs: number;
  readonly issuanceTimeSignedPayloadDigestSha256: string;
  readonly issuanceTimeAuthenticationKind: "ed25519_signature";
  readonly issuanceTimeSignatureBase64: string;
  readonly issuanceTimeReceiptDigestSha256: string;
  readonly captureAuthorizationDeadlineUnixMs: number;
  readonly transferAuthorizationDeadlineUnixMs: number;
  readonly retentionPolicy: ProductionLiveCopyRetentionPolicy;
  readonly maximumCaptureAuthorizationLeaseMs: number;
  readonly maximumTransferAuthorizationLeaseMs: number;
  readonly maximumSourceStopLeaseMs: number;
  readonly maximumTargetQuarantineLeaseMs: number;
  readonly captureMode: "offline";
  readonly scope: "offline_full_state_and_source_secrets";
  readonly operationalStatus: "schema_only";
  readonly exactExecutionEligible: false;
}

export interface InvalidProductionLiveCopyBlueprintError {
  readonly kind: "invalid_blueprint";
  readonly field: string;
  readonly message: string;
}

export interface ProductionLiveCopyEndpointsNotSeparateError {
  readonly kind: "endpoints_not_separate";
  readonly message: string;
}

export type ProductionLiveCopyBlueprintError =
  | InvalidProductionLiveCopyBlueprintError
  | ProductionLiveCopyEndpointsNotSeparateError;

export interface ProductionLiveCopyOperationallyIneligibleError {
  readonly kind: "operationally_ineligible";
  readonly exactExecutionEligible: false;
  readonly blockers: typeof PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS;
  readonly requiredDurableStages: typeof PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES;
  readonly durableLifecycle: typeof PRODUCTION_LIVE_COPY_DURABLE_LIFECYCLE;
  readonly requiredBindingSchemas: typeof PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS;
  readonly requiredArtifactSchemas: typeof PRODUCTION_LIVE_COPY_REQUIRED_ARTIFACT_SCHEMAS;
  readonly requiredReceiptSchemas: typeof PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS;
  readonly requiredAuthorityPinPaths: typeof PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS;
  readonly requiredRoleDisjointPaths: typeof PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS;
  readonly globalReplayPreventionContract: typeof PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT;
  readonly message: string;
}

export type ProductionLiveCopyReadinessError =
  | ProductionLiveCopyBlueprintError
  | ProductionLiveCopyOperationallyIneligibleError;

type JsonPrimitive = string | number | boolean | null;
type ParsedJson = JsonPrimitive | ParsedJsonRecord | readonly ParsedJson[];
interface ParsedJsonRecord {
  readonly [key: string]: ParsedJson;
}
type ExactParsedRecord<Keys extends readonly string[]> = Readonly<
  Record<Keys[number], ParsedJson>
>;

interface CanonicalInputError {
  readonly field: "boundary" | "canonical";
  readonly message: string;
}

const TOP_LEVEL_KEYS = [
  "schema",
  "schemaVersion",
  "runId",
  "attemptId",
  "challengeNonceBase64",
  "source",
  "target",
  "operatorTrustRootStoreIdentitySha256",
  "operatorTrustRootHeadDigestSha256",
  "controllerTrustRootStoreIdentitySha256",
  "controllerTrustRootHeadDigestSha256",
  "targetAuthorityStoreIdentitySha256",
  "targetAuthorityStoreHeadDigestSha256",
  "sourceAuthorityStoreIdentitySha256",
  "sourceAuthorityStoreHeadDigestSha256",
  "sequenceAuthorityStoreIdentitySha256",
  "sequenceAuthorityStoreHeadDigestSha256",
  "trustedTimeAuthorityStoreIdentitySha256",
  "trustedTimeAuthorityStoreHeadDigestSha256",
  "trustedTimeSigningKeyIdSha256",
  "artifactUseRegistryStoreIdentitySha256",
  "artifactUseRegistryStoreHeadDigestSha256",
  "artifactUseRegistrySigningKeyIdSha256",
  "sourceStoppedGenerationSha256",
  "sourceStopLeaseIdentitySha256",
  "sourceStopLeaseDeadlineUnixMs",
  "targetQuarantineGenerationSha256",
  "targetQuarantineLeaseIdentitySha256",
  "targetQuarantineLeaseDeadlineUnixMs",
  "encryptionRecipientKeyIdSha256",
  "operatorSigningKeyIdSha256",
  "operatorSigningPublicKeyDerBase64",
  "controllerSigningKeyIdSha256",
  "controllerSigningPublicKeyDerBase64",
  "sourceSigningKeyIdSha256",
  "sourceSigningPublicKeyDerBase64",
  "targetSigningKeyIdSha256",
  "targetSigningPublicKeyDerBase64",
  "destructionSigningKeyIdSha256",
  "destructionSigningPublicKeyDerBase64",
  "stagingNamespaceDigestSha256",
  "issuedAtUnixMs",
  "issuanceTimeSignedPayloadDigestSha256",
  "issuanceTimeAuthenticationKind",
  "issuanceTimeSignatureBase64",
  "issuanceTimeReceiptDigestSha256",
  "captureAuthorizationDeadlineUnixMs",
  "transferAuthorizationDeadlineUnixMs",
  "retentionPolicy",
  "maximumCaptureAuthorizationLeaseMs",
  "maximumTransferAuthorizationLeaseMs",
  "maximumSourceStopLeaseMs",
  "maximumTargetQuarantineLeaseMs",
  "captureMode",
  "scope",
  "operationalStatus",
  "exactExecutionEligible",
] as const;

const ENDPOINT_KEYS = [
  "role",
  "machineIdentityDigestSha256",
  "endpointAttestationDigestSha256",
  "serviceCommitmentSha256",
  "dataDirCommitmentSha256",
  "endpointAttestationGenerationSha256",
  "recipientKeyPossessionAttestationDigestSha256",
  "recipientKeyPossessionSignedPayloadDigestSha256",
  "recipientKeyPossessionSignerKeyIdSha256",
  "recipientKeyPossessionAuthenticationKind",
  "recipientKeyPossessionSignatureBase64",
  "immutableMachineTrustRootStoreIdentitySha256",
  "immutableMachineTrustRootHeadDigestSha256",
] as const;

const RETENTION_POLICY_KEYS = [
  "destructionDeadlineUnixMs",
  "destructionRequired",
  "destructionAuthorityStoreIdentitySha256",
  "destructionAuthorityStoreHeadDigestSha256",
] as const;

const TOP_DIGEST_FIELDS = [
  "operatorTrustRootStoreIdentitySha256",
  "operatorTrustRootHeadDigestSha256",
  "controllerTrustRootStoreIdentitySha256",
  "controllerTrustRootHeadDigestSha256",
  "targetAuthorityStoreIdentitySha256",
  "targetAuthorityStoreHeadDigestSha256",
  "sourceAuthorityStoreIdentitySha256",
  "sourceAuthorityStoreHeadDigestSha256",
  "sequenceAuthorityStoreIdentitySha256",
  "sequenceAuthorityStoreHeadDigestSha256",
  "trustedTimeAuthorityStoreIdentitySha256",
  "trustedTimeAuthorityStoreHeadDigestSha256",
  "trustedTimeSigningKeyIdSha256",
  "artifactUseRegistryStoreIdentitySha256",
  "artifactUseRegistryStoreHeadDigestSha256",
  "artifactUseRegistrySigningKeyIdSha256",
  "sourceStoppedGenerationSha256",
  "sourceStopLeaseIdentitySha256",
  "targetQuarantineGenerationSha256",
  "targetQuarantineLeaseIdentitySha256",
  "encryptionRecipientKeyIdSha256",
  "operatorSigningKeyIdSha256",
  "controllerSigningKeyIdSha256",
  "sourceSigningKeyIdSha256",
  "targetSigningKeyIdSha256",
  "destructionSigningKeyIdSha256",
  "stagingNamespaceDigestSha256",
  "issuanceTimeSignedPayloadDigestSha256",
  "issuanceTimeReceiptDigestSha256",
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: ParsedJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function parseCanonicalJsonLine(
  raw: unknown,
  maximumBytes: number,
): Result<ParsedJson, CanonicalInputError> {
  if (typeof raw !== "string") {
    return err({ field: "boundary", message: "Input must be immutable canonical JSON text" });
  }
  if (
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > maximumBytes ||
    !raw.endsWith("\n") ||
    raw.indexOf("\n") !== raw.length - 1 ||
    raw.includes("\r") ||
    raw.includes("\0")
  ) {
    return err({ field: "canonical", message: "Input must be one bounded canonical JSON line" });
  }
  const parsed = tryCatch(() => JSON.parse(raw.slice(0, -1)) as ParsedJson);
  return parsed.ok
    ? parsed
    : err({ field: "canonical", message: "Input JSON is invalid" });
}

function invalidBlueprint(
  field: string,
  message: string,
): InvalidProductionLiveCopyBlueprintError {
  return Object.freeze({ kind: "invalid_blueprint", field, message });
}

function exactParsedRecord<const Keys extends readonly string[]>(
  raw: ParsedJson,
  keys: Keys,
  field: string,
): Result<ExactParsedRecord<Keys>, InvalidProductionLiveCopyBlueprintError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(invalidBlueprint(field, `${field} must be a JSON object`));
  }
  const actual = Object.keys(raw);
  const expected = new Set<string>(keys);
  return actual.length === keys.length && actual.every((key) => expected.has(key))
    ? ok(raw as ExactParsedRecord<Keys>)
    : err(invalidBlueprint(field, `${field} must contain exactly the schema keys`));
}

function requireLiteral<T extends string | number | boolean>(
  raw: ParsedJson,
  literal: T,
  field: string,
): Result<T, InvalidProductionLiveCopyBlueprintError> {
  return raw === literal
    ? ok(literal)
    : err(invalidBlueprint(field, `${field} must equal its schema literal`));
}

function requireSha256(
  raw: ParsedJson,
  field: string,
): Result<string, InvalidProductionLiveCopyBlueprintError> {
  return typeof raw === "string" && SHA256_RE.test(raw)
    ? ok(raw)
    : err(invalidBlueprint(field, `${field} must be a lowercase SHA-256 digest`));
}

function requirePositiveInteger(
  raw: ParsedJson,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): Result<number, InvalidProductionLiveCopyBlueprintError> {
  return typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    raw > 0 &&
    raw <= maximum
    ? ok(raw)
    : err(invalidBlueprint(field, `${field} must be a positive bounded safe integer`));
}

function isCanonicalSignatureBase64(raw: ParsedJson): raw is string {
  if (typeof raw !== "string" || !SIGNATURE_RE.test(raw)) return false;
  const decoded = Buffer.from(raw, "base64");
  return decoded.byteLength === SIGNATURE_BYTES && decoded.toString("base64") === raw;
}

function requireSignatureBase64(
  raw: ParsedJson,
  field: string,
): Result<string, InvalidProductionLiveCopyBlueprintError> {
  return isCanonicalSignatureBase64(raw)
    ? ok(raw)
    : err(invalidBlueprint(field, `${field} must be a canonical 64-byte signature`));
}

interface AuthorizationRoleKeyMaterial {
  readonly publicKeyDerBase64: string;
  readonly fingerprintSha256: string;
}

function authorizationKeyMaterialFingerprint(der: Uint8Array): string {
  return createHash("sha256")
    .update(PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authorizationKeyMaterial)
    .update("\0")
    .update(der)
    .digest("hex");
}

function authorizationRoleKeyId(
  role: AuthorizationRole,
  fingerprintSha256: string,
): string {
  return sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authorizationRoleKeyId}\0${role}\0${fingerprintSha256}`,
  );
}

function requireAuthorizationRoleKeyMaterial(
  raw: ParsedJson,
  field: string,
): Result<AuthorizationRoleKeyMaterial, InvalidProductionLiveCopyBlueprintError> {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length % 4 !== 0 ||
    !PUBLIC_KEY_BASE64_RE.test(raw)
  ) {
    return err(invalidBlueprint(
      field,
      `${field} must be canonical Base64 for an Ed25519 SPKI public key`,
    ));
  }
  const der = Buffer.from(raw, "base64");
  if (
    der.byteLength === 0 ||
    der.byteLength > MAX_PUBLIC_KEY_DER_BYTES ||
    der.toString("base64") !== raw
  ) {
    return err(invalidBlueprint(
      field,
      `${field} must be canonical Base64 for a bounded Ed25519 SPKI public key`,
    ));
  }
  const resolved = tryCatch(() => createPublicKey({
    key: der,
    format: "der",
    type: "spki",
  }));
  if (!resolved.ok || resolved.value.asymmetricKeyType !== "ed25519") {
    return err(invalidBlueprint(field, `${field} must resolve to an Ed25519 public key`));
  }
  const exported = tryCatch(() => resolved.value.export({
    format: "der",
    type: "spki",
  }));
  if (
    !exported.ok ||
    !Buffer.isBuffer(exported.value) ||
    !exported.value.equals(der)
  ) {
    return err(invalidBlueprint(field, `${field} must use canonical Ed25519 SPKI DER`));
  }
  return ok(Object.freeze({
    publicKeyDerBase64: raw,
    fingerprintSha256: authorizationKeyMaterialFingerprint(der),
  }));
}

function normalizeEndpoint<Role extends "production" | "test">(
  raw: ParsedJson,
  role: Role,
  field: "source" | "target",
): Result<
  ProductionLiveCopyEndpointBlueprint & { readonly role: Role },
  InvalidProductionLiveCopyBlueprintError
> {
  const record = exactParsedRecord(raw, ENDPOINT_KEYS, field);
  if (!record.ok) return record;
  const parsedRole = requireLiteral(record.value.role, role, `${field}.role`);
  if (!parsedRole.ok) return parsedRole;
  const digestFields = [
    "machineIdentityDigestSha256",
    "endpointAttestationDigestSha256",
    "serviceCommitmentSha256",
    "dataDirCommitmentSha256",
    "endpointAttestationGenerationSha256",
    "immutableMachineTrustRootStoreIdentitySha256",
    "immutableMachineTrustRootHeadDigestSha256",
  ] as const;
  for (const key of digestFields) {
    const parsed = requireSha256(Reflect.get(record.value, key) as ParsedJson, `${field}.${key}`);
    if (!parsed.ok) return parsed;
  }
  const possession = record.value.recipientKeyPossessionAttestationDigestSha256;
  const possessionPayload = record.value.recipientKeyPossessionSignedPayloadDigestSha256;
  const possessionSigner = record.value.recipientKeyPossessionSignerKeyIdSha256;
  const possessionAuthentication = record.value.recipientKeyPossessionAuthenticationKind;
  const possessionSignature = record.value.recipientKeyPossessionSignatureBase64;
  if (
    (role === "production" &&
      (possession !== null ||
        possessionPayload !== null ||
        possessionSigner !== null ||
        possessionAuthentication !== null ||
        possessionSignature !== null)) ||
    (role === "test" &&
      (typeof possession !== "string" ||
        !SHA256_RE.test(possession) ||
        typeof possessionPayload !== "string" ||
        !SHA256_RE.test(possessionPayload) ||
        typeof possessionSigner !== "string" ||
        !SHA256_RE.test(possessionSigner) ||
        possessionAuthentication !== "ed25519_signature" ||
        !isCanonicalSignatureBase64(possessionSignature)))
  ) {
    return err(
      invalidBlueprint(
        `${field}.recipientKeyPossession`,
        "Only the test target must carry a closed signed recipient-key possession attestation",
      ),
    );
  }
  return ok(Object.freeze({
    role,
    machineIdentityDigestSha256: record.value.machineIdentityDigestSha256 as string,
    endpointAttestationDigestSha256: record.value.endpointAttestationDigestSha256 as string,
    serviceCommitmentSha256: record.value.serviceCommitmentSha256 as string,
    dataDirCommitmentSha256: record.value.dataDirCommitmentSha256 as string,
    endpointAttestationGenerationSha256:
      record.value.endpointAttestationGenerationSha256 as string,
    recipientKeyPossessionAttestationDigestSha256: possession as string | null,
    recipientKeyPossessionSignedPayloadDigestSha256: possessionPayload as string | null,
    recipientKeyPossessionSignerKeyIdSha256: possessionSigner as string | null,
    recipientKeyPossessionAuthenticationKind:
      possessionAuthentication as "ed25519_signature" | null,
    recipientKeyPossessionSignatureBase64: possessionSignature as string | null,
    immutableMachineTrustRootStoreIdentitySha256:
      record.value.immutableMachineTrustRootStoreIdentitySha256 as string,
    immutableMachineTrustRootHeadDigestSha256:
      record.value.immutableMachineTrustRootHeadDigestSha256 as string,
  }));
}

function normalizeRetention(
  raw: ParsedJson,
): Result<ProductionLiveCopyRetentionPolicy, InvalidProductionLiveCopyBlueprintError> {
  const record = exactParsedRecord(raw, RETENTION_POLICY_KEYS, "retentionPolicy");
  if (!record.ok) return record;
  const deadline = requirePositiveInteger(
    record.value.destructionDeadlineUnixMs,
    "retentionPolicy.destructionDeadlineUnixMs",
  );
  if (!deadline.ok) return deadline;
  const required = requireLiteral(
    record.value.destructionRequired,
    true,
    "retentionPolicy.destructionRequired",
  );
  if (!required.ok) return required;
  const identity = requireSha256(
    record.value.destructionAuthorityStoreIdentitySha256,
    "retentionPolicy.destructionAuthorityStoreIdentitySha256",
  );
  if (!identity.ok) return identity;
  const head = requireSha256(
    record.value.destructionAuthorityStoreHeadDigestSha256,
    "retentionPolicy.destructionAuthorityStoreHeadDigestSha256",
  );
  if (!head.ok) return head;
  return ok(Object.freeze({
    destructionDeadlineUnixMs: deadline.value,
    destructionRequired: true as const,
    destructionAuthorityStoreIdentitySha256: identity.value,
    destructionAuthorityStoreHeadDigestSha256: head.value,
  }));
}

function normalizeBlueprint(
  raw: ParsedJson,
): Result<ProductionLiveCopyBlueprint, ProductionLiveCopyBlueprintError> {
  const record = exactParsedRecord(raw, TOP_LEVEL_KEYS, "input");
  if (!record.ok) return record;
  for (const [field, literal] of [
    ["schema", "comis-production-live-copy-blueprint"],
    ["schemaVersion", 1],
    ["captureMode", "offline"],
    ["scope", "offline_full_state_and_source_secrets"],
    ["operationalStatus", "schema_only"],
    ["exactExecutionEligible", false],
    ["issuanceTimeAuthenticationKind", "ed25519_signature"],
  ] as const) {
    const parsed = requireLiteral(Reflect.get(record.value, field) as ParsedJson, literal, field);
    if (!parsed.ok) return parsed;
  }
  if (
    typeof record.value.runId !== "string" ||
    !RUN_ID_RE.test(record.value.runId) ||
    Buffer.byteLength(record.value.runId, "utf8") > MAX_RUN_ID_BYTES
  ) {
    return err(invalidBlueprint("runId", "runId must be a bounded portable identifier"));
  }
  if (typeof record.value.attemptId !== "string" || !ATTEMPT_ID_RE.test(record.value.attemptId)) {
    return err(invalidBlueprint("attemptId", "attemptId must be a lowercase hexadecimal identifier"));
  }
  if (
    typeof record.value.challengeNonceBase64 !== "string" ||
    !CHALLENGE_NONCE_RE.test(record.value.challengeNonceBase64)
  ) {
    return err(invalidBlueprint("challengeNonceBase64", "challengeNonceBase64 must encode 32 bytes"));
  }
  const challenge = Buffer.from(record.value.challengeNonceBase64, "base64");
  if (
    challenge.byteLength !== 32 ||
    challenge.toString("base64") !== record.value.challengeNonceBase64
  ) {
    return err(invalidBlueprint("challengeNonceBase64", "challengeNonceBase64 must encode 32 bytes"));
  }
  const source = normalizeEndpoint(record.value.source, "production", "source");
  if (!source.ok) return source;
  const target = normalizeEndpoint(record.value.target, "test", "target");
  if (!target.ok) return target;
  for (const field of TOP_DIGEST_FIELDS) {
    const parsed = requireSha256(Reflect.get(record.value, field) as ParsedJson, field);
    if (!parsed.ok) return parsed;
  }
  const authorizationRoleKeyMaterials: AuthorizationRoleKeyMaterial[] = [];
  for (const fields of AUTHORIZATION_ROLE_KEY_FIELDS) {
    const material = requireAuthorizationRoleKeyMaterial(
      Reflect.get(record.value, fields.publicKeyField) as ParsedJson,
      fields.publicKeyField,
    );
    if (!material.ok) return material;
    const expectedKeyId = authorizationRoleKeyId(
      fields.role,
      material.value.fingerprintSha256,
    );
    if (Reflect.get(record.value, fields.keyIdField) !== expectedKeyId) {
      return err(invalidBlueprint(
        fields.keyIdField,
        `${fields.keyIdField} must be domain-separated from its resolved Ed25519 key material`,
      ));
    }
    authorizationRoleKeyMaterials.push(material.value);
  }
  if (
    new Set(
      authorizationRoleKeyMaterials.map(({ fingerprintSha256 }) => fingerprintSha256),
    ).size !== AUTHORIZATION_ROLE_KEY_FIELDS.length
  ) {
    return err(invalidBlueprint(
      "authorizationRoleKeyMaterialDisjointness",
      "Every authorization role must resolve to distinct Ed25519 public-key material",
    ));
  }
  const numberFields = [
    "issuedAtUnixMs",
    "captureAuthorizationDeadlineUnixMs",
    "transferAuthorizationDeadlineUnixMs",
    "sourceStopLeaseDeadlineUnixMs",
    "targetQuarantineLeaseDeadlineUnixMs",
  ] as const;
  for (const field of numberFields) {
    const parsed = requirePositiveInteger(Reflect.get(record.value, field) as ParsedJson, field);
    if (!parsed.ok) return parsed;
  }
  const maximumFields = [
    "maximumCaptureAuthorizationLeaseMs",
    "maximumTransferAuthorizationLeaseMs",
    "maximumSourceStopLeaseMs",
    "maximumTargetQuarantineLeaseMs",
  ] as const;
  for (const field of maximumFields) {
    const parsed = requirePositiveInteger(
      Reflect.get(record.value, field) as ParsedJson,
      field,
      MAX_LEASE_MS,
    );
    if (!parsed.ok) return parsed;
  }
  const retention = normalizeRetention(record.value.retentionPolicy);
  if (!retention.ok) return retention;
  const issuanceSignature = requireSignatureBase64(
    record.value.issuanceTimeSignatureBase64,
    "issuanceTimeSignatureBase64",
  );
  if (!issuanceSignature.ok) return issuanceSignature;

  const issuedAt = record.value.issuedAtUnixMs as number;
  const captureDeadline = record.value.captureAuthorizationDeadlineUnixMs as number;
  const transferDeadline = record.value.transferAuthorizationDeadlineUnixMs as number;
  const sourceStopDeadline = record.value.sourceStopLeaseDeadlineUnixMs as number;
  const targetQuarantineDeadline = record.value.targetQuarantineLeaseDeadlineUnixMs as number;
  const destructionDeadline = retention.value.destructionDeadlineUnixMs;
  if (
    !(issuedAt < captureDeadline &&
      captureDeadline < transferDeadline &&
      transferDeadline < destructionDeadline &&
      issuedAt < sourceStopDeadline &&
      sourceStopDeadline < destructionDeadline &&
      issuedAt < targetQuarantineDeadline &&
      targetQuarantineDeadline < destructionDeadline) ||
    destructionDeadline - issuedAt > MAX_RETENTION_MS ||
    captureDeadline - issuedAt >
      (record.value.maximumCaptureAuthorizationLeaseMs as number) ||
    transferDeadline - issuedAt >
      (record.value.maximumTransferAuthorizationLeaseMs as number) ||
    sourceStopDeadline - issuedAt > (record.value.maximumSourceStopLeaseMs as number) ||
    targetQuarantineDeadline - issuedAt >
      (record.value.maximumTargetQuarantineLeaseMs as number)
  ) {
    if (destructionDeadline - issuedAt > MAX_RETENTION_MS) {
      return err(
        invalidBlueprint(
          "retentionPolicy.destructionDeadlineUnixMs",
          "Retention must end within the fixed maximum interval from trusted issuance",
        ),
      );
    }
    return err(
      invalidBlueprint(
        "leaseBounds",
        "Trusted issuance, authorization, stop, quarantine, and destruction limits are inconsistent",
      ),
    );
  }
  const expectedIssuancePayload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.issuanceTime}\0${record.value.trustedTimeAuthorityStoreIdentitySha256 as string}\0${record.value.trustedTimeAuthorityStoreHeadDigestSha256 as string}\0${record.value.trustedTimeSigningKeyIdSha256 as string}\0${record.value.runId}\0${record.value.attemptId}\0${issuedAt}`,
  );
  if (record.value.issuanceTimeSignedPayloadDigestSha256 !== expectedIssuancePayload) {
    return err(
      invalidBlueprint(
        "issuanceTimeSignedPayloadDigestSha256",
        "Blueprint issuance payload must bind its trusted time authority and signing key",
      ),
    );
  }
  const expectedIssuanceReceipt = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0issuance_time\0${expectedIssuancePayload}\0${record.value.trustedTimeSigningKeyIdSha256 as string}\0${issuanceSignature.value}`,
  );
  if (record.value.issuanceTimeReceiptDigestSha256 !== expectedIssuanceReceipt) {
    return err(
      invalidBlueprint(
        "issuanceTimeReceiptDigestSha256",
        "Blueprint issuance time must bind the trusted time authority",
      ),
    );
  }
  const expectedPossessionPayload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.recipientPossession}\0${record.value.encryptionRecipientKeyIdSha256 as string}\0${target.value.machineIdentityDigestSha256}\0${target.value.endpointAttestationDigestSha256}\0${target.value.endpointAttestationGenerationSha256}\0${target.value.recipientKeyPossessionSignerKeyIdSha256 as string}`,
  );
  if (
    target.value.recipientKeyPossessionSignedPayloadDigestSha256 !==
      expectedPossessionPayload
  ) {
    return err(
      invalidBlueprint(
        "target.recipientKeyPossession",
        "Recipient possession must bind the current recipient key and target attestation generation",
      ),
    );
  }
  const expectedPossessionAttestation = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0recipient_possession\0${expectedPossessionPayload}\0${target.value.recipientKeyPossessionSignerKeyIdSha256 as string}\0${target.value.recipientKeyPossessionSignatureBase64 as string}`,
  );
  if (
    target.value.recipientKeyPossessionAttestationDigestSha256 !==
      expectedPossessionAttestation
  ) {
    return err(
      invalidBlueprint(
        "target.recipientKeyPossession",
        "Recipient possession attestation envelope does not bind its signed payload",
      ),
    );
  }

  const roleValues = [
    source.value.machineIdentityDigestSha256,
    source.value.endpointAttestationDigestSha256,
    source.value.endpointAttestationGenerationSha256,
    source.value.serviceCommitmentSha256,
    source.value.dataDirCommitmentSha256,
    source.value.immutableMachineTrustRootStoreIdentitySha256,
    source.value.immutableMachineTrustRootHeadDigestSha256,
    target.value.machineIdentityDigestSha256,
    target.value.endpointAttestationDigestSha256,
    target.value.endpointAttestationGenerationSha256,
    target.value.serviceCommitmentSha256,
    target.value.dataDirCommitmentSha256,
    target.value.recipientKeyPossessionAttestationDigestSha256,
    target.value.recipientKeyPossessionSignedPayloadDigestSha256,
    target.value.recipientKeyPossessionSignerKeyIdSha256,
    target.value.immutableMachineTrustRootStoreIdentitySha256,
    target.value.immutableMachineTrustRootHeadDigestSha256,
    record.value.operatorTrustRootStoreIdentitySha256,
    record.value.operatorTrustRootHeadDigestSha256,
    record.value.controllerTrustRootStoreIdentitySha256,
    record.value.controllerTrustRootHeadDigestSha256,
    record.value.targetAuthorityStoreIdentitySha256,
    record.value.targetAuthorityStoreHeadDigestSha256,
    record.value.sourceAuthorityStoreIdentitySha256,
    record.value.sourceAuthorityStoreHeadDigestSha256,
    record.value.sequenceAuthorityStoreIdentitySha256,
    record.value.sequenceAuthorityStoreHeadDigestSha256,
    record.value.trustedTimeAuthorityStoreIdentitySha256,
    record.value.trustedTimeAuthorityStoreHeadDigestSha256,
    record.value.trustedTimeSigningKeyIdSha256,
    record.value.artifactUseRegistryStoreIdentitySha256,
    record.value.artifactUseRegistryStoreHeadDigestSha256,
    record.value.artifactUseRegistrySigningKeyIdSha256,
    retention.value.destructionAuthorityStoreIdentitySha256,
    retention.value.destructionAuthorityStoreHeadDigestSha256,
    record.value.sourceStoppedGenerationSha256,
    record.value.sourceStopLeaseIdentitySha256,
    record.value.targetQuarantineGenerationSha256,
    record.value.targetQuarantineLeaseIdentitySha256,
    record.value.encryptionRecipientKeyIdSha256,
    record.value.operatorSigningKeyIdSha256,
    record.value.controllerSigningKeyIdSha256,
    record.value.sourceSigningKeyIdSha256,
    record.value.targetSigningKeyIdSha256,
    record.value.destructionSigningKeyIdSha256,
    record.value.stagingNamespaceDigestSha256,
  ];
  if (
    roleValues.some((value) => typeof value !== "string") ||
    new Set(roleValues).size !== roleValues.length
  ) {
    return err(
      invalidBlueprint(
        "roleDisjointness",
        "Every cross-role machine, attestation, generation, lease, authority, and key identity must be distinct",
      ),
    );
  }

  return ok(Object.freeze({
    schema: "comis-production-live-copy-blueprint" as const,
    schemaVersion: 1 as const,
    runId: record.value.runId,
    attemptId: record.value.attemptId,
    challengeNonceBase64: record.value.challengeNonceBase64,
    source: source.value as ProductionLiveCopyBlueprint["source"],
    target: target.value as ProductionLiveCopyBlueprint["target"],
    operatorTrustRootStoreIdentitySha256: record.value.operatorTrustRootStoreIdentitySha256 as string,
    operatorTrustRootHeadDigestSha256: record.value.operatorTrustRootHeadDigestSha256 as string,
    controllerTrustRootStoreIdentitySha256: record.value.controllerTrustRootStoreIdentitySha256 as string,
    controllerTrustRootHeadDigestSha256: record.value.controllerTrustRootHeadDigestSha256 as string,
    targetAuthorityStoreIdentitySha256: record.value.targetAuthorityStoreIdentitySha256 as string,
    targetAuthorityStoreHeadDigestSha256: record.value.targetAuthorityStoreHeadDigestSha256 as string,
    sourceAuthorityStoreIdentitySha256: record.value.sourceAuthorityStoreIdentitySha256 as string,
    sourceAuthorityStoreHeadDigestSha256: record.value.sourceAuthorityStoreHeadDigestSha256 as string,
    sequenceAuthorityStoreIdentitySha256: record.value.sequenceAuthorityStoreIdentitySha256 as string,
    sequenceAuthorityStoreHeadDigestSha256: record.value.sequenceAuthorityStoreHeadDigestSha256 as string,
    trustedTimeAuthorityStoreIdentitySha256: record.value.trustedTimeAuthorityStoreIdentitySha256 as string,
    trustedTimeAuthorityStoreHeadDigestSha256: record.value.trustedTimeAuthorityStoreHeadDigestSha256 as string,
    trustedTimeSigningKeyIdSha256: record.value.trustedTimeSigningKeyIdSha256 as string,
    artifactUseRegistryStoreIdentitySha256:
      record.value.artifactUseRegistryStoreIdentitySha256 as string,
    artifactUseRegistryStoreHeadDigestSha256:
      record.value.artifactUseRegistryStoreHeadDigestSha256 as string,
    artifactUseRegistrySigningKeyIdSha256:
      record.value.artifactUseRegistrySigningKeyIdSha256 as string,
    sourceStoppedGenerationSha256: record.value.sourceStoppedGenerationSha256 as string,
    sourceStopLeaseIdentitySha256: record.value.sourceStopLeaseIdentitySha256 as string,
    sourceStopLeaseDeadlineUnixMs: sourceStopDeadline,
    targetQuarantineGenerationSha256: record.value.targetQuarantineGenerationSha256 as string,
    targetQuarantineLeaseIdentitySha256: record.value.targetQuarantineLeaseIdentitySha256 as string,
    targetQuarantineLeaseDeadlineUnixMs: targetQuarantineDeadline,
    encryptionRecipientKeyIdSha256: record.value.encryptionRecipientKeyIdSha256 as string,
    operatorSigningKeyIdSha256: record.value.operatorSigningKeyIdSha256 as string,
    operatorSigningPublicKeyDerBase64:
      record.value.operatorSigningPublicKeyDerBase64 as string,
    controllerSigningKeyIdSha256: record.value.controllerSigningKeyIdSha256 as string,
    controllerSigningPublicKeyDerBase64:
      record.value.controllerSigningPublicKeyDerBase64 as string,
    sourceSigningKeyIdSha256: record.value.sourceSigningKeyIdSha256 as string,
    sourceSigningPublicKeyDerBase64:
      record.value.sourceSigningPublicKeyDerBase64 as string,
    targetSigningKeyIdSha256: record.value.targetSigningKeyIdSha256 as string,
    targetSigningPublicKeyDerBase64:
      record.value.targetSigningPublicKeyDerBase64 as string,
    destructionSigningKeyIdSha256: record.value.destructionSigningKeyIdSha256 as string,
    destructionSigningPublicKeyDerBase64:
      record.value.destructionSigningPublicKeyDerBase64 as string,
    stagingNamespaceDigestSha256: record.value.stagingNamespaceDigestSha256 as string,
    issuedAtUnixMs: issuedAt,
    issuanceTimeSignedPayloadDigestSha256: expectedIssuancePayload,
    issuanceTimeAuthenticationKind: "ed25519_signature" as const,
    issuanceTimeSignatureBase64: issuanceSignature.value,
    issuanceTimeReceiptDigestSha256: record.value.issuanceTimeReceiptDigestSha256 as string,
    captureAuthorizationDeadlineUnixMs: captureDeadline,
    transferAuthorizationDeadlineUnixMs: transferDeadline,
    retentionPolicy: retention.value,
    maximumCaptureAuthorizationLeaseMs: record.value.maximumCaptureAuthorizationLeaseMs as number,
    maximumTransferAuthorizationLeaseMs: record.value.maximumTransferAuthorizationLeaseMs as number,
    maximumSourceStopLeaseMs: record.value.maximumSourceStopLeaseMs as number,
    maximumTargetQuarantineLeaseMs: record.value.maximumTargetQuarantineLeaseMs as number,
    captureMode: "offline" as const,
    scope: "offline_full_state_and_source_secrets" as const,
    operationalStatus: "schema_only" as const,
    exactExecutionEligible: false as const,
  }));
}

export function parseProductionLiveCopyBlueprint(
  raw: unknown,
): Result<ProductionLiveCopyBlueprint, ProductionLiveCopyBlueprintError> {
  const parsed = parseCanonicalJsonLine(raw, MAX_BLUEPRINT_BYTES);
  if (!parsed.ok) return err(invalidBlueprint(parsed.error.field, parsed.error.message));
  const normalized = normalizeBlueprint(parsed.value);
  if (!normalized.ok) return normalized;
  const canonical = `${canonicalJson(normalized.value as unknown as ParsedJson)}\n`;
  return canonical === raw
    ? normalized
    : err(invalidBlueprint("canonical", "Blueprint JSON is not canonical"));
}

export function assessProductionLiveCopyReadiness(
  raw: unknown,
): Result<never, ProductionLiveCopyReadinessError> {
  const parsed = parseProductionLiveCopyBlueprint(raw);
  if (!parsed.ok) return parsed;
  return err(Object.freeze({
    kind: "operationally_ineligible" as const,
    exactExecutionEligible: false as const,
    blockers: PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS,
    requiredDurableStages: PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES,
    durableLifecycle: PRODUCTION_LIVE_COPY_DURABLE_LIFECYCLE,
    requiredBindingSchemas: PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS,
    requiredArtifactSchemas: PRODUCTION_LIVE_COPY_REQUIRED_ARTIFACT_SCHEMAS,
    requiredReceiptSchemas: PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS,
    requiredAuthorityPinPaths: PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS,
    requiredRoleDisjointPaths: PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS,
    globalReplayPreventionContract:
      PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT,
    message:
      "Live copy cannot execute until trusted time, global replay prevention, and every durable authority boundary exist",
  }));
}

export type ProductionLiveCopyArtifactKind =
  | "challenge"
  | "challenge_expiry"
  | "challenge_consumption"
  | "operator_grant"
  | "controller_grant"
  | "capture_authorization"
  | "source_capture_staging"
  | "recovery_contract"
  | "source_attestation"
  | "source_binding"
  | "transfer_authorization"
  | "encrypted_staging_receipt"
  | "source_manifest_verification"
  | "target_attestation"
  | "quarantine_restore"
  | "promotion"
  | "abort"
  | "finalization"
  | "destruction_attestation";

export type ProductionLiveCopyArtifactReferenceKind =
  | "none"
  | ProductionLiveCopyArtifactKind
  | "challenge_nonce"
  | ProductionLiveCopySensitiveSubjectKind;

export type ProductionLiveCopySensitiveSubjectKind =
  | "source_capture_workspace"
  | "source_snapshot_manifest"
  | "source_encrypted_staging"
  | "target_encrypted_staging"
  | "quarantine_plaintext"
  | "promoted_plaintext";

export interface ProductionLiveCopySensitiveSubject {
  readonly kind: ProductionLiveCopySensitiveSubjectKind;
  readonly digestSha256: string;
  readonly ownerRole: "source" | "target";
  readonly createdByStage: ProductionLiveCopyDurableStage;
}

export interface ProductionLiveCopyCleanupAttestation {
  readonly schema: "comis-production-live-copy-cleanup-attestation";
  readonly schemaVersion: 1;
  readonly action:
    | "source_subject_destroyed"
    | "target_subject_destroyed"
    | "promoted_plaintext_rolled_back";
  readonly subjectKind: ProductionLiveCopySensitiveSubjectKind;
  readonly subjectDigestSha256: string;
  readonly authorityRole: "source" | "target";
  readonly signerKeyIdSha256: string;
  readonly authenticationKind: "ed25519_signature";
  readonly signedPayloadDigestSha256: string;
  readonly signatureBase64: string;
  readonly attestationDigestSha256: string;
}

export interface ProductionLiveCopyLifecycleArtifact {
  readonly schema: "comis-production-live-copy-stage-artifact";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly stage: ProductionLiveCopyDurableStage;
  readonly kind: ProductionLiveCopyArtifactKind;
  readonly digestSha256: string;
  readonly subjectKind: ProductionLiveCopyArtifactReferenceKind;
  readonly subjectDigestSha256: string | null;
  readonly predecessorArtifactKind: ProductionLiveCopyArtifactReferenceKind;
  readonly predecessorArtifactDigestSha256: string | null;
  readonly recoverySequence: number | null;
  readonly recoveryGenerationSha256: string | null;
  readonly previousRecoveryArtifactDigestSha256: string | null;
  readonly createdSensitiveSubjects: readonly ProductionLiveCopySensitiveSubject[];
  readonly cleanupSubjects: readonly ProductionLiveCopySensitiveSubject[];
  readonly cleanupInventoryDigestSha256: string | null;
  readonly cleanupAttestations: readonly ProductionLiveCopyCleanupAttestation[];
  readonly authenticationKind: "ed25519_signature";
  readonly signerRole: "operator" | "controller" | "source" | "target" | "destruction";
  readonly signerKeyIdSha256: string;
  readonly signedPayloadDigestSha256: string;
  readonly signatureBase64: string;
}

export interface ProductionLiveCopyLifecycleReceipt {
  readonly schema: "comis-production-live-copy-stage-receipt";
  readonly schemaVersion: 1;
  readonly kind: ProductionLiveCopyReceiptKind;
  readonly runId: string;
  readonly attemptId: string;
  readonly stage: ProductionLiveCopyDurableStage;
  readonly sequence: number;
  readonly authorityStoreIdentitySha256: string;
  readonly authorityStoreHeadDigestSha256: string;
  readonly sequenceAuthorityStoreIdentitySha256: string;
  readonly sequenceAuthorityStoreHeadDigestSha256: string;
  readonly sequencePredecessorDigestSha256: string;
  readonly sequenceHeadDigestSha256: string;
  readonly sourceStoppedGenerationSha256: string;
  readonly sourceStopLeaseIdentitySha256: string;
  readonly sourceStopLeaseDeadlineUnixMs: number;
  readonly targetQuarantineGenerationSha256: string;
  readonly targetQuarantineLeaseIdentitySha256: string;
  readonly targetQuarantineLeaseDeadlineUnixMs: number;
  readonly encryptionRecipientKeyIdSha256: string;
  readonly targetRecipientKeyPossessionAttestationDigestSha256: string;
  readonly targetRecipientKeyPossessionSignedPayloadDigestSha256: string;
  readonly targetRecipientKeyPossessionSignerKeyIdSha256: string;
  readonly artifactKind: ProductionLiveCopyArtifactKind;
  readonly artifactDigestSha256: string;
  readonly subjectKind: ProductionLiveCopyArtifactReferenceKind;
  readonly subjectDigestSha256: string | null;
  readonly predecessorArtifactKind: ProductionLiveCopyArtifactReferenceKind;
  readonly predecessorArtifactDigestSha256: string | null;
  readonly observedAtUnixMs: number;
  readonly trustedTimeAuthorityStoreIdentitySha256: string;
  readonly trustedTimeAuthorityStoreHeadDigestSha256: string;
  readonly trustedTimeReceiptDigestSha256: string;
  readonly authenticationKind: "ed25519_signature";
  readonly signerRole: "operator" | "controller" | "source" | "target" | "destruction";
  readonly signerKeyIdSha256: string;
  readonly signedPayloadDigestSha256: string;
  readonly signatureBase64: string;
  readonly trustedTimeAuthenticationKind: "ed25519_signature";
  readonly trustedTimeSignerKeyIdSha256: string;
  readonly trustedTimeSignedPayloadDigestSha256: string;
  readonly trustedTimeSignatureBase64: string;
  readonly receiptDigestSha256: string;
}

export interface ProductionLiveCopyLifecycleEvent {
  readonly sequence: number;
  readonly stage: ProductionLiveCopyDurableStage;
  readonly blueprintDigestSha256: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly challengeDigestSha256: string;
  readonly stagingNamespaceDigestSha256: string;
  readonly artifact: ProductionLiveCopyLifecycleArtifact;
  readonly receipt: ProductionLiveCopyLifecycleReceipt;
  readonly previousEventDigestSha256: string;
  readonly eventDigestSha256: string;
}

export type ProductionLiveCopyLifecycleState =
  | "initial"
  | "challenge_issued"
  | "operator_granted"
  | "controller_granted"
  | "challenge_consumed"
  | "capture_authorized"
  | "source_capture_active"
  | "source_capture_resuming"
  | "source_attested"
  | "source_bound"
  | "transfer_authorized"
  | "received"
  | "source_verified"
  | "target_verified"
  | "restored"
  | "promoted"
  | "finalized"
  | "aborted"
  | "challenge_expired"
  | "destroyed";

export type ProductionLiveCopyRetentionAuditStatus =
  | "within_policy"
  | "overdue_cleanup_required"
  | "late_cleanup_recorded";

export type ProductionLiveCopyArtifactUseIdentityClass =
  (typeof PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT.identityClasses)[number];

export interface ProductionLiveCopyArtifactUseRegistryEntry {
  readonly identityClass: ProductionLiveCopyArtifactUseIdentityClass;
  readonly digestSha256: string;
}

export interface ProductionLiveCopyExternalArtifactUseRegistryClaim {
  readonly schema: "comis-production-live-copy-artifact-use-registry-claim";
  readonly schemaVersion: 1;
  readonly storeIdentitySha256: string;
  readonly predecessorHeadDigestSha256: string;
  readonly entries: readonly ProductionLiveCopyArtifactUseRegistryEntry[];
  readonly entrySetDigestSha256: string;
  readonly claimedHeadDigestSha256: string;
  readonly authenticationKind: "ed25519_signature";
  readonly signerKeyIdSha256: string;
  readonly signedPayloadDigestSha256: string;
  readonly signatureBase64: string;
}

export interface ProductionLiveCopyLifecycleStructuralInspection {
  readonly claimedState: ProductionLiveCopyLifecycleState;
  readonly structurallyClosed: boolean;
  readonly cleanupOutstanding: boolean;
  readonly retentionAuditStatus: ProductionLiveCopyRetentionAuditStatus;
  readonly retentionPolicyBreached: boolean;
  readonly structuralStatus: "unverified_external_authorities";
  readonly exactExecutionEligible: false;
  readonly globalReplayKeySha256: string;
  readonly sequenceHeadDigestSha256: string;
  readonly externalArtifactUseRegistry: ProductionLiveCopyExternalArtifactUseRegistryClaim;
}

export interface InvalidProductionLiveCopyLifecycleHistoryError {
  readonly kind: "invalid_lifecycle_history";
  readonly field: string;
  readonly message: string;
}

export interface ProductionLiveCopyLifecycleBindingMismatchError {
  readonly kind: "lifecycle_binding_mismatch";
  readonly field: string;
  readonly message: string;
}

export interface IllegalProductionLiveCopyLifecycleTransitionError {
  readonly kind: "illegal_lifecycle_transition";
  readonly sequence: number;
  readonly stage: ProductionLiveCopyDurableStage;
  readonly state: ProductionLiveCopyLifecycleState;
  readonly message: string;
}

export interface ProductionLiveCopyGlobalReplayPreventionRequiredError {
  readonly kind: "global_replay_prevention_required";
  readonly exactExecutionEligible: false;
  readonly globalReplayKeySha256: string;
  readonly artifactUseRegistryPredecessorHeadDigestSha256: string;
  readonly artifactUseRegistryClaimedHeadDigestSha256: string;
  readonly artifactUseEntrySetDigestSha256: string;
  readonly unverifiedAuthorityBlockers: typeof PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS;
  readonly contract: typeof PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT;
  readonly message: string;
}

export type ProductionLiveCopyLifecycleHistoryError =
  | ProductionLiveCopyBlueprintError
  | InvalidProductionLiveCopyLifecycleHistoryError
  | ProductionLiveCopyLifecycleBindingMismatchError
  | IllegalProductionLiveCopyLifecycleTransitionError
  | ProductionLiveCopyGlobalReplayPreventionRequiredError;

const HISTORY_KEYS = [
  "schema",
  "schemaVersion",
  "blueprintDigestSha256",
  "runId",
  "attemptId",
  "challengeDigestSha256",
  "sourceEndpointAttestationDigestSha256",
  "targetEndpointAttestationDigestSha256",
  "stagingNamespaceDigestSha256",
  "globalReplayKeySha256",
  "sequencePredecessorDigestSha256",
  "sequenceHeadDigestSha256",
  "sequenceNoForkProofDigestSha256",
  "trustedAsOfUnixMs",
  "trustedAsOfSignedPayloadDigestSha256",
  "trustedAsOfAuthenticationKind",
  "trustedAsOfSignerKeyIdSha256",
  "trustedAsOfSignatureBase64",
  "trustedAsOfTimeReceiptDigestSha256",
  "retentionAuditStatus",
  "retentionPolicyBreached",
  "externalArtifactUseRegistry",
  "historyStatus",
  "events",
] as const;

const ARTIFACT_USE_REGISTRY_KEYS = [
  "schema",
  "schemaVersion",
  "storeIdentitySha256",
  "predecessorHeadDigestSha256",
  "entries",
  "entrySetDigestSha256",
  "claimedHeadDigestSha256",
  "authenticationKind",
  "signerKeyIdSha256",
  "signedPayloadDigestSha256",
  "signatureBase64",
] as const;

const ARTIFACT_USE_ENTRY_KEYS = ["identityClass", "digestSha256"] as const;

const EVENT_KEYS = [
  "sequence",
  "stage",
  "blueprintDigestSha256",
  "runId",
  "attemptId",
  "challengeDigestSha256",
  "stagingNamespaceDigestSha256",
  "artifact",
  "receipt",
  "previousEventDigestSha256",
  "eventDigestSha256",
] as const;

const ARTIFACT_KEYS = [
  "schema",
  "schemaVersion",
  "runId",
  "attemptId",
  "stage",
  "kind",
  "digestSha256",
  "subjectKind",
  "subjectDigestSha256",
  "predecessorArtifactKind",
  "predecessorArtifactDigestSha256",
  "recoverySequence",
  "recoveryGenerationSha256",
  "previousRecoveryArtifactDigestSha256",
  "createdSensitiveSubjects",
  "cleanupSubjects",
  "cleanupInventoryDigestSha256",
  "cleanupAttestations",
  "authenticationKind",
  "signerRole",
  "signerKeyIdSha256",
  "signedPayloadDigestSha256",
  "signatureBase64",
] as const;

const SENSITIVE_SUBJECT_KEYS = [
  "kind",
  "digestSha256",
  "ownerRole",
  "createdByStage",
] as const;

const CLEANUP_ATTESTATION_KEYS = [
  "schema",
  "schemaVersion",
  "action",
  "subjectKind",
  "subjectDigestSha256",
  "authorityRole",
  "signerKeyIdSha256",
  "authenticationKind",
  "signedPayloadDigestSha256",
  "signatureBase64",
  "attestationDigestSha256",
] as const;

const STAGE_SET = new Set<string>(PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES);
const ARTIFACT_KIND_SET = new Set<string>([
  "challenge",
  "challenge_expiry",
  "challenge_consumption",
  "operator_grant",
  "controller_grant",
  "capture_authorization",
  "source_capture_staging",
  "recovery_contract",
  "source_attestation",
  "source_binding",
  "transfer_authorization",
  "encrypted_staging_receipt",
  "source_manifest_verification",
  "target_attestation",
  "quarantine_restore",
  "promotion",
  "abort",
  "finalization",
  "destruction_attestation",
]);
const REFERENCE_KIND_SET = new Set<string>([
  "none",
  ...ARTIFACT_KIND_SET,
  "challenge_nonce",
  "source_capture_workspace",
  "source_snapshot_manifest",
  "source_encrypted_staging",
  "target_encrypted_staging",
  "quarantine_plaintext",
  "promoted_plaintext",
]);

const SENSITIVE_SUBJECT_KIND_SET = new Set<string>([
  "source_capture_workspace",
  "source_snapshot_manifest",
  "source_encrypted_staging",
  "target_encrypted_staging",
  "quarantine_plaintext",
  "promoted_plaintext",
]);

function invalidHistory(
  field: string,
  message: string,
): InvalidProductionLiveCopyLifecycleHistoryError {
  return Object.freeze({ kind: "invalid_lifecycle_history", field, message });
}

function bindingMismatch(
  field: string,
  message: string,
): ProductionLiveCopyLifecycleBindingMismatchError {
  return Object.freeze({ kind: "lifecycle_binding_mismatch", field, message });
}

function exactHistoryRecord<const Keys extends readonly string[]>(
  raw: ParsedJson,
  keys: Keys,
  field: string,
): Result<ExactParsedRecord<Keys>, InvalidProductionLiveCopyLifecycleHistoryError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(invalidHistory(field, `${field} must be a JSON object`));
  }
  const actual = Object.keys(raw);
  const expected = new Set<string>(keys);
  return actual.length === keys.length && actual.every((key) => expected.has(key))
    ? ok(raw as ExactParsedRecord<Keys>)
    : err(invalidHistory(field, `${field} must contain exactly the schema keys`));
}

function historyDigest(
  raw: ParsedJson,
  field: string,
): Result<string, InvalidProductionLiveCopyLifecycleHistoryError> {
  return typeof raw === "string" && SHA256_RE.test(raw)
    ? ok(raw)
    : err(invalidHistory(field, `${field} must be a lowercase SHA-256 digest`));
}

function nullableHistoryDigest(
  raw: ParsedJson,
  field: string,
): Result<string | null, InvalidProductionLiveCopyLifecycleHistoryError> {
  return raw === null ? ok(null) : historyDigest(raw, field);
}

function historyPositiveInteger(
  raw: ParsedJson,
  field: string,
): Result<number, InvalidProductionLiveCopyLifecycleHistoryError> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? ok(raw)
    : err(invalidHistory(field, `${field} must be a positive safe integer`));
}

function historySignature(
  raw: ParsedJson,
  field: string,
): Result<string, InvalidProductionLiveCopyLifecycleHistoryError> {
  return isCanonicalSignatureBase64(raw)
    ? ok(raw)
    : err(invalidHistory(field, `${field} must be a canonical 64-byte signature`));
}

function subjectOwnerAndStage(
  kind: ProductionLiveCopySensitiveSubjectKind,
): readonly ["source" | "target", ProductionLiveCopyDurableStage] {
  switch (kind) {
    case "source_capture_workspace":
      return ["source", "source_capture_consume_under_stop_lease"];
    case "source_snapshot_manifest":
      return ["source", "source_manifest_attest"];
    case "source_encrypted_staging":
      return ["source", "source_bind_exact_manifest_state_tree_ciphertext_and_staging"];
    case "target_encrypted_staging":
      return ["target", "target_receive_encrypted_staging"];
    case "quarantine_plaintext":
      return ["target", "target_restore_verified_state_to_quarantine"];
    case "promoted_plaintext":
      return ["target", "target_promote_restored_state"];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function normalizeSensitiveSubject(
  raw: ParsedJson,
  field: string,
): Result<ProductionLiveCopySensitiveSubject, InvalidProductionLiveCopyLifecycleHistoryError> {
  const record = exactHistoryRecord(raw, SENSITIVE_SUBJECT_KEYS, field);
  if (!record.ok) return record;
  if (
    typeof record.value.kind !== "string" ||
    !SENSITIVE_SUBJECT_KIND_SET.has(record.value.kind)
  ) {
    return err(invalidHistory(`${field}.kind`, "Sensitive subject kind is not closed"));
  }
  const digest = historyDigest(record.value.digestSha256, `${field}.digestSha256`);
  if (!digest.ok) return digest;
  const kind = record.value.kind as ProductionLiveCopySensitiveSubjectKind;
  const [ownerRole, createdByStage] = subjectOwnerAndStage(kind);
  if (
    record.value.ownerRole !== ownerRole ||
    record.value.createdByStage !== createdByStage
  ) {
    return err(invalidHistory(field, "Sensitive subject owner or creation stage is substituted"));
  }
  return ok(Object.freeze({ kind, digestSha256: digest.value, ownerRole, createdByStage }));
}

function normalizeSensitiveSubjects(
  raw: ParsedJson,
  field: string,
): Result<readonly ProductionLiveCopySensitiveSubject[], InvalidProductionLiveCopyLifecycleHistoryError> {
  if (!Array.isArray(raw) || raw.length > 16) {
    return err(invalidHistory(field, "Sensitive subject inventory must be a bounded array"));
  }
  const subjects: ProductionLiveCopySensitiveSubject[] = [];
  for (const [index, entry] of raw.entries()) {
    const subject = normalizeSensitiveSubject(entry, `${field}.${index}`);
    if (!subject.ok) return subject;
    subjects.push(subject.value);
  }
  const keys = subjects.map(({ kind, digestSha256 }) => `${kind}:${digestSha256}`);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key, index) => index > 0 && key <= (keys[index - 1] as string))
  ) {
    return err(invalidHistory(field, "Sensitive subject inventory must be unique and sorted"));
  }
  return ok(Object.freeze(subjects));
}

function cleanupInventoryDigest(
  subjects: readonly ProductionLiveCopySensitiveSubject[],
): string {
  return sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.cleanupInventory}\0${canonicalJson(subjects as unknown as ParsedJson)}`,
  );
}

function artifactSigner(
  stage: ProductionLiveCopyDurableStage,
  blueprint: ProductionLiveCopyBlueprint,
): readonly [
  "operator" | "controller" | "source" | "target" | "destruction",
  string,
] {
  switch (stage) {
    case "operator_grant_record":
      return ["operator", blueprint.operatorSigningKeyIdSha256];
    case "controller_grant_record":
      return ["controller", blueprint.controllerSigningKeyIdSha256];
    case "source_capture_consume_under_stop_lease":
    case "source_capture_resume_same_staging":
    case "source_manifest_attest":
    case "source_bind_exact_manifest_state_tree_ciphertext_and_staging":
      return ["source", blueprint.sourceSigningKeyIdSha256];
    case "target_destroy_and_attest":
      return ["destruction", blueprint.destructionSigningKeyIdSha256];
    default:
      return ["target", blueprint.targetSigningKeyIdSha256];
  }
}

function normalizeCleanupAttestation(
  raw: ParsedJson,
  field: string,
  blueprint: ProductionLiveCopyBlueprint,
  inventoryDigest: string,
): Result<ProductionLiveCopyCleanupAttestation, InvalidProductionLiveCopyLifecycleHistoryError> {
  const record = exactHistoryRecord(raw, CLEANUP_ATTESTATION_KEYS, field);
  if (!record.ok) return record;
  if (
    record.value.schema !== "comis-production-live-copy-cleanup-attestation" ||
    record.value.schemaVersion !== 1 ||
    typeof record.value.subjectKind !== "string" ||
    !SENSITIVE_SUBJECT_KIND_SET.has(record.value.subjectKind)
  ) {
    return err(invalidHistory(field, "Cleanup attestation schema or subject kind is invalid"));
  }
  const subjectDigest = historyDigest(
    record.value.subjectDigestSha256,
    `${field}.subjectDigestSha256`,
  );
  if (!subjectDigest.ok) return subjectDigest;
  const signedPayload = historyDigest(
    record.value.signedPayloadDigestSha256,
    `${field}.signedPayloadDigestSha256`,
  );
  if (!signedPayload.ok) return signedPayload;
  const attestationDigest = historyDigest(
    record.value.attestationDigestSha256,
    `${field}.attestationDigestSha256`,
  );
  if (!attestationDigest.ok) return attestationDigest;
  const signature = historySignature(record.value.signatureBase64, `${field}.signatureBase64`);
  if (!signature.ok) return signature;
  const subjectKind = record.value.subjectKind as ProductionLiveCopySensitiveSubjectKind;
  const [ownerRole] = subjectOwnerAndStage(subjectKind);
  const action = subjectKind === "promoted_plaintext"
    ? "promoted_plaintext_rolled_back"
    : ownerRole === "source"
      ? "source_subject_destroyed"
      : "target_subject_destroyed";
  const signerKeyIdSha256 = ownerRole === "source"
    ? blueprint.sourceSigningKeyIdSha256
    : blueprint.targetSigningKeyIdSha256;
  if (
    record.value.action !== action ||
    record.value.authorityRole !== ownerRole ||
    record.value.signerKeyIdSha256 !== signerKeyIdSha256 ||
    record.value.authenticationKind !== "ed25519_signature"
  ) {
    return err(invalidHistory(field, "Cleanup attestation role, action, or signing key is substituted"));
  }
  const expectedPayload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.cleanupAttestation}\0${blueprint.runId}\0${blueprint.attemptId}\0${inventoryDigest}\0${subjectKind}\0${subjectDigest.value}\0${action}\0${ownerRole}\0${signerKeyIdSha256}`,
  );
  const expectedAttestation = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0cleanup_attestation\0${expectedPayload}\0${signerKeyIdSha256}\0${signature.value}`,
  );
  if (
    signedPayload.value !== expectedPayload ||
    attestationDigest.value !== expectedAttestation
  ) {
    return err(invalidHistory(field, "Cleanup attestation signed envelope is invalid"));
  }
  return ok(Object.freeze({
    schema: "comis-production-live-copy-cleanup-attestation" as const,
    schemaVersion: 1 as const,
    action,
    subjectKind,
    subjectDigestSha256: subjectDigest.value,
    authorityRole: ownerRole,
    signerKeyIdSha256,
    authenticationKind: "ed25519_signature" as const,
    signedPayloadDigestSha256: expectedPayload,
    signatureBase64: signature.value,
    attestationDigestSha256: expectedAttestation,
  }));
}

function normalizeArtifact(
  raw: ParsedJson,
  stage: ProductionLiveCopyDurableStage,
  blueprint: ProductionLiveCopyBlueprint,
  field: string,
): Result<ProductionLiveCopyLifecycleArtifact, InvalidProductionLiveCopyLifecycleHistoryError> {
  const record = exactHistoryRecord(raw, ARTIFACT_KEYS, field);
  if (!record.ok) return record;
  if (
    record.value.schema !== "comis-production-live-copy-stage-artifact" ||
    record.value.schemaVersion !== 1 ||
    record.value.runId !== blueprint.runId ||
    record.value.attemptId !== blueprint.attemptId ||
    record.value.stage !== stage ||
    typeof record.value.kind !== "string" ||
    !ARTIFACT_KIND_SET.has(record.value.kind)
  ) {
    return err(invalidHistory(`${field}.kind`, "Artifact kind is not closed"));
  }
  if (
    typeof record.value.subjectKind !== "string" ||
    !REFERENCE_KIND_SET.has(record.value.subjectKind) ||
    typeof record.value.predecessorArtifactKind !== "string" ||
    !REFERENCE_KIND_SET.has(record.value.predecessorArtifactKind)
  ) {
    return err(invalidHistory(field, "Artifact reference kind is not closed"));
  }
  const digest = historyDigest(record.value.digestSha256, `${field}.digestSha256`);
  if (!digest.ok) return digest;
  const subject = nullableHistoryDigest(
    record.value.subjectDigestSha256,
    `${field}.subjectDigestSha256`,
  );
  if (!subject.ok) return subject;
  const predecessor = nullableHistoryDigest(
    record.value.predecessorArtifactDigestSha256,
    `${field}.predecessorArtifactDigestSha256`,
  );
  if (!predecessor.ok) return predecessor;
  let recoverySequence: number | null = null;
  let recoveryGenerationSha256: string | null = null;
  let previousRecoveryArtifactDigestSha256: string | null = null;
  if (stage === "source_capture_resume_same_staging") {
    const parsedSequence = historyPositiveInteger(
      record.value.recoverySequence,
      `${field}.recoverySequence`,
    );
    if (!parsedSequence.ok) return parsedSequence;
    if (parsedSequence.value > MAX_HISTORY_EVENTS) {
      return err(invalidHistory(
        `${field}.recoverySequence`,
        "Recovery sequence exceeds the lifecycle event bound",
      ));
    }
    const parsedGeneration = historyDigest(
      record.value.recoveryGenerationSha256,
      `${field}.recoveryGenerationSha256`,
    );
    if (!parsedGeneration.ok) return parsedGeneration;
    const parsedPreviousRecovery = nullableHistoryDigest(
      record.value.previousRecoveryArtifactDigestSha256,
      `${field}.previousRecoveryArtifactDigestSha256`,
    );
    if (!parsedPreviousRecovery.ok) return parsedPreviousRecovery;
    recoverySequence = parsedSequence.value;
    recoveryGenerationSha256 = parsedGeneration.value;
    previousRecoveryArtifactDigestSha256 = parsedPreviousRecovery.value;
  } else if (
    record.value.recoverySequence !== null ||
    record.value.recoveryGenerationSha256 !== null ||
    record.value.previousRecoveryArtifactDigestSha256 !== null
  ) {
    return err(invalidHistory(
      field,
      "Only source-capture recovery artifacts may carry recovery bindings",
    ));
  }
  const kind = record.value.kind as ProductionLiveCopyArtifactKind;
  const subjectKind = record.value.subjectKind as ProductionLiveCopyArtifactReferenceKind;
  const predecessorKind =
    record.value.predecessorArtifactKind as ProductionLiveCopyArtifactReferenceKind;
  if (
    (subjectKind === "none") !== (subject.value === null) ||
    (predecessorKind === "none") !== (predecessor.value === null) ||
    digest.value === subject.value ||
    digest.value === predecessor.value ||
    digest.value === recoveryGenerationSha256
  ) {
    return err(invalidHistory(field, "Artifact tags and nullable digests disagree"));
  }
  const createdSubjects = normalizeSensitiveSubjects(
    record.value.createdSensitiveSubjects,
    `${field}.createdSensitiveSubjects`,
  );
  if (!createdSubjects.ok) return createdSubjects;
  const cleanupSubjects = normalizeSensitiveSubjects(
    record.value.cleanupSubjects,
    `${field}.cleanupSubjects`,
  );
  if (!cleanupSubjects.ok) return cleanupSubjects;
  const inventoryDigest = nullableHistoryDigest(
    record.value.cleanupInventoryDigestSha256,
    `${field}.cleanupInventoryDigestSha256`,
  );
  if (!inventoryDigest.ok) return inventoryDigest;
  if (!Array.isArray(record.value.cleanupAttestations) || record.value.cleanupAttestations.length > 16) {
    return err(invalidHistory(`${field}.cleanupAttestations`, "Cleanup attestations must be bounded"));
  }
  if (
    (stage === "target_abort" || stage === "target_destroy_and_attest") !==
      (inventoryDigest.value !== null) ||
    (inventoryDigest.value !== null &&
      inventoryDigest.value !== cleanupInventoryDigest(cleanupSubjects.value)) ||
    (stage !== "target_abort" && stage !== "target_destroy_and_attest" &&
      cleanupSubjects.value.length !== 0)
  ) {
    return err(invalidHistory(field, "Cleanup inventory is absent, premature, or has the wrong digest"));
  }
  const cleanupAttestations: ProductionLiveCopyCleanupAttestation[] = [];
  for (const [index, entry] of record.value.cleanupAttestations.entries()) {
    if (inventoryDigest.value === null) {
      return err(invalidHistory(field, "Cleanup attestation cannot precede an inventory"));
    }
    const attestation = normalizeCleanupAttestation(
      entry,
      `${field}.cleanupAttestations.${index}`,
      blueprint,
      inventoryDigest.value,
    );
    if (!attestation.ok) return attestation;
    cleanupAttestations.push(attestation.value);
  }
  if (
    (stage === "target_destroy_and_attest") !== (cleanupAttestations.length > 0) &&
    cleanupSubjects.value.length > 0
  ) {
    return err(invalidHistory(field, "Only destruction may attest cleanup of sensitive subjects"));
  }
  const [signerRole, signerKeyIdSha256] = artifactSigner(stage, blueprint);
  const signature = historySignature(record.value.signatureBase64, `${field}.signatureBase64`);
  if (!signature.ok) return signature;
  if (
    record.value.authenticationKind !== "ed25519_signature" ||
    record.value.signerRole !== signerRole ||
    record.value.signerKeyIdSha256 !== signerKeyIdSha256
  ) {
    return err(invalidHistory(field, "Artifact authentication role or key is substituted"));
  }
  const artifactBody = {
    schema: "comis-production-live-copy-stage-artifact",
    schemaVersion: 1,
    runId: blueprint.runId,
    attemptId: blueprint.attemptId,
    stage,
    kind,
    subjectKind,
    subjectDigestSha256: subject.value,
    predecessorArtifactKind: predecessorKind,
    predecessorArtifactDigestSha256: predecessor.value,
    recoverySequence,
    recoveryGenerationSha256,
    previousRecoveryArtifactDigestSha256,
    createdSensitiveSubjects: createdSubjects.value,
    cleanupSubjects: cleanupSubjects.value,
    cleanupInventoryDigestSha256: inventoryDigest.value,
    cleanupAttestations,
    authenticationKind: "ed25519_signature",
    signerRole,
    signerKeyIdSha256,
  } as const;
  const expectedPayload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactPayload}\0${canonicalJson(artifactBody as unknown as ParsedJson)}`,
  );
  const expectedDigest = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifact}\0${expectedPayload}\0${signature.value}`,
  );
  if (
    record.value.signedPayloadDigestSha256 !== expectedPayload ||
    digest.value !== expectedDigest
  ) {
    return err(invalidHistory(field, "Artifact signed envelope digest is invalid"));
  }
  return ok(Object.freeze({
    ...artifactBody,
    cleanupAttestations: Object.freeze(cleanupAttestations),
    createdSensitiveSubjects: createdSubjects.value,
    cleanupSubjects: cleanupSubjects.value,
    kind,
    digestSha256: digest.value,
    signedPayloadDigestSha256: expectedPayload,
    signatureBase64: signature.value,
  }));
}

function receiptKind(stage: ProductionLiveCopyDurableStage): ProductionLiveCopyReceiptKind {
  switch (stage) {
    case "target_challenge_issue":
    case "target_challenge_expire":
    case "target_challenge_consume":
      return "challenge";
    case "source_capture_resume_same_staging":
      return "recovery";
    case "target_receive_encrypted_staging":
      return "receive";
    case "target_restore_verified_state_to_quarantine":
      return "restore";
    case "target_promote_restored_state":
      return "promotion";
    case "target_abort":
      return "abort";
    case "target_finalize":
      return "finalize";
    case "target_destroy_and_attest":
      return "destruction";
    case "operator_grant_record":
    case "controller_grant_record":
    case "target_capture_authorize_and_begin":
    case "source_capture_consume_under_stop_lease":
    case "source_manifest_attest":
    case "source_bind_exact_manifest_state_tree_ciphertext_and_staging":
    case "target_transfer_authorize_and_begin":
    case "target_verify_source_manifest_attestation":
    case "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding":
      return "authorization";
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

function receiptAuthority(
  stage: ProductionLiveCopyDurableStage,
  blueprint: ProductionLiveCopyBlueprint,
): readonly [string, string] {
  switch (stage) {
    case "operator_grant_record":
      return [
        blueprint.operatorTrustRootStoreIdentitySha256,
        blueprint.operatorTrustRootHeadDigestSha256,
      ];
    case "controller_grant_record":
      return [
        blueprint.controllerTrustRootStoreIdentitySha256,
        blueprint.controllerTrustRootHeadDigestSha256,
      ];
    case "source_capture_consume_under_stop_lease":
    case "source_capture_resume_same_staging":
    case "source_manifest_attest":
    case "source_bind_exact_manifest_state_tree_ciphertext_and_staging":
      return [
        blueprint.sourceAuthorityStoreIdentitySha256,
        blueprint.sourceAuthorityStoreHeadDigestSha256,
      ];
    case "target_destroy_and_attest":
      return [
        blueprint.retentionPolicy.destructionAuthorityStoreIdentitySha256,
        blueprint.retentionPolicy.destructionAuthorityStoreHeadDigestSha256,
      ];
    default:
      return [
        blueprint.targetAuthorityStoreIdentitySha256,
        blueprint.targetAuthorityStoreHeadDigestSha256,
      ];
  }
}

function validateObservedTime(
  stage: ProductionLiveCopyDurableStage,
  observedAt: number,
  previousObservedAt: number,
  blueprint: ProductionLiveCopyBlueprint,
): boolean {
  if (observedAt < blueprint.issuedAtUnixMs || observedAt < previousObservedAt) return false;
  if (stage === "target_challenge_expire") {
    return observedAt >= blueprint.captureAuthorizationDeadlineUnixMs;
  }
  if (
    stage === "target_challenge_issue" ||
    stage === "operator_grant_record" ||
    stage === "controller_grant_record" ||
    stage === "target_challenge_consume" ||
    stage === "target_capture_authorize_and_begin"
  ) {
    return observedAt < blueprint.captureAuthorizationDeadlineUnixMs;
  }
  if (
    stage === "source_capture_consume_under_stop_lease" ||
    stage === "source_capture_resume_same_staging" ||
    stage === "source_manifest_attest" ||
    stage === "source_bind_exact_manifest_state_tree_ciphertext_and_staging"
  ) {
    return observedAt < blueprint.captureAuthorizationDeadlineUnixMs &&
      observedAt < blueprint.sourceStopLeaseDeadlineUnixMs;
  }
  if (
    stage === "target_transfer_authorize_and_begin" ||
    stage === "target_receive_encrypted_staging" ||
    stage === "target_verify_source_manifest_attestation" ||
    stage === "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding" ||
    stage === "target_restore_verified_state_to_quarantine" ||
    stage === "target_promote_restored_state" ||
    stage === "target_finalize"
  ) {
    return observedAt < blueprint.transferAuthorizationDeadlineUnixMs &&
      observedAt < blueprint.targetQuarantineLeaseDeadlineUnixMs;
  }
  if (stage === "target_destroy_and_attest") {
    return true;
  }
  return true;
}

function normalizeReceipt(
  raw: ParsedJson,
  stage: ProductionLiveCopyDurableStage,
  sequence: number,
  previousEventDigestSha256: string,
  previousObservedAt: number,
  artifact: ProductionLiveCopyLifecycleArtifact,
  blueprint: ProductionLiveCopyBlueprint,
  field: string,
): Result<
  ProductionLiveCopyLifecycleReceipt,
  InvalidProductionLiveCopyLifecycleHistoryError | ProductionLiveCopyLifecycleBindingMismatchError
> {
  const record = exactHistoryRecord(raw, RECEIPT_FIELDS, field);
  if (!record.ok) return record;
  if (
    record.value.schema !== "comis-production-live-copy-stage-receipt" ||
    record.value.schemaVersion !== 1 ||
    record.value.kind !== receiptKind(stage) ||
    record.value.runId !== blueprint.runId ||
    record.value.attemptId !== blueprint.attemptId ||
    record.value.stage !== stage ||
    record.value.sequence !== sequence
  ) {
    return err(bindingMismatch(field, "Stage receipt identity or closed kind does not match"));
  }
  const digestFields = [
    "authorityStoreIdentitySha256",
    "authorityStoreHeadDigestSha256",
    "sequenceAuthorityStoreIdentitySha256",
    "sequenceAuthorityStoreHeadDigestSha256",
    "sequencePredecessorDigestSha256",
    "sequenceHeadDigestSha256",
    "sourceStoppedGenerationSha256",
    "sourceStopLeaseIdentitySha256",
    "targetQuarantineGenerationSha256",
    "targetQuarantineLeaseIdentitySha256",
    "encryptionRecipientKeyIdSha256",
    "targetRecipientKeyPossessionAttestationDigestSha256",
    "targetRecipientKeyPossessionSignedPayloadDigestSha256",
    "targetRecipientKeyPossessionSignerKeyIdSha256",
    "trustedTimeAuthorityStoreIdentitySha256",
    "trustedTimeAuthorityStoreHeadDigestSha256",
    "trustedTimeReceiptDigestSha256",
    "signerKeyIdSha256",
    "signedPayloadDigestSha256",
    "trustedTimeSignerKeyIdSha256",
    "trustedTimeSignedPayloadDigestSha256",
    "receiptDigestSha256",
  ] as const;
  for (const digestField of digestFields) {
    const parsed = historyDigest(
      Reflect.get(record.value, digestField) as ParsedJson,
      `${field}.${digestField}`,
    );
    if (!parsed.ok) return parsed;
  }
  for (const numberField of [
    "sourceStopLeaseDeadlineUnixMs",
    "targetQuarantineLeaseDeadlineUnixMs",
    "observedAtUnixMs",
  ] as const) {
    const parsed = historyPositiveInteger(
      Reflect.get(record.value, numberField) as ParsedJson,
      `${field}.${numberField}`,
    );
    if (!parsed.ok) return parsed;
  }
  const [authorityIdentity, authorityHead] = receiptAuthority(stage, blueprint);
  if (
    record.value.authorityStoreIdentitySha256 !== authorityIdentity ||
    record.value.authorityStoreHeadDigestSha256 !== authorityHead ||
    record.value.sequenceAuthorityStoreIdentitySha256 !==
      blueprint.sequenceAuthorityStoreIdentitySha256 ||
    record.value.sequenceAuthorityStoreHeadDigestSha256 !==
      blueprint.sequenceAuthorityStoreHeadDigestSha256 ||
    record.value.sequencePredecessorDigestSha256 !== previousEventDigestSha256 ||
    record.value.sourceStoppedGenerationSha256 !== blueprint.sourceStoppedGenerationSha256 ||
    record.value.sourceStopLeaseIdentitySha256 !== blueprint.sourceStopLeaseIdentitySha256 ||
    record.value.sourceStopLeaseDeadlineUnixMs !== blueprint.sourceStopLeaseDeadlineUnixMs ||
    record.value.targetQuarantineGenerationSha256 !==
      blueprint.targetQuarantineGenerationSha256 ||
    record.value.targetQuarantineLeaseIdentitySha256 !==
      blueprint.targetQuarantineLeaseIdentitySha256 ||
    record.value.targetQuarantineLeaseDeadlineUnixMs !==
      blueprint.targetQuarantineLeaseDeadlineUnixMs ||
    record.value.encryptionRecipientKeyIdSha256 !==
      blueprint.encryptionRecipientKeyIdSha256 ||
    record.value.targetRecipientKeyPossessionAttestationDigestSha256 !==
      blueprint.target.recipientKeyPossessionAttestationDigestSha256 ||
    record.value.targetRecipientKeyPossessionSignedPayloadDigestSha256 !==
      blueprint.target.recipientKeyPossessionSignedPayloadDigestSha256 ||
    record.value.targetRecipientKeyPossessionSignerKeyIdSha256 !==
      blueprint.target.recipientKeyPossessionSignerKeyIdSha256 ||
    record.value.artifactKind !== artifact.kind ||
    record.value.artifactDigestSha256 !== artifact.digestSha256 ||
    record.value.subjectKind !== artifact.subjectKind ||
    record.value.subjectDigestSha256 !== artifact.subjectDigestSha256 ||
    record.value.predecessorArtifactKind !== artifact.predecessorArtifactKind ||
    record.value.predecessorArtifactDigestSha256 !==
      artifact.predecessorArtifactDigestSha256 ||
    record.value.trustedTimeAuthorityStoreIdentitySha256 !==
      blueprint.trustedTimeAuthorityStoreIdentitySha256 ||
    record.value.trustedTimeAuthorityStoreHeadDigestSha256 !==
      blueprint.trustedTimeAuthorityStoreHeadDigestSha256
  ) {
    return err(bindingMismatch(field, "Stage receipt does not bind its authority, lease, key, or artifact"));
  }
  const observedAt = record.value.observedAtUnixMs as number;
  if (!validateObservedTime(stage, observedAt, previousObservedAt, blueprint)) {
    return err(
      invalidHistory(
        `${field}.observedAtUnixMs`,
        "Trusted observed time is expired, non-monotonic, or outside its isolation lease",
      ),
    );
  }
  const expectedSequenceHead = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.receiptHead}\0${blueprint.runId}\0${blueprint.attemptId}\0${sequence}\0${stage}\0${previousEventDigestSha256}\0${artifact.kind}\0${artifact.digestSha256 ?? ""}\0${artifact.subjectKind}\0${artifact.subjectDigestSha256 ?? ""}\0${artifact.predecessorArtifactKind}\0${artifact.predecessorArtifactDigestSha256 ?? ""}`,
  );
  if (record.value.sequenceHeadDigestSha256 !== expectedSequenceHead) {
    return err(bindingMismatch(`${field}.sequenceHeadDigestSha256`, "Receipt sequence head is invalid"));
  }
  const timeSignature = historySignature(
    record.value.trustedTimeSignatureBase64,
    `${field}.trustedTimeSignatureBase64`,
  );
  if (!timeSignature.ok) return timeSignature;
  if (
    record.value.trustedTimeAuthenticationKind !== "ed25519_signature" ||
    record.value.trustedTimeSignerKeyIdSha256 !== blueprint.trustedTimeSigningKeyIdSha256
  ) {
    return err(bindingMismatch(field, "Trusted observed-time signing authority is substituted"));
  }
  const expectedTimePayload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.observedTime}\0${blueprint.trustedTimeAuthorityStoreIdentitySha256}\0${blueprint.trustedTimeAuthorityStoreHeadDigestSha256}\0${blueprint.trustedTimeSigningKeyIdSha256}\0${expectedSequenceHead}\0${observedAt}`,
  );
  const expectedTimeReceipt = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0observed_time\0${expectedTimePayload}\0${blueprint.trustedTimeSigningKeyIdSha256}\0${timeSignature.value}`,
  );
  if (
    record.value.trustedTimeSignedPayloadDigestSha256 !== expectedTimePayload ||
    record.value.trustedTimeReceiptDigestSha256 !== expectedTimeReceipt
  ) {
    return err(bindingMismatch(`${field}.trustedTimeReceiptDigestSha256`, "Observed time receipt is invalid"));
  }
  const [signerRole, signerKeyIdSha256] = artifactSigner(stage, blueprint);
  const receiptSignature = historySignature(
    record.value.signatureBase64,
    `${field}.signatureBase64`,
  );
  if (!receiptSignature.ok) return receiptSignature;
  if (
    record.value.authenticationKind !== "ed25519_signature" ||
    record.value.signerRole !== signerRole ||
    record.value.signerKeyIdSha256 !== signerKeyIdSha256
  ) {
    return err(bindingMismatch(field, "Stage receipt signing role or key is substituted"));
  }
  const receiptBody = {
    schema: "comis-production-live-copy-stage-receipt",
    schemaVersion: 1,
    kind: receiptKind(stage),
    runId: blueprint.runId,
    attemptId: blueprint.attemptId,
    stage,
    sequence,
    authorityStoreIdentitySha256: authorityIdentity,
    authorityStoreHeadDigestSha256: authorityHead,
    sequenceAuthorityStoreIdentitySha256: blueprint.sequenceAuthorityStoreIdentitySha256,
    sequenceAuthorityStoreHeadDigestSha256:
      blueprint.sequenceAuthorityStoreHeadDigestSha256,
    sequencePredecessorDigestSha256: previousEventDigestSha256,
    sequenceHeadDigestSha256: expectedSequenceHead,
    sourceStoppedGenerationSha256: blueprint.sourceStoppedGenerationSha256,
    sourceStopLeaseIdentitySha256: blueprint.sourceStopLeaseIdentitySha256,
    sourceStopLeaseDeadlineUnixMs: blueprint.sourceStopLeaseDeadlineUnixMs,
    targetQuarantineGenerationSha256: blueprint.targetQuarantineGenerationSha256,
    targetQuarantineLeaseIdentitySha256: blueprint.targetQuarantineLeaseIdentitySha256,
    targetQuarantineLeaseDeadlineUnixMs: blueprint.targetQuarantineLeaseDeadlineUnixMs,
    encryptionRecipientKeyIdSha256: blueprint.encryptionRecipientKeyIdSha256,
    targetRecipientKeyPossessionAttestationDigestSha256:
      blueprint.target.recipientKeyPossessionAttestationDigestSha256,
    targetRecipientKeyPossessionSignedPayloadDigestSha256:
      blueprint.target.recipientKeyPossessionSignedPayloadDigestSha256,
    targetRecipientKeyPossessionSignerKeyIdSha256:
      blueprint.target.recipientKeyPossessionSignerKeyIdSha256,
    artifactKind: artifact.kind,
    artifactDigestSha256: artifact.digestSha256,
    subjectKind: artifact.subjectKind,
    subjectDigestSha256: artifact.subjectDigestSha256,
    predecessorArtifactKind: artifact.predecessorArtifactKind,
    predecessorArtifactDigestSha256: artifact.predecessorArtifactDigestSha256,
    observedAtUnixMs: observedAt,
    trustedTimeAuthorityStoreIdentitySha256:
      blueprint.trustedTimeAuthorityStoreIdentitySha256,
    trustedTimeAuthorityStoreHeadDigestSha256:
      blueprint.trustedTimeAuthorityStoreHeadDigestSha256,
    trustedTimeReceiptDigestSha256: expectedTimeReceipt,
    trustedTimeAuthenticationKind: "ed25519_signature",
    trustedTimeSignerKeyIdSha256: blueprint.trustedTimeSigningKeyIdSha256,
    trustedTimeSignedPayloadDigestSha256: expectedTimePayload,
    trustedTimeSignatureBase64: timeSignature.value,
    authenticationKind: "ed25519_signature",
    signerRole,
    signerKeyIdSha256,
  } as const;
  const expectedReceiptPayload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.receipt}\0${canonicalJson(receiptBody as unknown as ParsedJson)}`,
  );
  const expectedReceiptDigest = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0stage_receipt\0${expectedReceiptPayload}\0${signerKeyIdSha256}\0${receiptSignature.value}`,
  );
  if (
    record.value.signedPayloadDigestSha256 !== expectedReceiptPayload ||
    record.value.receiptDigestSha256 !== expectedReceiptDigest
  ) {
    return err(bindingMismatch(`${field}.receiptDigestSha256`, "Stage receipt digest is invalid"));
  }
  return ok(Object.freeze({
    ...receiptBody,
    signedPayloadDigestSha256: expectedReceiptPayload,
    signatureBase64: receiptSignature.value,
    receiptDigestSha256: expectedReceiptDigest,
  }));
}

function roleDisjointIdentifierDigests(
  blueprint: ProductionLiveCopyBlueprint,
): Result<ReadonlySet<string>, ProductionLiveCopyLifecycleBindingMismatchError> {
  const digests = new Set<string>();
  for (const path of PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS) {
    let current: unknown = blueprint;
    for (const segment of path.split(".")) {
      if (typeof current !== "object" || current === null) {
        return err(bindingMismatch(
          "artifact.recoveryGenerationSha256",
          "Declared role-disjoint blueprint path does not resolve to an identifier",
        ));
      }
      current = Reflect.get(current, segment);
    }
    if (typeof current !== "string") {
      return err(bindingMismatch(
        "artifact.recoveryGenerationSha256",
        "Declared role-disjoint blueprint path does not resolve to an identifier",
      ));
    }
    digests.add(current);
  }
  return digests.size === PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS.length
    ? ok(digests)
    : err(bindingMismatch(
        "artifact.recoveryGenerationSha256",
        "Declared role-disjoint blueprint identifiers are not unique",
      ));
}

interface ArtifactState {
  operatorGrant: string | null;
  controllerGrant: string | null;
  captureAuthorization: string | null;
  sourceCaptureStaging: string | null;
  sourceAttestation: string | null;
  sourceBinding: string | null;
  sourceEncryptedStaging: string | null;
  transferAuthorization: string | null;
  encryptedStagingReceipt: string | null;
  targetEncryptedStaging: string | null;
  sourceManifestVerification: string | null;
  targetAttestation: string | null;
  quarantineRestore: string | null;
  quarantinePlaintext: string | null;
  promotion: string | null;
  promotedPlaintext: string | null;
  finalization: string | null;
  abort: string | null;
  recoverySequence: number;
  lastRecoveryArtifactDigest: string | null;
  recoveryGenerationDigests: Set<string>;
  readonly staticDisjointIdentifierDigests: ReadonlySet<string>;
  readonly lifecycleIdentifierDigests: Set<string>;
  lastArtifactKind: ProductionLiveCopyArtifactKind | null;
  lastArtifactDigest: string | null;
  sensitiveSubjects: ProductionLiveCopySensitiveSubject[];
  cleanupAttested: boolean;
}

function emptyArtifactState(
  staticDisjointIdentifierDigests: ReadonlySet<string>,
  initialLifecycleIdentifierDigests: readonly string[],
): ArtifactState {
  return {
    operatorGrant: null,
    controllerGrant: null,
    captureAuthorization: null,
    sourceCaptureStaging: null,
    sourceAttestation: null,
    sourceBinding: null,
    sourceEncryptedStaging: null,
    transferAuthorization: null,
    encryptedStagingReceipt: null,
    targetEncryptedStaging: null,
    sourceManifestVerification: null,
    targetAttestation: null,
    quarantineRestore: null,
    quarantinePlaintext: null,
    promotion: null,
    promotedPlaintext: null,
    finalization: null,
    abort: null,
    recoverySequence: 0,
    lastRecoveryArtifactDigest: null,
    recoveryGenerationDigests: new Set<string>(),
    staticDisjointIdentifierDigests,
    lifecycleIdentifierDigests: new Set(initialLifecycleIdentifierDigests),
    lastArtifactKind: null,
    lastArtifactDigest: null,
    sensitiveSubjects: [],
    cleanupAttested: false,
  };
}

function lifecycleEventIdentifierDigests(
  event: ProductionLiveCopyLifecycleEvent,
): ReadonlySet<string> {
  return new Set([
    event.artifact.digestSha256,
    event.eventDigestSha256,
    event.receipt.receiptDigestSha256,
    event.receipt.trustedTimeReceiptDigestSha256,
    event.receipt.sequenceHeadDigestSha256,
    ...event.artifact.createdSensitiveSubjects.map(({ digestSha256 }) => digestSha256),
    ...event.artifact.cleanupSubjects.map(({ digestSha256 }) => digestSha256),
    ...event.artifact.cleanupAttestations.map(
      ({ attestationDigestSha256 }) => attestationDigestSha256,
    ),
  ]);
}

function rejectRecoveryGenerationIdentifierCollisions(
  identifiers: ReadonlySet<string>,
  state: ArtifactState,
): Result<void, ProductionLiveCopyLifecycleBindingMismatchError> {
  for (const identifier of identifiers) {
    if (state.recoveryGenerationDigests.has(identifier)) {
      return err(bindingMismatch(
        "artifact.recoveryGenerationSha256",
        "Recovery generation aliases an artifact, event, receipt, or sensitive-subject identity",
      ));
    }
  }
  return ok(undefined);
}

function artifactMatches(
  artifact: ProductionLiveCopyLifecycleArtifact,
  kind: ProductionLiveCopyArtifactKind,
  subjectKind: ProductionLiveCopyArtifactReferenceKind = "none",
  subjectDigest: string | null = null,
  predecessorKind: ProductionLiveCopyArtifactReferenceKind = "none",
  predecessorDigest: string | null = null,
): boolean {
  return artifact.kind === kind &&
    artifact.subjectKind === subjectKind &&
    artifact.subjectDigestSha256 === subjectDigest &&
    artifact.predecessorArtifactKind === predecessorKind &&
    artifact.predecessorArtifactDigestSha256 === predecessorDigest;
}

function expectedCreatedSubjectKind(
  stage: ProductionLiveCopyDurableStage,
): ProductionLiveCopySensitiveSubjectKind | null {
  switch (stage) {
    case "source_capture_consume_under_stop_lease":
      return "source_capture_workspace";
    case "source_manifest_attest":
      return "source_snapshot_manifest";
    case "source_bind_exact_manifest_state_tree_ciphertext_and_staging":
      return "source_encrypted_staging";
    case "target_receive_encrypted_staging":
      return "target_encrypted_staging";
    case "target_restore_verified_state_to_quarantine":
      return "quarantine_plaintext";
    case "target_promote_restored_state":
      return "promoted_plaintext";
    default:
      return null;
  }
}

function sameSensitiveSubjects(
  left: readonly ProductionLiveCopySensitiveSubject[],
  right: readonly ProductionLiveCopySensitiveSubject[],
): boolean {
  return canonicalJson(left as unknown as ParsedJson) ===
    canonicalJson(right as unknown as ParsedJson);
}

function validateCreatedSubjects(
  stage: ProductionLiveCopyDurableStage,
  artifact: ProductionLiveCopyLifecycleArtifact,
  state: ArtifactState,
): Result<void, ProductionLiveCopyLifecycleBindingMismatchError> {
  const expectedKind = expectedCreatedSubjectKind(stage);
  if (
    (expectedKind === null && artifact.createdSensitiveSubjects.length !== 0) ||
    (expectedKind !== null &&
      (artifact.createdSensitiveSubjects.length !== 1 ||
        artifact.createdSensitiveSubjects[0]?.kind !== expectedKind))
  ) {
    return err(bindingMismatch(
      "artifact.createdSensitiveSubjects",
      "Stage-sensitive subject creation is absent, substituted, or premature",
    ));
  }
  for (const subject of artifact.createdSensitiveSubjects) {
    if (state.sensitiveSubjects.some(
      (existing) =>
        existing.kind === subject.kind ||
        existing.digestSha256 === subject.digestSha256,
    )) {
      return err(bindingMismatch(
        "artifact.createdSensitiveSubjects",
        "Sensitive subject identities must be globally single-use within a history",
      ));
    }
  }
  return ok(undefined);
}

function validateCleanupCoverage(
  artifact: ProductionLiveCopyLifecycleArtifact,
  state: ArtifactState,
  requireAttestations: boolean,
): Result<void, ProductionLiveCopyLifecycleBindingMismatchError> {
  if (!sameSensitiveSubjects(artifact.cleanupSubjects, state.sensitiveSubjects)) {
    return err(bindingMismatch(
      "artifact.cleanupSubjects",
      "Abort or destruction does not bind the exact sensitive-subject inventory",
    ));
  }
  if (!requireAttestations) {
    return artifact.cleanupAttestations.length === 0
      ? ok(undefined)
      : err(bindingMismatch(
          "artifact.cleanupAttestations",
          "Abort may bind cleanup obligations but cannot claim cleanup attestations",
        ));
  }
  const subjectKeys = state.sensitiveSubjects.map(
    ({ kind, digestSha256 }) => kind + ":" + digestSha256,
  );
  const attestationKeys = artifact.cleanupAttestations.map(
    ({ subjectKind, subjectDigestSha256 }) =>
      subjectKind + ":" + subjectDigestSha256,
  );
  return subjectKeys.length === attestationKeys.length &&
    subjectKeys.every((key, index) => key === attestationKeys.at(index))
    ? ok(undefined)
    : err(bindingMismatch(
        "artifact.cleanupAttestations",
        "Destruction or rollback attestations do not cover every exact sensitive subject",
      ));
}

interface ValidatedRecoveryBinding {
  readonly sequence: number;
  readonly generationSha256: string;
}

function validateRecoveryBinding(
  artifact: ProductionLiveCopyLifecycleArtifact,
  state: ArtifactState,
  currentEventIdentifierDigests: ReadonlySet<string>,
): Result<ValidatedRecoveryBinding, ProductionLiveCopyLifecycleBindingMismatchError> {
  if (artifact.recoverySequence !== state.recoverySequence + 1) {
    return err(bindingMismatch(
      "artifact.recoverySequence",
      "Recovery sequence does not continue the durable recovery chain",
    ));
  }
  const generationSha256 = artifact.recoveryGenerationSha256;
  if (
    generationSha256 === null ||
    state.recoveryGenerationDigests.has(generationSha256) ||
    state.staticDisjointIdentifierDigests.has(generationSha256) ||
    state.lifecycleIdentifierDigests.has(generationSha256) ||
    currentEventIdentifierDigests.has(generationSha256)
  ) {
    return err(bindingMismatch(
      "artifact.recoveryGenerationSha256",
      "Recovery generation is absent, reused, or aliases a reserved identity or recovery chain",
    ));
  }
  if (
    artifact.previousRecoveryArtifactDigestSha256 !==
      state.lastRecoveryArtifactDigest
  ) {
    return err(bindingMismatch(
      "artifact.previousRecoveryArtifactDigestSha256",
      "Recovery artifact does not bind the immediately preceding recovery",
    ));
  }
  return ok(Object.freeze({
    sequence: artifact.recoverySequence,
    generationSha256,
  }));
}

function validateAndRecordArtifact(
  stage: ProductionLiveCopyDurableStage,
  artifact: ProductionLiveCopyLifecycleArtifact,
  state: ArtifactState,
  challengeDigestSha256: string,
  currentEventIdentifierDigests: ReadonlySet<string>,
): Result<void, ProductionLiveCopyLifecycleBindingMismatchError> {
  const fail = (): Result<never, ProductionLiveCopyLifecycleBindingMismatchError> =>
    err(bindingMismatch(
      "artifact",
      "Stage artifact is absent, substituted, premature, or bound to the wrong subject or predecessor",
    ));
  const created = validateCreatedSubjects(stage, artifact, state);
  if (!created.ok) return created;
  const createdSubject = artifact.createdSensitiveSubjects[0];
  switch (stage) {
    case "target_challenge_issue":
      if (!artifactMatches(
        artifact,
        "challenge",
        "challenge_nonce",
        challengeDigestSha256,
      )) return fail();
      break;
    case "target_challenge_expire":
      if (
        state.lastArtifactKind === null ||
        state.lastArtifactDigest === null ||
        !artifactMatches(
          artifact,
          "challenge_expiry",
          "challenge_nonce",
          challengeDigestSha256,
          state.lastArtifactKind,
          state.lastArtifactDigest,
        )
      ) return fail();
      break;
    case "operator_grant_record":
      if (!artifactMatches(
        artifact,
        "operator_grant",
        "challenge_nonce",
        challengeDigestSha256,
        "challenge",
        state.lastArtifactDigest,
      )) return fail();
      state.operatorGrant = artifact.digestSha256;
      break;
    case "controller_grant_record":
      if (
        state.operatorGrant === null ||
        !artifactMatches(
          artifact,
          "controller_grant",
          "none",
          null,
          "operator_grant",
          state.operatorGrant,
        )
      ) return fail();
      state.controllerGrant = artifact.digestSha256;
      break;
    case "target_challenge_consume":
      if (
        state.controllerGrant === null ||
        !artifactMatches(
          artifact,
          "challenge_consumption",
          "challenge_nonce",
          challengeDigestSha256,
          "controller_grant",
          state.controllerGrant,
        )
      ) return fail();
      break;
    case "target_capture_authorize_and_begin":
      if (
        state.lastArtifactKind !== "challenge_consumption" ||
        state.lastArtifactDigest === null ||
        !artifactMatches(
          artifact,
          "capture_authorization",
          "none",
          null,
          "challenge_consumption",
          state.lastArtifactDigest,
        )
      ) return fail();
      state.captureAuthorization = artifact.digestSha256;
      break;
    case "source_capture_consume_under_stop_lease":
      if (
        state.captureAuthorization === null ||
        createdSubject?.kind !== "source_capture_workspace" ||
        !artifactMatches(
          artifact,
          "source_capture_staging",
          "source_capture_workspace",
          createdSubject.digestSha256,
          "capture_authorization",
          state.captureAuthorization,
        )
      ) return fail();
      state.sourceCaptureStaging = artifact.digestSha256;
      break;
    case "source_capture_resume_same_staging": {
      const recovery = validateRecoveryBinding(
        artifact,
        state,
        currentEventIdentifierDigests,
      );
      if (!recovery.ok) return recovery;
      if (
        state.captureAuthorization === null ||
        state.sourceCaptureStaging === null ||
        !artifactMatches(
          artifact,
          "recovery_contract",
          "source_capture_staging",
          state.sourceCaptureStaging,
          "capture_authorization",
          state.captureAuthorization,
        )
      ) return fail();
      state.recoverySequence = recovery.value.sequence;
      state.lastRecoveryArtifactDigest = artifact.digestSha256;
      state.recoveryGenerationDigests.add(recovery.value.generationSha256);
      break;
    }
    case "source_manifest_attest":
      if (
        createdSubject?.kind !== "source_snapshot_manifest" ||
        state.sourceCaptureStaging === null ||
        !artifactMatches(
          artifact,
          "source_attestation",
          "source_snapshot_manifest",
          createdSubject.digestSha256,
          "source_capture_staging",
          state.sourceCaptureStaging,
        )
      ) return fail();
      state.sourceAttestation = artifact.digestSha256;
      break;
    case "source_bind_exact_manifest_state_tree_ciphertext_and_staging":
      if (
        createdSubject?.kind !== "source_encrypted_staging" ||
        state.sourceAttestation === null ||
        !artifactMatches(
          artifact,
          "source_binding",
          "source_encrypted_staging",
          createdSubject.digestSha256,
          "source_attestation",
          state.sourceAttestation,
        )
      ) return fail();
      state.sourceBinding = artifact.digestSha256;
      state.sourceEncryptedStaging = createdSubject.digestSha256;
      break;
    case "target_transfer_authorize_and_begin":
      if (
        state.sourceBinding === null ||
        !artifactMatches(
          artifact,
          "transfer_authorization",
          "none",
          null,
          "source_binding",
          state.sourceBinding,
        )
      ) return fail();
      state.transferAuthorization = artifact.digestSha256;
      break;
    case "target_receive_encrypted_staging":
      if (
        state.sourceEncryptedStaging === null ||
        state.transferAuthorization === null ||
        createdSubject?.kind !== "target_encrypted_staging" ||
        !artifactMatches(
          artifact,
          "encrypted_staging_receipt",
          "source_encrypted_staging",
          state.sourceEncryptedStaging,
          "transfer_authorization",
          state.transferAuthorization,
        )
      ) return fail();
      state.encryptedStagingReceipt = artifact.digestSha256;
      state.targetEncryptedStaging = createdSubject.digestSha256;
      break;
    case "target_verify_source_manifest_attestation":
      if (
        state.sourceAttestation === null ||
        state.encryptedStagingReceipt === null ||
        !artifactMatches(
          artifact,
          "source_manifest_verification",
          "source_attestation",
          state.sourceAttestation,
          "encrypted_staging_receipt",
          state.encryptedStagingReceipt,
        )
      ) return fail();
      state.sourceManifestVerification = artifact.digestSha256;
      break;
    case "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding":
      if (
        state.sourceBinding === null ||
        state.sourceManifestVerification === null ||
        !artifactMatches(
          artifact,
          "target_attestation",
          "source_binding",
          state.sourceBinding,
          "source_manifest_verification",
          state.sourceManifestVerification,
        )
      ) return fail();
      state.targetAttestation = artifact.digestSha256;
      break;
    case "target_restore_verified_state_to_quarantine":
      if (
        state.targetEncryptedStaging === null ||
        state.targetAttestation === null ||
        createdSubject?.kind !== "quarantine_plaintext" ||
        !artifactMatches(
          artifact,
          "quarantine_restore",
          "target_encrypted_staging",
          state.targetEncryptedStaging,
          "target_attestation",
          state.targetAttestation,
        )
      ) return fail();
      state.quarantineRestore = artifact.digestSha256;
      state.quarantinePlaintext = createdSubject.digestSha256;
      break;
    case "target_promote_restored_state":
      if (
        state.quarantinePlaintext === null ||
        state.quarantineRestore === null ||
        createdSubject?.kind !== "promoted_plaintext" ||
        !artifactMatches(
          artifact,
          "promotion",
          "quarantine_plaintext",
          state.quarantinePlaintext,
          "quarantine_restore",
          state.quarantineRestore,
        )
      ) return fail();
      state.promotion = artifact.digestSha256;
      state.promotedPlaintext = createdSubject.digestSha256;
      break;
    case "target_finalize":
      if (
        state.promotion === null ||
        !artifactMatches(
          artifact,
          "finalization",
          "none",
          null,
          "promotion",
          state.promotion,
        )
      ) return fail();
      state.finalization = artifact.digestSha256;
      break;
    case "target_abort": {
      if (
        state.lastArtifactKind === null ||
        state.lastArtifactDigest === null ||
        !artifactMatches(
          artifact,
          "abort",
          "none",
          null,
          state.lastArtifactKind,
          state.lastArtifactDigest,
        )
      ) return fail();
      const coverage = validateCleanupCoverage(artifact, state, false);
      if (!coverage.ok) return coverage;
      state.abort = artifact.digestSha256;
      break;
    }
    case "target_destroy_and_attest": {
      const terminalKind = state.finalization !== null ? "finalization" : "abort";
      const terminalDigest = state.finalization ?? state.abort;
      if (
        terminalDigest === null ||
        !artifactMatches(
          artifact,
          "destruction_attestation",
          "none",
          null,
          terminalKind,
          terminalDigest,
        )
      ) return fail();
      const coverage = validateCleanupCoverage(artifact, state, true);
      if (!coverage.ok) return coverage;
      state.cleanupAttested = true;
      break;
    }
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
  state.sensitiveSubjects.push(...artifact.createdSensitiveSubjects);
  state.sensitiveSubjects.sort((left, right) => {
    const leftKey = `${left.kind}:${left.digestSha256}`;
    const rightKey = `${right.kind}:${right.digestSha256}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  state.lastArtifactKind = artifact.kind;
  state.lastArtifactDigest = artifact.digestSha256;
  return ok(undefined);
}
function illegalTransition(
  state: ProductionLiveCopyLifecycleState,
  event: ProductionLiveCopyLifecycleEvent,
): IllegalProductionLiveCopyLifecycleTransitionError {
  return Object.freeze({
    kind: "illegal_lifecycle_transition" as const,
    sequence: event.sequence,
    stage: event.stage,
    state,
    message: "Lifecycle stage is not legal from the current durable state",
  });
}

const ABORTABLE_STATES = new Set<ProductionLiveCopyLifecycleState>([
  "challenge_consumed",
  "capture_authorized",
  "source_capture_active",
  "source_capture_resuming",
  "source_attested",
  "source_bound",
  "transfer_authorized",
  "received",
  "source_verified",
  "target_verified",
  "restored",
  "promoted",
]);

function advanceLifecycle(
  state: ProductionLiveCopyLifecycleState,
  event: ProductionLiveCopyLifecycleEvent,
): Result<ProductionLiveCopyLifecycleState, IllegalProductionLiveCopyLifecycleTransitionError> {
  if (event.stage === "target_abort" && ABORTABLE_STATES.has(state)) return ok("aborted");
  if (
    event.stage === "target_challenge_expire" &&
    (state === "challenge_issued" || state === "operator_granted" || state === "controller_granted")
  ) return ok("challenge_expired");
  switch (state) {
    case "initial":
      return event.stage === "target_challenge_issue" ? ok("challenge_issued") : err(illegalTransition(state, event));
    case "challenge_issued":
      return event.stage === "operator_grant_record" ? ok("operator_granted") : err(illegalTransition(state, event));
    case "operator_granted":
      return event.stage === "controller_grant_record" ? ok("controller_granted") : err(illegalTransition(state, event));
    case "controller_granted":
      return event.stage === "target_challenge_consume" ? ok("challenge_consumed") : err(illegalTransition(state, event));
    case "challenge_consumed":
      return event.stage === "target_capture_authorize_and_begin" ? ok("capture_authorized") : err(illegalTransition(state, event));
    case "capture_authorized":
      return event.stage === "source_capture_consume_under_stop_lease" ? ok("source_capture_active") : err(illegalTransition(state, event));
    case "source_capture_active":
    case "source_capture_resuming":
      if (event.stage === "source_capture_resume_same_staging") return ok("source_capture_resuming");
      return event.stage === "source_manifest_attest" ? ok("source_attested") : err(illegalTransition(state, event));
    case "source_attested":
      return event.stage === "source_bind_exact_manifest_state_tree_ciphertext_and_staging" ? ok("source_bound") : err(illegalTransition(state, event));
    case "source_bound":
      return event.stage === "target_transfer_authorize_and_begin" ? ok("transfer_authorized") : err(illegalTransition(state, event));
    case "transfer_authorized":
      return event.stage === "target_receive_encrypted_staging" ? ok("received") : err(illegalTransition(state, event));
    case "received":
      return event.stage === "target_verify_source_manifest_attestation" ? ok("source_verified") : err(illegalTransition(state, event));
    case "source_verified":
      return event.stage === "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding" ? ok("target_verified") : err(illegalTransition(state, event));
    case "target_verified":
      return event.stage === "target_restore_verified_state_to_quarantine" ? ok("restored") : err(illegalTransition(state, event));
    case "restored":
      return event.stage === "target_promote_restored_state" ? ok("promoted") : err(illegalTransition(state, event));
    case "promoted":
      return event.stage === "target_finalize" ? ok("finalized") : err(illegalTransition(state, event));
    case "finalized":
    case "aborted":
      return event.stage === "target_destroy_and_attest" ? ok("destroyed") : err(illegalTransition(state, event));
    case "challenge_expired":
    case "destroyed":
      return err(illegalTransition(state, event));
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

interface HistoryHeader {
  readonly blueprintDigestSha256: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly challengeDigestSha256: string;
  readonly stagingNamespaceDigestSha256: string;
  readonly globalReplayKeySha256: string;
  readonly sequencePredecessorDigestSha256: string;
  readonly sequenceHeadDigestSha256: string;
  readonly sequenceNoForkProofDigestSha256: string;
  readonly historyStatus: "in_progress" | "complete";
}

function expectedGlobalReplayKey(
  blueprint: ProductionLiveCopyBlueprint,
  challengeDigestSha256: string,
): string {
  return sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.globalReplay}\0${challengeDigestSha256}\0${blueprint.sourceStoppedGenerationSha256}\0${blueprint.sourceStopLeaseIdentitySha256}\0${blueprint.targetQuarantineGenerationSha256}\0${blueprint.targetQuarantineLeaseIdentitySha256}\0${blueprint.encryptionRecipientKeyIdSha256}\0${blueprint.stagingNamespaceDigestSha256}`,
  );
}

function artifactUseEntry(
  identityClass: ProductionLiveCopyArtifactUseIdentityClass,
  digestSha256: string,
): ProductionLiveCopyArtifactUseRegistryEntry {
  return Object.freeze({ identityClass, digestSha256 });
}

function artifactUseEntries(
  blueprint: ProductionLiveCopyBlueprint,
  challengeDigestSha256: string,
  events: readonly ProductionLiveCopyLifecycleEvent[],
  auditTimeReceiptDigestSha256: string,
): Result<
  readonly ProductionLiveCopyArtifactUseRegistryEntry[],
  ProductionLiveCopyLifecycleBindingMismatchError
> {
  const entries: ProductionLiveCopyArtifactUseRegistryEntry[] = [
    artifactUseEntry("attestation", blueprint.source.endpointAttestationDigestSha256),
    artifactUseEntry("attestation", blueprint.target.endpointAttestationDigestSha256),
    artifactUseEntry(
      "attestation",
      blueprint.target.recipientKeyPossessionAttestationDigestSha256,
    ),
    artifactUseEntry("receipt", blueprint.issuanceTimeReceiptDigestSha256),
    artifactUseEntry("receipt", auditTimeReceiptDigestSha256),
    artifactUseEntry("artifact", challengeDigestSha256),
    artifactUseEntry("artifact", blueprint.stagingNamespaceDigestSha256),
    artifactUseEntry("artifact", blueprint.source.dataDirCommitmentSha256),
    artifactUseEntry("artifact", blueprint.target.dataDirCommitmentSha256),
    artifactUseEntry("authority_generation", blueprint.sourceStoppedGenerationSha256),
    artifactUseEntry("authority_generation", blueprint.sourceStopLeaseIdentitySha256),
    artifactUseEntry("authority_generation", blueprint.targetQuarantineGenerationSha256),
    artifactUseEntry("authority_generation", blueprint.targetQuarantineLeaseIdentitySha256),
    artifactUseEntry("authority_generation", blueprint.encryptionRecipientKeyIdSha256),
  ];
  for (const event of events) {
    entries.push(
      artifactUseEntry("artifact", event.artifact.digestSha256),
      artifactUseEntry("receipt", event.receipt.receiptDigestSha256),
      artifactUseEntry("receipt", event.receipt.trustedTimeReceiptDigestSha256),
      artifactUseEntry("event", event.eventDigestSha256),
    );
    if (event.artifact.recoveryGenerationSha256 !== null) {
      entries.push(artifactUseEntry(
        "authority_generation",
        event.artifact.recoveryGenerationSha256,
      ));
    }
    if (
      event.artifact.kind === "operator_grant" ||
      event.artifact.kind === "controller_grant" ||
      event.artifact.kind === "source_attestation" ||
      event.artifact.kind === "source_manifest_verification" ||
      event.artifact.kind === "target_attestation"
    ) {
      entries.push(artifactUseEntry("attestation", event.artifact.digestSha256));
    }
    if (event.artifact.kind === "finalization") {
      entries.push(artifactUseEntry("finalization", event.artifact.digestSha256));
    }
    if (event.artifact.kind === "destruction_attestation") {
      entries.push(artifactUseEntry("destruction", event.artifact.digestSha256));
    }
    for (const subject of event.artifact.createdSensitiveSubjects) {
      entries.push(artifactUseEntry("sensitive_subject", subject.digestSha256));
      if (
        subject.kind === "source_encrypted_staging" ||
        subject.kind === "target_encrypted_staging"
      ) {
        entries.push(artifactUseEntry("ciphertext", subject.digestSha256));
      }
    }
    for (const attestation of event.artifact.cleanupAttestations) {
      entries.push(
        artifactUseEntry("attestation", attestation.attestationDigestSha256),
        artifactUseEntry("destruction", attestation.attestationDigestSha256),
      );
    }
  }
  const unique = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.identityClass}:${entry.digestSha256}`;
    if (unique.has(key)) {
      return err(bindingMismatch(
        "externalArtifactUseRegistry.entries",
        "Artifact-use registry construction produced a duplicate same-class identity",
      ));
    }
    unique.add(key);
  }
  return ok(Object.freeze([...entries].sort((left, right) => {
    const leftKey = `${left.identityClass}:${left.digestSha256}`;
    const rightKey = `${right.identityClass}:${right.digestSha256}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })));
}

function normalizeArtifactUseRegistry(
  raw: ParsedJson,
  expectedEntries: readonly ProductionLiveCopyArtifactUseRegistryEntry[],
  sequenceHeadDigestSha256: string,
  blueprint: ProductionLiveCopyBlueprint,
): Result<
  ProductionLiveCopyExternalArtifactUseRegistryClaim,
  InvalidProductionLiveCopyLifecycleHistoryError | ProductionLiveCopyLifecycleBindingMismatchError
> {
  const field = "externalArtifactUseRegistry";
  const record = exactHistoryRecord(raw, ARTIFACT_USE_REGISTRY_KEYS, field);
  if (!record.ok) return record;
  if (
    record.value.schema !== "comis-production-live-copy-artifact-use-registry-claim" ||
    record.value.schemaVersion !== 1 ||
    record.value.storeIdentitySha256 !== blueprint.artifactUseRegistryStoreIdentitySha256 ||
    record.value.predecessorHeadDigestSha256 !==
      blueprint.artifactUseRegistryStoreHeadDigestSha256 ||
    record.value.authenticationKind !== "ed25519_signature" ||
    record.value.signerKeyIdSha256 !== blueprint.artifactUseRegistrySigningKeyIdSha256 ||
    !Array.isArray(record.value.entries) ||
    record.value.entries.length > 2048
  ) {
    return err(bindingMismatch(field, "External artifact-use registry authority or schema is substituted"));
  }
  const entries: ProductionLiveCopyArtifactUseRegistryEntry[] = [];
  for (const [index, rawEntry] of record.value.entries.entries()) {
    const entry = exactHistoryRecord(rawEntry, ARTIFACT_USE_ENTRY_KEYS, `${field}.entries.${index}`);
    if (!entry.ok) return entry;
    if (
      typeof entry.value.identityClass !== "string" ||
      !PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT.identityClasses.includes(
        entry.value.identityClass as ProductionLiveCopyArtifactUseIdentityClass,
      )
    ) {
      return err(invalidHistory(`${field}.entries.${index}`, "Artifact-use identity class is not closed"));
    }
    const digest = historyDigest(
      entry.value.digestSha256,
      `${field}.entries.${index}.digestSha256`,
    );
    if (!digest.ok) return digest;
    entries.push(Object.freeze({
      identityClass:
        entry.value.identityClass as ProductionLiveCopyArtifactUseIdentityClass,
      digestSha256: digest.value,
    }));
  }
  if (canonicalJson(entries as unknown as ParsedJson) !==
    canonicalJson(expectedEntries as unknown as ParsedJson)) {
    return err(bindingMismatch(`${field}.entries`, "Artifact-use registry omits, reorders, or substitutes an identity"));
  }
  const entrySetDigestSha256 = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactUseSet}\0${canonicalJson(entries as unknown as ParsedJson)}`,
  );
  const signature = historySignature(record.value.signatureBase64, `${field}.signatureBase64`);
  if (!signature.ok) return signature;
  const registryBody = {
    schema: "comis-production-live-copy-artifact-use-registry-claim",
    schemaVersion: 1,
    storeIdentitySha256: blueprint.artifactUseRegistryStoreIdentitySha256,
    predecessorHeadDigestSha256: blueprint.artifactUseRegistryStoreHeadDigestSha256,
    entries,
    entrySetDigestSha256,
    authenticationKind: "ed25519_signature",
    signerKeyIdSha256: blueprint.artifactUseRegistrySigningKeyIdSha256,
  } as const;
  const signedPayloadDigestSha256 = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactUseRegistryHead}\0payload\0${sequenceHeadDigestSha256}\0${canonicalJson(registryBody as unknown as ParsedJson)}`,
  );
  const claimedHeadDigestSha256 = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactUseRegistryHead}\0head\0${blueprint.artifactUseRegistryStoreHeadDigestSha256}\0${entrySetDigestSha256}\0${sequenceHeadDigestSha256}\0${signedPayloadDigestSha256}\0${signature.value}`,
  );
  if (
    record.value.entrySetDigestSha256 !== entrySetDigestSha256 ||
    record.value.signedPayloadDigestSha256 !== signedPayloadDigestSha256 ||
    record.value.claimedHeadDigestSha256 !== claimedHeadDigestSha256
  ) {
    return err(bindingMismatch(field, "Artifact-use registry set, signed payload, or claimed head is invalid"));
  }
  return ok(Object.freeze({
    ...registryBody,
    entries: Object.freeze(entries),
    signedPayloadDigestSha256,
    signatureBase64: signature.value,
    claimedHeadDigestSha256,
  }));
}

function normalizeEvent(
  raw: ParsedJson,
  sequence: number,
  previousEventDigestSha256: string,
  previousObservedAt: number,
  header: HistoryHeader,
  blueprint: ProductionLiveCopyBlueprint,
): Result<
  ProductionLiveCopyLifecycleEvent,
  InvalidProductionLiveCopyLifecycleHistoryError | ProductionLiveCopyLifecycleBindingMismatchError
> {
  const field = `events.${sequence - 1}`;
  const record = exactHistoryRecord(raw, EVENT_KEYS, field);
  if (!record.ok) return record;
  if (
    record.value.sequence !== sequence ||
    typeof record.value.stage !== "string" ||
    !STAGE_SET.has(record.value.stage)
  ) {
    return err(invalidHistory(field, "Lifecycle sequence or stage is invalid"));
  }
  const stage = record.value.stage as ProductionLiveCopyDurableStage;
  if (
    record.value.blueprintDigestSha256 !== header.blueprintDigestSha256 ||
    record.value.runId !== header.runId ||
    record.value.attemptId !== header.attemptId ||
    record.value.challengeDigestSha256 !== header.challengeDigestSha256 ||
    record.value.stagingNamespaceDigestSha256 !== header.stagingNamespaceDigestSha256 ||
    record.value.previousEventDigestSha256 !== previousEventDigestSha256
  ) {
    return err(bindingMismatch(field, "Lifecycle event identity or sequence predecessor is substituted"));
  }
  const artifact = normalizeArtifact(
    record.value.artifact,
    stage,
    blueprint,
    `${field}.artifact`,
  );
  if (!artifact.ok) return artifact;
  const receipt = normalizeReceipt(
    record.value.receipt,
    stage,
    sequence,
    previousEventDigestSha256,
    previousObservedAt,
    artifact.value,
    blueprint,
    `${field}.receipt`,
  );
  if (!receipt.ok) return receipt;
  const eventBody = {
    sequence,
    stage,
    blueprintDigestSha256: header.blueprintDigestSha256,
    runId: header.runId,
    attemptId: header.attemptId,
    challengeDigestSha256: header.challengeDigestSha256,
    stagingNamespaceDigestSha256: header.stagingNamespaceDigestSha256,
    artifact: artifact.value,
    receipt: receipt.value,
    previousEventDigestSha256,
  } as const;
  const expectedEventDigest = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.event}\0${canonicalJson(eventBody as unknown as ParsedJson)}`,
  );
  if (record.value.eventDigestSha256 !== expectedEventDigest) {
    return err(bindingMismatch(`${field}.eventDigestSha256`, "Lifecycle event digest is invalid"));
  }
  return ok(Object.freeze({ ...eventBody, eventDigestSha256: expectedEventDigest }));
}

export function parseProductionLiveCopyLifecycleHistory(
  rawHistory: unknown,
  rawBlueprint: unknown,
): Result<
  ProductionLiveCopyLifecycleStructuralInspection,
  ProductionLiveCopyLifecycleHistoryError
> {
  const blueprint = parseProductionLiveCopyBlueprint(rawBlueprint);
  if (!blueprint.ok) return blueprint;
  if (typeof rawBlueprint !== "string") {
    return err(invalidBlueprint("boundary", "Blueprint must be canonical JSON text"));
  }
  const parsed = parseCanonicalJsonLine(rawHistory, MAX_HISTORY_BYTES);
  if (!parsed.ok) return err(invalidHistory(parsed.error.field, parsed.error.message));
  const record = exactHistoryRecord(parsed.value, HISTORY_KEYS, "input");
  if (!record.ok) return record;
  if (
    record.value.schema !== "comis-production-live-copy-lifecycle-history" ||
    record.value.schemaVersion !== 1 ||
    (record.value.historyStatus !== "in_progress" &&
      record.value.historyStatus !== "complete") ||
    (record.value.retentionAuditStatus !== "within_policy" &&
      record.value.retentionAuditStatus !== "overdue_cleanup_required" &&
      record.value.retentionAuditStatus !== "late_cleanup_recorded")
  ) {
    return err(invalidHistory("header", "Lifecycle history header is invalid"));
  }
  const expectedBlueprintDigest = sha256(rawBlueprint);
  const challengeDigest = sha256(
    Buffer.from(blueprint.value.challengeNonceBase64, "base64"),
  );
  const globalReplayKey = expectedGlobalReplayKey(blueprint.value, challengeDigest);
  if (
    record.value.blueprintDigestSha256 !== expectedBlueprintDigest ||
    record.value.runId !== blueprint.value.runId ||
    record.value.attemptId !== blueprint.value.attemptId ||
    record.value.challengeDigestSha256 !== challengeDigest ||
    record.value.sourceEndpointAttestationDigestSha256 !==
      blueprint.value.source.endpointAttestationDigestSha256 ||
    record.value.targetEndpointAttestationDigestSha256 !==
      blueprint.value.target.endpointAttestationDigestSha256 ||
    record.value.stagingNamespaceDigestSha256 !==
      blueprint.value.stagingNamespaceDigestSha256 ||
    record.value.globalReplayKeySha256 !== globalReplayKey ||
    record.value.sequencePredecessorDigestSha256 !==
      blueprint.value.sequenceAuthorityStoreHeadDigestSha256
  ) {
    return err(bindingMismatch(
      "blueprintBinding",
      "Lifecycle history does not bind the exact blueprint",
    ));
  }
  for (const field of [
    "blueprintDigestSha256",
    "challengeDigestSha256",
    "sourceEndpointAttestationDigestSha256",
    "targetEndpointAttestationDigestSha256",
    "stagingNamespaceDigestSha256",
    "globalReplayKeySha256",
    "sequencePredecessorDigestSha256",
    "sequenceHeadDigestSha256",
    "sequenceNoForkProofDigestSha256",
    "trustedAsOfSignedPayloadDigestSha256",
    "trustedAsOfSignerKeyIdSha256",
    "trustedAsOfTimeReceiptDigestSha256",
  ] as const) {
    const checked = historyDigest(Reflect.get(record.value, field) as ParsedJson, field);
    if (!checked.ok) return checked;
  }
  if (!Array.isArray(record.value.events) || record.value.events.length > MAX_HISTORY_EVENTS) {
    return err(invalidHistory("events", "Lifecycle events must be a bounded array"));
  }
  const header: HistoryHeader = {
    blueprintDigestSha256: expectedBlueprintDigest,
    runId: blueprint.value.runId,
    attemptId: blueprint.value.attemptId,
    challengeDigestSha256: challengeDigest,
    stagingNamespaceDigestSha256: blueprint.value.stagingNamespaceDigestSha256,
    globalReplayKeySha256: globalReplayKey,
    sequencePredecessorDigestSha256:
      blueprint.value.sequenceAuthorityStoreHeadDigestSha256,
    sequenceHeadDigestSha256: record.value.sequenceHeadDigestSha256 as string,
    sequenceNoForkProofDigestSha256:
      record.value.sequenceNoForkProofDigestSha256 as string,
    historyStatus: record.value.historyStatus,
  };
  const events: ProductionLiveCopyLifecycleEvent[] = [];
  const receiptDigests = new Set<string>();
  const timeReceipts = new Set<string>();
  const receiptHeads = new Set<string>();
  const artifactDigests = new Set<string>();
  const staticDisjointIdentifiers = roleDisjointIdentifierDigests(blueprint.value);
  if (!staticDisjointIdentifiers.ok) return staticDisjointIdentifiers;
  const artifactState = emptyArtifactState(staticDisjointIdentifiers.value, [
    challengeDigest,
    blueprint.value.issuanceTimeReceiptDigestSha256,
  ]);
  let state: ProductionLiveCopyLifecycleState = "initial";
  let previousEventDigest = header.sequencePredecessorDigestSha256;
  let previousObservedAt = blueprint.value.issuedAtUnixMs;
  let destructionObservedAt: number | null = null;
  for (const [index, rawEvent] of record.value.events.entries()) {
    const event = normalizeEvent(
      rawEvent,
      index + 1,
      previousEventDigest,
      previousObservedAt,
      header,
      blueprint.value,
    );
    if (!event.ok) return event;
    const eventIdentifierDigests = lifecycleEventIdentifierDigests(event.value);
    const generationCollision = rejectRecoveryGenerationIdentifierCollisions(
      eventIdentifierDigests,
      artifactState,
    );
    if (!generationCollision.ok) return generationCollision;
    const artifact = validateAndRecordArtifact(
      event.value.stage,
      event.value.artifact,
      artifactState,
      challengeDigest,
      eventIdentifierDigests,
    );
    if (!artifact.ok) return artifact;
    const advanced = advanceLifecycle(state, event.value);
    if (!advanced.ok) return advanced;
    state = advanced.value;
    for (const [set, digest, field] of [
      [receiptDigests, event.value.receipt.receiptDigestSha256, "receiptDigest"],
      [timeReceipts, event.value.receipt.trustedTimeReceiptDigestSha256, "trustedTimeReceipt"],
      [receiptHeads, event.value.receipt.sequenceHeadDigestSha256, "receiptSequenceHead"],
    ] as const) {
      if (set.has(digest)) {
        return err(invalidHistory(field, field + " must be single-use within a history"));
      }
      set.add(digest);
    }
    if (artifactDigests.has(event.value.artifact.digestSha256)) {
      return err(invalidHistory("artifact", "Created artifact digests must be single-use"));
    }
    artifactDigests.add(event.value.artifact.digestSha256);
    for (const identifier of eventIdentifierDigests) {
      artifactState.lifecycleIdentifierDigests.add(identifier);
    }
    if (event.value.artifact.recoveryGenerationSha256 !== null) {
      artifactState.lifecycleIdentifierDigests.add(
        event.value.artifact.recoveryGenerationSha256,
      );
    }
    events.push(event.value);
    previousEventDigest = event.value.eventDigestSha256;
    previousObservedAt = event.value.receipt.observedAtUnixMs;
    if (event.value.stage === "target_destroy_and_attest") {
      destructionObservedAt = event.value.receipt.observedAtUnixMs;
    }
  }
  if (header.sequenceHeadDigestSha256 !== previousEventDigest) {
    return err(bindingMismatch(
      "sequenceHeadDigestSha256",
      "Lifecycle sequence head is stale",
    ));
  }
  const expectedNoForkProof = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.noFork +
      "\0" + header.blueprintDigestSha256 +
      "\0" + header.globalReplayKeySha256 +
      "\0" + header.sequencePredecessorDigestSha256 +
      "\0" + header.sequenceHeadDigestSha256 +
      "\0" + events.length,
  );
  if (header.sequenceNoForkProofDigestSha256 !== expectedNoForkProof) {
    return err(bindingMismatch(
      "sequenceNoForkProofDigestSha256",
      "Lifecycle no-fork proof is invalid",
    ));
  }

  const trustedAsOf = historyPositiveInteger(
    record.value.trustedAsOfUnixMs,
    "trustedAsOfUnixMs",
  );
  if (!trustedAsOf.ok) return trustedAsOf;
  if (
    trustedAsOf.value < previousObservedAt ||
    record.value.trustedAsOfAuthenticationKind !== "ed25519_signature" ||
    record.value.trustedAsOfSignerKeyIdSha256 !==
      blueprint.value.trustedTimeSigningKeyIdSha256
  ) {
    return err(bindingMismatch(
      "trustedAsOfUnixMs",
      "Trusted as-of audit time is stale or uses a substituted authority",
    ));
  }
  const auditSignature = historySignature(
    record.value.trustedAsOfSignatureBase64,
    "trustedAsOfSignatureBase64",
  );
  if (!auditSignature.ok) return auditSignature;
  const expectedAuditPayload = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.auditTime +
      "\0" + blueprint.value.trustedTimeAuthorityStoreIdentitySha256 +
      "\0" + blueprint.value.trustedTimeAuthorityStoreHeadDigestSha256 +
      "\0" + blueprint.value.trustedTimeSigningKeyIdSha256 +
      "\0" + header.sequenceHeadDigestSha256 +
      "\0" + trustedAsOf.value,
  );
  const expectedAuditReceipt = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
      "\0audit_time\0" + expectedAuditPayload +
      "\0" + blueprint.value.trustedTimeSigningKeyIdSha256 +
      "\0" + auditSignature.value,
  );
  if (
    record.value.trustedAsOfSignedPayloadDigestSha256 !== expectedAuditPayload ||
    record.value.trustedAsOfTimeReceiptDigestSha256 !== expectedAuditReceipt
  ) {
    return err(bindingMismatch(
      "trustedAsOfTimeReceiptDigestSha256",
      "Trusted as-of audit receipt is invalid",
    ));
  }
  if (artifactState.recoveryGenerationDigests.has(expectedAuditReceipt)) {
    return err(bindingMismatch(
      "artifact.recoveryGenerationSha256",
      "Recovery generation aliases a trusted audit receipt identity",
    ));
  }

  const cleanupOutstanding =
    artifactState.sensitiveSubjects.length > 0 && !artifactState.cleanupAttested;
  const structurallyClosed =
    state === "challenge_expired" ||
    state === "destroyed" ||
    (state === "aborted" && !cleanupOutstanding);
  if (
    (header.historyStatus === "complete" && !structurallyClosed) ||
    (header.historyStatus === "in_progress" && structurallyClosed)
  ) {
    return err(invalidHistory(
      "historyStatus",
      "Lifecycle completion status disagrees with structural cleanup closure",
    ));
  }
  const retentionAuditStatus: ProductionLiveCopyRetentionAuditStatus =
    state === "destroyed" &&
      destructionObservedAt !== null &&
      destructionObservedAt >= blueprint.value.retentionPolicy.destructionDeadlineUnixMs
      ? "late_cleanup_recorded"
      : cleanupOutstanding &&
          trustedAsOf.value >= blueprint.value.retentionPolicy.destructionDeadlineUnixMs
        ? "overdue_cleanup_required"
        : "within_policy";
  const retentionPolicyBreached = retentionAuditStatus !== "within_policy";
  if (
    record.value.retentionAuditStatus !== retentionAuditStatus ||
    record.value.retentionPolicyBreached !== retentionPolicyBreached
  ) {
    return err(bindingMismatch(
      "retentionAuditStatus",
      "Retention audit status does not match trusted as-of time and cleanup inventory",
    ));
  }

  const expectedRegistryEntries = artifactUseEntries(
    blueprint.value,
    challengeDigest,
    events,
    expectedAuditReceipt,
  );
  if (!expectedRegistryEntries.ok) return expectedRegistryEntries;
  const registry = normalizeArtifactUseRegistry(
    record.value.externalArtifactUseRegistry,
    expectedRegistryEntries.value,
    header.sequenceHeadDigestSha256,
    blueprint.value,
  );
  if (!registry.ok) return registry;

  const canonicalValue = {
    schema: "comis-production-live-copy-lifecycle-history",
    schemaVersion: 1,
    blueprintDigestSha256: header.blueprintDigestSha256,
    runId: header.runId,
    attemptId: header.attemptId,
    challengeDigestSha256: header.challengeDigestSha256,
    sourceEndpointAttestationDigestSha256:
      blueprint.value.source.endpointAttestationDigestSha256,
    targetEndpointAttestationDigestSha256:
      blueprint.value.target.endpointAttestationDigestSha256,
    stagingNamespaceDigestSha256: header.stagingNamespaceDigestSha256,
    globalReplayKeySha256: header.globalReplayKeySha256,
    sequencePredecessorDigestSha256: header.sequencePredecessorDigestSha256,
    sequenceHeadDigestSha256: header.sequenceHeadDigestSha256,
    sequenceNoForkProofDigestSha256: header.sequenceNoForkProofDigestSha256,
    trustedAsOfUnixMs: trustedAsOf.value,
    trustedAsOfSignedPayloadDigestSha256: expectedAuditPayload,
    trustedAsOfAuthenticationKind: "ed25519_signature",
    trustedAsOfSignerKeyIdSha256: blueprint.value.trustedTimeSigningKeyIdSha256,
    trustedAsOfSignatureBase64: auditSignature.value,
    trustedAsOfTimeReceiptDigestSha256: expectedAuditReceipt,
    retentionAuditStatus,
    retentionPolicyBreached,
    externalArtifactUseRegistry: registry.value,
    historyStatus: header.historyStatus,
    events,
  } as unknown as ParsedJson;
  if (canonicalJson(canonicalValue) + "\n" !== rawHistory) {
    return err(invalidHistory("canonical", "Lifecycle history JSON is not canonical"));
  }
  return ok(Object.freeze({
    claimedState: state,
    structurallyClosed,
    cleanupOutstanding,
    retentionAuditStatus,
    retentionPolicyBreached,
    structuralStatus: "unverified_external_authorities" as const,
    exactExecutionEligible: false as const,
    globalReplayKeySha256: header.globalReplayKeySha256,
    sequenceHeadDigestSha256: header.sequenceHeadDigestSha256,
    externalArtifactUseRegistry: registry.value,
  }));
}

export function validateProductionLiveCopyLifecycleHistory(
  rawHistory: unknown,
  rawBlueprint: unknown,
): Result<never, ProductionLiveCopyLifecycleHistoryError> {
  const parsed = parseProductionLiveCopyLifecycleHistory(rawHistory, rawBlueprint);
  if (!parsed.ok) return parsed;
  return err(Object.freeze({
    kind: "global_replay_prevention_required" as const,
    exactExecutionEligible: false as const,
    globalReplayKeySha256: parsed.value.globalReplayKeySha256,
    artifactUseRegistryPredecessorHeadDigestSha256:
      parsed.value.externalArtifactUseRegistry.predecessorHeadDigestSha256,
    artifactUseRegistryClaimedHeadDigestSha256:
      parsed.value.externalArtifactUseRegistry.claimedHeadDigestSha256,
    artifactUseEntrySetDigestSha256:
      parsed.value.externalArtifactUseRegistry.entrySetDigestSha256,
    unverifiedAuthorityBlockers: PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS,
    contract: PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT,
    message:
      "Structural inspection cannot authorize live copy without signature verifiers and an external atomic monotonic artifact-use registry",
  }));
}
