// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  CASSETTE_KINDS,
  type ReplayCassetteKind,
} from "./production-bundle.js";
import {
  TRANSCRIPT_EVENT_KINDS,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  TRANSCRIPT_ORIGINS,
  TRANSCRIPT_SOURCE_EVENT_PREFIXES,
  type TranscriptActorKind,
  type TranscriptEventKind,
  type TranscriptOrigin,
  type TranscriptReplayPolicy,
  type TranscriptSourceKind,
  type TranscriptTrust,
} from "./production-transcript.js";

export const PRODUCTION_ACTIVITY_LEDGER_BEGIN = "COMIS_PRODUCTION_ACTIVITY_LEDGER_V1_BEGIN";
export const PRODUCTION_ACTIVITY_LEDGER_END = "COMIS_PRODUCTION_ACTIVITY_LEDGER_V1_END";
export const MAX_PRODUCTION_ACTIVITY_LEDGER_BYTES = 32 * 1024 * 1024;
export const MAX_PRODUCTION_ACTIVITY_BLOB_BYTES = 1024 * 1024 * 1024;
const MAX_LEDGER_ENTRIES = 100_000;
const MAX_SOURCE_AUTHORITIES = 10_000;
const MAX_SOURCE_EPOCHS = 100_000;
const MAX_CASSETTES = 100_000;
const MAX_CAUSAL_PARENTS = 32;
const MAX_CAUSAL_ANCESTORS = 4_096;
const MAX_COMMITMENT_INPUT_BYTES = 1024 * 1024;

export const PRODUCTION_ACTIVITY_KINDS = TRANSCRIPT_EVENT_KINDS;
export const PRODUCTION_ACTIVITY_SOURCE_KINDS = TRANSCRIPT_EXACT_SOURCE_KINDS;
export const PRODUCTION_ACTIVITY_CASSETTE_KINDS = CASSETTE_KINDS;

const SOURCE_PREFIXES = new Map<TranscriptSourceKind, readonly string[]>(
  Object.entries(TRANSCRIPT_SOURCE_EVENT_PREFIXES) as Array<
    [TranscriptSourceKind, readonly string[]]
  >,
);

export const PRODUCTION_ACTIVITY_EVENT_SOURCES = Object.freeze(
  Object.fromEntries(
    TRANSCRIPT_EVENT_KINDS.map((eventKind) => [
      eventKind,
      Object.freeze(
        TRANSCRIPT_EXACT_SOURCE_KINDS.filter((sourceKind) =>
          (SOURCE_PREFIXES.get(sourceKind) ?? []).some((prefix) =>
            eventKind.startsWith(prefix),
          ),
        ),
      ),
    ]),
  ) as Readonly<Record<TranscriptEventKind, readonly TranscriptSourceKind[]>>,
);

export type ProductionActivityCommitmentPurpose =
  | "actor"
  | "attestation"
  | "context"
  | "event"
  | "identity"
  | "payload"
  | "source";

export interface ProductionActivityLedgerKeys {
  readonly sealKey: Uint8Array;
  readonly commitmentKey: Uint8Array;
}

export interface ProductionActivityVaultBlobRef {
  readonly digestSha256: string;
  readonly plaintextBytes: number;
  readonly ciphertextBytes: number;
}

export interface ProductionActivityArtifact {
  readonly contentCommitmentSha256: string;
  readonly vaultBlob: ProductionActivityVaultBlobRef | null;
}

export type ProductionActivitySourceGap =
  | "capture_error"
  | "dropped_events"
  | "observer_unavailable"
  | "partial_retention"
  | "source_unavailable";

export interface ProductionActivitySourceEpoch {
  readonly ordinal: number;
  readonly epochId: string;
  readonly startWatermark: number;
  readonly endWatermark: number;
  readonly observedCount: number;
  readonly lossCount: number;
  readonly firstLedgerSequence: number | null;
  readonly lastLedgerSequence: number | null;
  readonly monotonicStartNs: string | null;
  readonly monotonicEndNs: string | null;
}

export interface ProductionActivitySourceAuthority {
  readonly kind: (typeof TRANSCRIPT_EXACT_SOURCE_KINDS)[number];
  readonly sourceIdCommitmentSha256: string;
  readonly status: "complete" | "gap";
  readonly gap: ProductionActivitySourceGap | null;
  readonly attestationCommitmentSha256: string;
  readonly epochs: readonly ProductionActivitySourceEpoch[];
}

export interface ProductionActivityLedgerEntryDraft {
  readonly sequence: number;
  readonly entryId: string;
  readonly eventIdentityCommitmentSha256: string;
  readonly source: {
    readonly kind: (typeof TRANSCRIPT_EXACT_SOURCE_KINDS)[number];
    readonly sourceIdCommitmentSha256: string;
    readonly epochId: string;
    readonly sequence: number;
  };
  readonly kind: TranscriptEventKind;
  readonly timing: {
    readonly wallTimeMs: number;
    readonly monotonicTimeNs: string;
    readonly clockId: string;
  };
  readonly causality: {
    readonly parentEntryIds: readonly string[];
    readonly traceCommitmentSha256: string | null;
    readonly sessionCommitmentSha256: string | null;
    readonly runCommitmentSha256: string | null;
    readonly jobCommitmentSha256: string | null;
  };
  readonly actor: {
    readonly kind: TranscriptActorKind;
    readonly identityCommitmentSha256: string | null;
    readonly trust: TranscriptTrust;
    readonly origin: TranscriptOrigin;
  };
  readonly payload: ProductionActivityArtifact;
  readonly replay: {
    readonly policy: TranscriptReplayPolicy;
    readonly cassetteId: string | null;
    readonly cassetteRole: "request" | "terminal" | null;
  };
}

export interface ProductionActivityLedgerEntry extends ProductionActivityLedgerEntryDraft {
  readonly previousEntryHashSha256: string;
  readonly entryHashSha256: string;
}

export interface ProductionActivityCassette {
  readonly cassetteId: string;
  readonly kind: ReplayCassetteKind;
  /** Ordinals are contiguous independently within each bundle cassette kind. */
  readonly ordinal: number;
  readonly requestEntryId: string;
  readonly terminalEntryId: string;
  readonly requestPayloadCommitmentSha256: string;
  readonly responsePayloadCommitmentSha256: string;
  readonly requestBlobDigestSha256: string | null;
  readonly responseBlobDigestSha256: string | null;
  readonly outcome: "success" | "error" | "timeout" | "cancelled";
  readonly latencyMs: number;
}

export interface ProductionActivityLedgerDraft {
  readonly captureId: string;
  readonly captureWindow: {
    readonly startedWallTimeMs: number;
    readonly endedWallTimeMs: number;
    readonly initialCheckpointManifestDigestSha256: string | null;
    readonly finalObservationDigestSha256: string | null;
  };
  readonly identity: {
    readonly sourceMachineCommitmentSha256: string;
    readonly buildCommitmentSha256: string;
    readonly configCommitmentSha256: string;
    readonly runtimeCommitmentSha256: string;
    readonly observerCommitmentSha256: string;
  };
  readonly determinism: {
    readonly clockSequence: ProductionActivityArtifact;
    readonly randomSequence: ProductionActivityArtifact;
    readonly identifierSequence: ProductionActivityArtifact;
  };
  readonly sourceAuthorities: readonly ProductionActivitySourceAuthority[];
  readonly entries: readonly ProductionActivityLedgerEntryDraft[];
  readonly cassettes: readonly ProductionActivityCassette[];
}

export type ProductionActivityCaptureBlocker =
  | { readonly kind: "authenticated_bundle_reconciliation_required" }
  | { readonly kind: "initial_checkpoint_missing" }
  | { readonly kind: "final_observation_missing" }
  | {
      readonly kind: "deterministic_sequence_missing";
      readonly sequenceKind: "clock" | "random" | "identifier";
    }
  | {
      readonly kind: "source_loss";
      readonly sourceKind: (typeof TRANSCRIPT_EXACT_SOURCE_KINDS)[number];
      readonly sourceIdCommitmentSha256: string;
      readonly gap: ProductionActivitySourceGap;
      readonly lossCount: number;
    }
  | {
      readonly kind: "injectable_payload_missing";
      readonly entryId: string;
    }
  | {
      readonly kind: "cassette_missing";
      readonly requestEntryId: string;
      readonly cassetteKind: ReplayCassetteKind;
    }
  | {
      readonly kind: "cassette_terminal_missing";
      readonly terminalEntryId: string;
      readonly cassetteKind: ReplayCassetteKind;
    }
  | {
      readonly kind: "cassette_blob_missing";
      readonly cassetteId: string;
      readonly endpoint: "request" | "response";
    };

export interface ProductionActivityCaptureAssertion {
  readonly classification: "bounded_capture";
  readonly replayReady: false;
  readonly blockers: readonly ProductionActivityCaptureBlocker[];
}

export interface ProductionActivityLedgerSeal {
  readonly algorithm: "hmac-sha256";
  readonly canonicalization: "comis-json-c14n-v1";
  readonly keyIdSha256: string;
  readonly ledgerDigestSha256: string;
  readonly authenticationTagSha256: string;
}

export interface ProductionActivityLedger extends ProductionActivityLedgerDraft {
  readonly schema: "comis-production-activity-ledger";
  readonly schemaVersion: 1;
  readonly commitmentKeyIdSha256: string;
  readonly genesisHashSha256: string;
  readonly entries: readonly ProductionActivityLedgerEntry[];
  readonly captureAssertion: ProductionActivityCaptureAssertion;
  readonly seal: ProductionActivityLedgerSeal;
}

export type ProductionActivityLedgerError =
  | { readonly kind: "invalid_key"; readonly message: string }
  | { readonly kind: "invalid_identifier_entropy"; readonly message: string }
  | { readonly kind: "invalid_commitment_input"; readonly message: string }
  | { readonly kind: "invalid_envelope"; readonly message: string }
  | {
      readonly kind: "invalid_ledger";
      readonly field:
        | "ledger"
        | "captureWindow"
        | "identity"
        | "determinism"
        | "sourceAuthorities"
        | "entries"
        | "order"
        | "causality"
        | "cassettes"
        | "captureAssertion"
        | "seal";
      readonly message: string;
    }
  | {
      readonly kind: "broken_hash_chain";
      readonly sequence: number;
      readonly message: string;
    }
  | { readonly kind: "invalid_authentication"; readonly message: string }
  | { readonly kind: "serialization_failed"; readonly message: string };

type InvalidField = Extract<
  ProductionActivityLedgerError,
  { kind: "invalid_ledger" }
>["field"];

interface CassetteLifecycle {
  readonly kind: ReplayCassetteKind;
  readonly terminals: readonly TranscriptEventKind[];
}

const SHA256_RE = /^[a-f0-9]{64}$/u;
const OPAQUE_ID_RE = /^rec_[A-Za-z0-9_-]{22}$/u;
const MONOTONIC_RE = /^(?:0|[1-9][0-9]{0,29})$/u;
const EVENT_KIND_VALUES = new Set<string>(TRANSCRIPT_EVENT_KINDS);
const SOURCE_KIND_VALUES = new Set<string>(TRANSCRIPT_EXACT_SOURCE_KINDS);
const CASSETTE_KIND_VALUES = new Set<string>(CASSETTE_KINDS);
const ACTOR_KIND_VALUES = new Set<string>([
  "user",
  "agent",
  "system",
  "service",
  "scheduler",
  "subagent",
  "provider",
  "operator",
]);
const TRUST_VALUES = new Set<string>(["guest", "user", "admin", "system", "external"]);
const ORIGIN_VALUES = new Set<string>(TRANSCRIPT_ORIGINS);
const REPLAY_POLICY_VALUES = new Set<string>([
  "inject",
  "stub",
  "assert",
  "execute",
  "observe",
  "skip",
]);
const SOURCE_GAP_VALUES = new Set<string>([
  "capture_error",
  "dropped_events",
  "observer_unavailable",
  "partial_retention",
  "source_unavailable",
]);
const OUTCOME_VALUES = new Set<string>(["success", "error", "timeout", "cancelled"]);
const COMMITMENT_PURPOSES = new Set<string>([
  "actor",
  "attestation",
  "context",
  "event",
  "identity",
  "payload",
  "source",
]);

const LIFECYCLES = new Map<TranscriptEventKind, CassetteLifecycle>([
  ...TRANSCRIPT_EVENT_KINDS.filter((kind) => /^channel\.native\..+_received$/u.test(kind)).map(
    (kind) => [kind, { kind: "channel", terminals: ["ingress.gate.admitted", "ingress.gate.rejected"] }] as const,
  ),
  ["cron.fire.started", { kind: "external_io", terminals: ["cron.fire.skipped", "cron.fire.completed"] }],
  ["heartbeat.requested", { kind: "external_io", terminals: ["heartbeat.skipped", "heartbeat.completed", "heartbeat.failed"] }],
  ["proactive.triggered", { kind: "external_io", terminals: ["proactive.dispatched", "proactive.dropped"] }],
  ["system.dispatch.enqueued", { kind: "external_io", terminals: ["system.dispatch.completed", "system.dispatch.failed"] }],
  ["internal.dispatch.enqueued", { kind: "external_io", terminals: ["internal.dispatch.completed", "internal.dispatch.failed"] }],
  ["subagent.spawn.requested", { kind: "external_io", terminals: ["subagent.completed", "subagent.failed", "subagent.cancelled"] }],
  ["model.request.started", { kind: "model", terminals: ["model.request.failed", "model.response.completed", "model.response.failed"] }],
  ["tool.call.started", { kind: "tool", terminals: ["tool.call.completed", "tool.call.failed"] }],
  ["mcp.call.started", { kind: "mcp", terminals: ["mcp.call.completed", "mcp.call.failed"] }],
  ["web.fetch.started", { kind: "web", terminals: ["web.fetch.completed", "web.fetch.failed"] }],
  ["media.resolve.started", { kind: "media", terminals: ["media.resolve.completed", "media.resolve.failed"] }],
  ["media.transcription.started", { kind: "media", terminals: ["media.transcription.completed", "media.transcription.failed"] }],
  ["media.analysis.started", { kind: "media", terminals: ["media.analysis.completed", "media.analysis.failed"] }],
  ["media.generation.started", { kind: "media", terminals: ["media.generation.completed", "media.generation.failed"] }],
  ["outbound.attempt.started", { kind: "channel", terminals: ["outbound.delivered", "outbound.failed"] }],
  ["dependency.request.started", { kind: "external_io", terminals: ["dependency.request.completed", "dependency.request.failed", "dependency.request.cancelled"] }],
  ["channel.outbound.request.started", { kind: "channel", terminals: ["channel.outbound.request.completed", "channel.outbound.request.failed", "channel.outbound.request.cancelled"] }],
  ["filesystem.read.started", { kind: "external_io", terminals: ["filesystem.read.completed", "filesystem.read.failed"] }],
  ["filesystem.list.started", { kind: "external_io", terminals: ["filesystem.list.completed", "filesystem.list.failed"] }],
  ["filesystem.metadata.started", { kind: "external_io", terminals: ["filesystem.metadata.completed", "filesystem.metadata.failed"] }],
  ["environment.read.started", { kind: "external_io", terminals: ["environment.read.completed", "environment.read.rejected"] }],
  ["external.io.network.started", { kind: "external_io", terminals: ["external.io.network.completed", "external.io.network.failed"] }],
  ["external.io.process.started", { kind: "external_io", terminals: ["external.io.process.completed", "external.io.process.failed"] }],
  ["external.io.stream.started", { kind: "external_io", terminals: ["external.io.stream.completed", "external.io.stream.failed"] }],
  ["external.io.ipc.started", { kind: "external_io", terminals: ["external.io.ipc.completed", "external.io.ipc.failed"] }],
]);

const REQUEST_KINDS_BY_TERMINAL = new Map<TranscriptEventKind, readonly TranscriptEventKind[]>(
  TRANSCRIPT_EVENT_KINDS.map((terminalKind) => [
    terminalKind,
    [...LIFECYCLES.entries()]
      .filter(([, lifecycle]) => lifecycle.terminals.includes(terminalKind))
      .map(([requestKind]) => requestKind),
  ]),
);

const DRAFT_KEYS = [
  "captureId",
  "captureWindow",
  "identity",
  "determinism",
  "sourceAuthorities",
  "entries",
  "cassettes",
] as const;
const LEDGER_KEYS = [
  "schema",
  "schemaVersion",
  ...DRAFT_KEYS,
  "commitmentKeyIdSha256",
  "genesisHashSha256",
  "captureAssertion",
  "seal",
] as const;
const WINDOW_KEYS = [
  "startedWallTimeMs",
  "endedWallTimeMs",
  "initialCheckpointManifestDigestSha256",
  "finalObservationDigestSha256",
] as const;
const IDENTITY_KEYS = [
  "sourceMachineCommitmentSha256",
  "buildCommitmentSha256",
  "configCommitmentSha256",
  "runtimeCommitmentSha256",
  "observerCommitmentSha256",
] as const;
const DETERMINISM_KEYS = ["clockSequence", "randomSequence", "identifierSequence"] as const;
const ARTIFACT_KEYS = ["contentCommitmentSha256", "vaultBlob"] as const;
const BLOB_KEYS = ["digestSha256", "plaintextBytes", "ciphertextBytes"] as const;
const AUTHORITY_KEYS = [
  "kind",
  "sourceIdCommitmentSha256",
  "status",
  "gap",
  "attestationCommitmentSha256",
  "epochs",
] as const;
const EPOCH_KEYS = [
  "ordinal",
  "epochId",
  "startWatermark",
  "endWatermark",
  "observedCount",
  "lossCount",
  "firstLedgerSequence",
  "lastLedgerSequence",
  "monotonicStartNs",
  "monotonicEndNs",
] as const;
const ENTRY_KEYS = [
  "sequence",
  "entryId",
  "eventIdentityCommitmentSha256",
  "source",
  "kind",
  "timing",
  "causality",
  "actor",
  "payload",
  "replay",
] as const;
const FULL_ENTRY_KEYS = [...ENTRY_KEYS, "previousEntryHashSha256", "entryHashSha256"] as const;
const ENTRY_SOURCE_KEYS = ["kind", "sourceIdCommitmentSha256", "epochId", "sequence"] as const;
const TIMING_KEYS = ["wallTimeMs", "monotonicTimeNs", "clockId"] as const;
const CAUSALITY_KEYS = [
  "parentEntryIds",
  "traceCommitmentSha256",
  "sessionCommitmentSha256",
  "runCommitmentSha256",
  "jobCommitmentSha256",
] as const;
const ACTOR_KEYS = ["kind", "identityCommitmentSha256", "trust", "origin"] as const;
const REPLAY_KEYS = ["policy", "cassetteId", "cassetteRole"] as const;
const CASSETTE_KEYS = [
  "cassetteId",
  "kind",
  "ordinal",
  "requestEntryId",
  "terminalEntryId",
  "requestPayloadCommitmentSha256",
  "responsePayloadCommitmentSha256",
  "requestBlobDigestSha256",
  "responseBlobDigestSha256",
  "outcome",
  "latencyMs",
] as const;
const ASSERTION_KEYS = ["classification", "replayReady", "blockers"] as const;
const SEAL_KEYS = [
  "algorithm",
  "canonicalization",
  "keyIdSha256",
  "ledgerDigestSha256",
  "authenticationTagSha256",
] as const;

function invalid(
  field: InvalidField,
  message: string,
): Result<never, ProductionActivityLedgerError> {
  return err({ kind: "invalid_ledger", field, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDenseBoundedArray(value: unknown, maximum: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_RE.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isMonotonic(value: unknown): value is string {
  return typeof value === "string" && MONOTONIC_RE.test(value);
}

function isNullableMonotonic(value: unknown): value is string | null {
  return value === null || isMonotonic(value);
}

function validKey(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength >= 32 && value.byteLength <= 64;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function validateKeys(raw: unknown): Result<ProductionActivityLedgerKeys, ProductionActivityLedgerError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["sealKey", "commitmentKey"]) ||
    !validKey(raw.sealKey) ||
    !validKey(raw.commitmentKey) ||
    equalBytes(raw.sealKey, raw.commitmentKey)
  ) {
    return err({
      kind: "invalid_key",
      message: "Ledger seal and commitment keys must be distinct 32 to 64 byte values",
    });
  }
  return ok({ sealKey: raw.sealKey, commitmentKey: raw.commitmentKey });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyId(domain: "seal" | "commitment", key: Uint8Array): string {
  return createHash("sha256")
    .update(`comis-production-activity-${domain}-key-v1\0`)
    .update(key)
    .digest("hex");
}

function equalHex(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function mintProductionActivityId(
  entropy: unknown,
): Result<string, ProductionActivityLedgerError> {
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
    return err({
      kind: "invalid_identifier_entropy",
      message: "Recorder identifiers require exactly 16 bytes of caller-supplied entropy",
    });
  }
  return ok(`rec_${Buffer.from(entropy).toString("base64url")}`);
}

export function commitProductionActivityValue(
  purpose: unknown,
  value: unknown,
  commitmentKey: unknown,
): Result<string, ProductionActivityLedgerError> {
  if (!validKey(commitmentKey)) {
    return err({ kind: "invalid_key", message: "Commitment key must contain 32 to 64 bytes" });
  }
  if (
    typeof purpose !== "string" ||
    !COMMITMENT_PURPOSES.has(purpose) ||
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_COMMITMENT_INPUT_BYTES
  ) {
    return err({
      kind: "invalid_commitment_input",
      message: "Commitment purpose and bounded binary input are required",
    });
  }
  return ok(
    createHmac("sha256", commitmentKey)
      .update(`comis-production-activity-commitment-v1\0${purpose}\0`)
      .update(value)
      .digest("hex"),
  );
}

function validateArtifact(raw: unknown): raw is ProductionActivityArtifact {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ARTIFACT_KEYS) ||
    !isDigest(raw.contentCommitmentSha256)
  ) {
    return false;
  }
  if (raw.vaultBlob === null) return true;
  return (
    isRecord(raw.vaultBlob) &&
    hasExactKeys(raw.vaultBlob, BLOB_KEYS) &&
    isDigest(raw.vaultBlob.digestSha256) &&
    isNonNegativeInteger(raw.vaultBlob.plaintextBytes) &&
    raw.vaultBlob.plaintextBytes <= MAX_PRODUCTION_ACTIVITY_BLOB_BYTES &&
    raw.vaultBlob.ciphertextBytes === raw.vaultBlob.plaintextBytes
  );
}

function validateWindow(raw: unknown): raw is ProductionActivityLedgerDraft["captureWindow"] {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, WINDOW_KEYS) &&
    isNonNegativeInteger(raw.startedWallTimeMs) &&
    isNonNegativeInteger(raw.endedWallTimeMs) &&
    raw.endedWallTimeMs > raw.startedWallTimeMs &&
    isNullableDigest(raw.initialCheckpointManifestDigestSha256) &&
    isNullableDigest(raw.finalObservationDigestSha256)
  );
}

function validateIdentity(raw: unknown): raw is ProductionActivityLedgerDraft["identity"] {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, IDENTITY_KEYS) &&
    isDigest(raw.sourceMachineCommitmentSha256) &&
    isDigest(raw.buildCommitmentSha256) &&
    isDigest(raw.configCommitmentSha256) &&
    isDigest(raw.runtimeCommitmentSha256) &&
    isDigest(raw.observerCommitmentSha256)
  );
}

function validateDeterminism(raw: unknown): raw is ProductionActivityLedgerDraft["determinism"] {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, DETERMINISM_KEYS) &&
    validateArtifact(raw.clockSequence) &&
    validateArtifact(raw.randomSequence) &&
    validateArtifact(raw.identifierSequence)
  );
}

function validateEpoch(raw: unknown): raw is ProductionActivitySourceEpoch {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, EPOCH_KEYS) ||
    !isPositiveInteger(raw.ordinal) ||
    !isOpaqueId(raw.epochId) ||
    !isNonNegativeInteger(raw.startWatermark) ||
    !isNonNegativeInteger(raw.endWatermark) ||
    raw.endWatermark < raw.startWatermark ||
    !isNonNegativeInteger(raw.observedCount) ||
    !isNonNegativeInteger(raw.lossCount) ||
    raw.observedCount + raw.lossCount !== raw.endWatermark - raw.startWatermark ||
    !isNullablePositiveInteger(raw.firstLedgerSequence) ||
    !isNullablePositiveInteger(raw.lastLedgerSequence) ||
    !isNullableMonotonic(raw.monotonicStartNs) ||
    !isNullableMonotonic(raw.monotonicEndNs)
  ) {
    return false;
  }
  const empty =
    raw.observedCount === 0 &&
    raw.firstLedgerSequence === null &&
    raw.lastLedgerSequence === null &&
    raw.monotonicStartNs === null &&
    raw.monotonicEndNs === null;
  const populated =
    raw.observedCount > 0 &&
    isPositiveInteger(raw.firstLedgerSequence) &&
    isPositiveInteger(raw.lastLedgerSequence) &&
    raw.firstLedgerSequence <= raw.lastLedgerSequence &&
    isMonotonic(raw.monotonicStartNs) &&
    isMonotonic(raw.monotonicEndNs) &&
    BigInt(raw.monotonicStartNs) <= BigInt(raw.monotonicEndNs);
  return empty || populated;
}

function validateAuthorityShape(raw: unknown): raw is ProductionActivitySourceAuthority {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, AUTHORITY_KEYS) ||
    typeof raw.kind !== "string" ||
    !SOURCE_KIND_VALUES.has(raw.kind) ||
    !isDigest(raw.sourceIdCommitmentSha256) ||
    (raw.status !== "complete" && raw.status !== "gap") ||
    (raw.gap !== null && (typeof raw.gap !== "string" || !SOURCE_GAP_VALUES.has(raw.gap))) ||
    (raw.status === "gap") !== (raw.gap !== null) ||
    !isDigest(raw.attestationCommitmentSha256) ||
    !isDenseBoundedArray(raw.epochs, MAX_SOURCE_EPOCHS) ||
    raw.epochs.some((epoch) => !validateEpoch(epoch))
  ) {
    return false;
  }
  const epochs = raw.epochs as unknown as readonly ProductionActivitySourceEpoch[];
  return epochs.every((epoch, index) => epoch.ordinal === index + 1) &&
    (raw.status === "gap" || epochs.every((epoch) => epoch.lossCount === 0));
}

function validateAuthoritiesShape(raw: unknown): raw is readonly ProductionActivitySourceAuthority[] {
  if (
    !isDenseBoundedArray(raw, MAX_SOURCE_AUTHORITIES) ||
    raw.some((authority) => !validateAuthorityShape(authority))
  ) {
    return false;
  }
  const authorities = raw as unknown as readonly ProductionActivitySourceAuthority[];
  const keys = new Set<string>();
  const epochIds = new Set<string>();
  for (const authority of authorities) {
    const key = `${authority.kind}\0${authority.sourceIdCommitmentSha256}`;
    if (keys.has(key)) return false;
    keys.add(key);
    for (const epoch of authority.epochs) {
      if (epochIds.has(epoch.epochId)) return false;
      epochIds.add(epoch.epochId);
    }
  }
  const ordered = authorities.every((authority, index) => {
    if (index === 0) return true;
    const prior = authorities[index - 1] as ProductionActivitySourceAuthority;
    const priorKind = TRANSCRIPT_EXACT_SOURCE_KINDS.indexOf(prior.kind);
    const currentKind = TRANSCRIPT_EXACT_SOURCE_KINDS.indexOf(authority.kind);
    return currentKind > priorKind ||
      (currentKind === priorKind && authority.sourceIdCommitmentSha256 > prior.sourceIdCommitmentSha256);
  });
  return ordered && TRANSCRIPT_EXACT_SOURCE_KINDS.every((kind) =>
    authorities.some((authority) => authority.kind === kind),
  );
}

function validateEntryShape(
  raw: unknown,
  full: boolean,
): raw is ProductionActivityLedgerEntry {
  const keys = full ? FULL_ENTRY_KEYS : ENTRY_KEYS;
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, keys) ||
    !isPositiveInteger(raw.sequence) ||
    !isOpaqueId(raw.entryId) ||
    !isDigest(raw.eventIdentityCommitmentSha256) ||
    typeof raw.kind !== "string" ||
    !EVENT_KIND_VALUES.has(raw.kind)
  ) {
    return false;
  }
  if (
    !isRecord(raw.source) ||
    !hasExactKeys(raw.source, ENTRY_SOURCE_KEYS) ||
    typeof raw.source.kind !== "string" ||
    !SOURCE_KIND_VALUES.has(raw.source.kind) ||
    !isDigest(raw.source.sourceIdCommitmentSha256) ||
    !isOpaqueId(raw.source.epochId) ||
    !isPositiveInteger(raw.source.sequence)
  ) {
    return false;
  }
  if (
    !isRecord(raw.timing) ||
    !hasExactKeys(raw.timing, TIMING_KEYS) ||
    !isNonNegativeInteger(raw.timing.wallTimeMs) ||
    !isMonotonic(raw.timing.monotonicTimeNs) ||
    !isOpaqueId(raw.timing.clockId)
  ) {
    return false;
  }
  if (
    !isRecord(raw.causality) ||
    !hasExactKeys(raw.causality, CAUSALITY_KEYS) ||
    !isDenseBoundedArray(raw.causality.parentEntryIds, MAX_CAUSAL_PARENTS) ||
    raw.causality.parentEntryIds.some((parent) => !isOpaqueId(parent)) ||
    new Set(raw.causality.parentEntryIds).size !== raw.causality.parentEntryIds.length ||
    !isNullableDigest(raw.causality.traceCommitmentSha256) ||
    !isNullableDigest(raw.causality.sessionCommitmentSha256) ||
    !isNullableDigest(raw.causality.runCommitmentSha256) ||
    !isNullableDigest(raw.causality.jobCommitmentSha256)
  ) {
    return false;
  }
  if (
    !isRecord(raw.actor) ||
    !hasExactKeys(raw.actor, ACTOR_KEYS) ||
    typeof raw.actor.kind !== "string" ||
    !ACTOR_KIND_VALUES.has(raw.actor.kind) ||
    !isNullableDigest(raw.actor.identityCommitmentSha256) ||
    typeof raw.actor.trust !== "string" ||
    !TRUST_VALUES.has(raw.actor.trust) ||
    typeof raw.actor.origin !== "string" ||
    !ORIGIN_VALUES.has(raw.actor.origin)
  ) {
    return false;
  }
  if (
    !validateArtifact(raw.payload) ||
    !isRecord(raw.replay) ||
    !hasExactKeys(raw.replay, REPLAY_KEYS) ||
    typeof raw.replay.policy !== "string" ||
    !REPLAY_POLICY_VALUES.has(raw.replay.policy) ||
    (raw.replay.cassetteId !== null && !isOpaqueId(raw.replay.cassetteId)) ||
    (raw.replay.cassetteRole !== null &&
      raw.replay.cassetteRole !== "request" &&
      raw.replay.cassetteRole !== "terminal") ||
    (raw.replay.cassetteId === null) !== (raw.replay.cassetteRole === null)
  ) {
    return false;
  }
  return !full || (isDigest(raw.previousEntryHashSha256) && isDigest(raw.entryHashSha256));
}

function validateCassetteShape(raw: unknown): raw is ProductionActivityCassette {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, CASSETTE_KEYS) &&
    isOpaqueId(raw.cassetteId) &&
    typeof raw.kind === "string" &&
    CASSETTE_KIND_VALUES.has(raw.kind) &&
    isPositiveInteger(raw.ordinal) &&
    isOpaqueId(raw.requestEntryId) &&
    isOpaqueId(raw.terminalEntryId) &&
    raw.requestEntryId !== raw.terminalEntryId &&
    isDigest(raw.requestPayloadCommitmentSha256) &&
    isDigest(raw.responsePayloadCommitmentSha256) &&
    isNullableDigest(raw.requestBlobDigestSha256) &&
    isNullableDigest(raw.responseBlobDigestSha256) &&
    typeof raw.outcome === "string" &&
    OUTCOME_VALUES.has(raw.outcome) &&
    isNonNegativeInteger(raw.latencyMs)
  );
}

function requiresTraceAndSession(kind: TranscriptEventKind): boolean {
  return /^(?:channel\.|ingress\.|heartbeat\.|proactive\.|system\.dispatch\.|internal\.dispatch\.|subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.|lcd\.|outbound\.)/u.test(kind);
}

function requiresRun(kind: TranscriptEventKind): boolean {
  return /^(?:subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.turn\.|lcd\.|outbound\.)/u.test(kind);
}

function isInjectableRoot(kind: TranscriptEventKind): boolean {
  return (
    /^channel\.native\..+_received$/u.test(kind) ||
    kind === "cron.fire.started" ||
    kind === "heartbeat.requested" ||
    kind === "proactive.triggered" ||
    kind === "system.dispatch.enqueued" ||
    kind === "operator.action.requested"
  );
}

function hasCompatibleRequestAncestor(
  child: ProductionActivityLedgerEntryDraft,
  expectedRequestKinds: readonly TranscriptEventKind[],
  entries: ReadonlyMap<string, ProductionActivityLedgerEntryDraft>,
): boolean {
  const pending = [...child.causality.parentEntryIds];
  const visited = new Set<string>();
  let cursor = 0;
  while (cursor < pending.length && visited.size <= MAX_CAUSAL_ANCESTORS) {
    const candidateId = pending.at(cursor) as string;
    cursor += 1;
    if (visited.has(candidateId)) continue;
    visited.add(candidateId);
    const candidate = entries.get(candidateId);
    if (candidate === undefined) continue;
    if (expectedRequestKinds.includes(candidate.kind)) return true;
    pending.push(...candidate.causality.parentEntryIds);
  }
  return false;
}

function validateActorAndContext(entry: ProductionActivityLedgerEntryDraft): boolean {
  const { kind, actor, causality } = entry;
  if (
    requiresTraceAndSession(kind) &&
    (causality.traceCommitmentSha256 === null || causality.sessionCommitmentSha256 === null)
  ) {
    return false;
  }
  if (requiresRun(kind) && causality.runCommitmentSha256 === null) return false;
  if (kind.startsWith("cron.") && causality.jobCommitmentSha256 === null) return false;
  if (/^channel\.(?:native|normalized)\./u.test(kind)) {
    if ((actor.kind !== "user" && actor.kind !== "provider") || actor.origin !== "channel") return false;
  }
  if (kind.startsWith("channel.outbound.")) {
    if ((actor.kind !== "service" && actor.kind !== "provider") || actor.origin !== "channel_outbound") {
      return false;
    }
  }
  const originByPrefix: readonly [string, TranscriptOrigin][] = [
    ["ingress.", "orchestrator"],
    ["cron.", "scheduler"],
    ["heartbeat.", "heartbeat"],
    ["proactive.", "proactive"],
    ["system.dispatch.", "system"],
    ["internal.dispatch.", "internal"],
    ["subagent.", "subagent"],
    ["model.", "model"],
    ["tool.call.", "tool"],
    ["mcp.call.", "mcp"],
    ["web.fetch.", "web"],
    ["media.", "media"],
    ["cache.", "cache"],
    ["memory.", "memory"],
    ["learning.", "learning"],
    ["context.", "context"],
    ["session.", "session"],
    ["lcd.", "lcd"],
    ["outbound.", "delivery"],
    ["state.", "state"],
    ["config.", "config"],
    ["trajectory.", "trajectory"],
    ["audit.", "audit"],
    ["diagnostics.", "diagnostics"],
    ["background.", "background"],
    ["runtime.artifact.", "runtime_artifact"],
    ["operator.", "operator"],
    ["rpc.", "rpc"],
    ["admin.", "admin"],
    ["determinism.", "determinism"],
    ["dependency.", "dependency"],
    ["channel.outbound.", "channel_outbound"],
    ["filesystem.", "filesystem"],
    ["environment.", "environment"],
    ["external.io.", "external_io"],
    ["daemon.", "daemon"],
  ];
  const expectedOrigin = originByPrefix.find(([prefix]) => kind.startsWith(prefix))?.[1];
  if (expectedOrigin !== undefined && actor.origin !== expectedOrigin) return false;
  if (actor.kind === "user" && actor.origin !== "channel") return false;
  if (
    actor.kind === "user" &&
    actor.trust !== "guest" &&
    actor.trust !== "user" &&
    actor.trust !== "admin"
  ) {
    return false;
  }
  if (kind.startsWith("cron.") && actor.kind !== "scheduler" && actor.kind !== "system") return false;
  if (
    (kind.startsWith("heartbeat.") || kind.startsWith("proactive.")) &&
    actor.kind !== "scheduler" &&
    actor.kind !== "system"
  ) {
    return false;
  }
  if (kind.startsWith("model.response.") && actor.kind !== "provider") return false;
  if (
    actor.kind === "provider" &&
    actor.origin !== "channel" &&
    actor.origin !== "model" &&
    actor.origin !== "mcp" &&
    actor.origin !== "web" &&
    actor.origin !== "media" &&
    actor.origin !== "dependency" &&
    actor.origin !== "channel_outbound" &&
    actor.origin !== "filesystem" &&
    actor.origin !== "environment" &&
    actor.origin !== "external_io"
  ) {
    return false;
  }
  if (kind.startsWith("daemon.") && actor.origin !== "daemon") return false;
  if ((actor.kind === "system" || actor.kind === "scheduler") && actor.trust !== "system") return false;
  if (actor.kind === "provider" && actor.trust !== "external") return false;
  return true;
}

function validateEntrySemantics(
  draft: ProductionActivityLedgerDraft,
): Result<void, ProductionActivityLedgerError> {
  const entryIds = new Set<string>();
  const eventCommitments = new Set<string>();
  const entriesById = new Map<string, ProductionActivityLedgerEntryDraft>();
  const clockTimes = new Map<string, bigint>();
  for (let index = 0; index < draft.entries.length; index += 1) {
    const entry = draft.entries.at(index) as ProductionActivityLedgerEntryDraft;
    if (
      entry.sequence !== index + 1 ||
      entryIds.has(entry.entryId) ||
      eventCommitments.has(entry.eventIdentityCommitmentSha256)
    ) {
      return invalid("order", "Ledger sequence and recorder identities must be unique and contiguous");
    }
    if (
      entry.timing.wallTimeMs < draft.captureWindow.startedWallTimeMs ||
      entry.timing.wallTimeMs > draft.captureWindow.endedWallTimeMs
    ) {
      return invalid("order", "Ledger wall time is outside the capture window");
    }
    const monotonic = BigInt(entry.timing.monotonicTimeNs);
    const priorClock = clockTimes.get(entry.timing.clockId);
    if (priorClock !== undefined && monotonic < priorClock) {
      return invalid("order", "Monotonic time regresses within a clock epoch");
    }
    const compatibleSources = PRODUCTION_ACTIVITY_EVENT_SOURCES[entry.kind];
    if (!compatibleSources.includes(entry.source.kind)) {
      return invalid("entries", "Event kind is incompatible with its authoritative source");
    }
    if (entry.causality.parentEntryIds.some((parent) => !entryIds.has(parent))) {
      return invalid("causality", "Every causal parent must precede its child");
    }
    const expectedRequests = REQUEST_KINDS_BY_TERMINAL.get(entry.kind) ?? [];
    if (
      expectedRequests.length > 0 &&
      !hasCompatibleRequestAncestor(entry, expectedRequests, entriesById)
    ) {
      return invalid("causality", "Lifecycle terminal event has no compatible causal request");
    }
    if (!validateActorAndContext(entry)) {
      return invalid("entries", "Actor trust, origin, or request context is inconsistent with the event");
    }
    const injectable = isInjectableRoot(entry.kind);
    if (injectable && (entry.causality.parentEntryIds.length !== 0 || entry.replay.policy !== "inject")) {
      return invalid("entries", "Replay-engine injectable roots must be causal roots with inject policy");
    }
    if (!injectable && entry.replay.policy === "inject") {
      return invalid("entries", "Only replay-engine injectable roots may use inject policy");
    }
    if (entry.replay.cassetteRole === "request") {
      const lifecycle = LIFECYCLES.get(entry.kind);
      if (lifecycle === undefined || (entry.replay.policy !== "inject" && entry.replay.policy !== "stub")) {
        return invalid("entries", "Cassette request event does not begin a supported replay lifecycle");
      }
    }
    if (
      entry.replay.cassetteRole === "terminal" &&
      entry.replay.policy !== "assert" &&
      entry.replay.policy !== "observe"
    ) {
      return invalid("entries", "Cassette terminal event must be asserted or observed");
    }
    entryIds.add(entry.entryId);
    eventCommitments.add(entry.eventIdentityCommitmentSha256);
    entriesById.set(entry.entryId, entry);
    clockTimes.set(entry.timing.clockId, monotonic);
  }
  return ok(undefined);
}

function authorityKey(kind: TranscriptSourceKind, commitment: string): string {
  return `${kind}\0${commitment}`;
}

function validateAuthoritySemantics(
  draft: ProductionActivityLedgerDraft,
): Result<void, ProductionActivityLedgerError> {
  const authorityMap = new Map(
    draft.sourceAuthorities.map((authority) => [
      authorityKey(authority.kind, authority.sourceIdCommitmentSha256),
      authority,
    ] as const),
  );
  const declaredEpochs = new Set(
    draft.sourceAuthorities.flatMap((authority) => {
      const sourceKey = authorityKey(authority.kind, authority.sourceIdCommitmentSha256);
      return authority.epochs.map((epoch) => `${sourceKey}\0${epoch.epochId}`);
    }),
  );
  const entriesByEpoch = new Map<string, ProductionActivityLedgerEntryDraft[]>();
  for (const entry of draft.entries) {
    const sourceKey = authorityKey(entry.source.kind, entry.source.sourceIdCommitmentSha256);
    const authority = authorityMap.get(sourceKey);
    const epochKey = `${sourceKey}\0${entry.source.epochId}`;
    if (authority === undefined || !declaredEpochs.has(epochKey)) {
      return invalid("sourceAuthorities", "Entry source epoch has no declared authority");
    }
    const matching = entriesByEpoch.get(epochKey) ?? [];
    matching.push(entry);
    entriesByEpoch.set(epochKey, matching);
  }
  for (const authority of draft.sourceAuthorities) {
    for (const epoch of authority.epochs) {
      const matching = entriesByEpoch.get(
        `${authorityKey(authority.kind, authority.sourceIdCommitmentSha256)}\0${epoch.epochId}`,
      ) ?? [];
      const sourceSequences = matching.map((entry) => entry.source.sequence);
      const uniqueSequences = new Set(sourceSequences);
      const monotonic = matching.map((entry) => BigInt(entry.timing.monotonicTimeNs));
      const ordered = sourceSequences.every((sequence, index) =>
        index === 0 || sequence > (sourceSequences[index - 1] as number),
      );
      const monotonicOrdered = monotonic.every((value, index) =>
        index === 0 || value >= (monotonic[index - 1] as bigint),
      );
      if (
        matching.length !== epoch.observedCount ||
        uniqueSequences.size !== sourceSequences.length ||
        !ordered ||
        !monotonicOrdered ||
        sourceSequences.some(
          (sequence) => sequence <= epoch.startWatermark || sequence > epoch.endWatermark,
        ) ||
        epoch.firstLedgerSequence !== (matching.at(0)?.sequence ?? null) ||
        epoch.lastLedgerSequence !== (matching.at(-1)?.sequence ?? null) ||
        epoch.monotonicStartNs !== (matching.at(0)?.timing.monotonicTimeNs ?? null) ||
        epoch.monotonicEndNs !== (matching.at(-1)?.timing.monotonicTimeNs ?? null)
      ) {
        return invalid("sourceAuthorities", "Source epoch watermarks, loss, and observed entries do not reconcile");
      }
    }
  }
  return ok(undefined);
}

function expectedOutcome(
  terminalKind: TranscriptEventKind,
  outcome: ProductionActivityCassette["outcome"],
): boolean {
  if (/\.(?:completed|delivered|admitted|dispatched)$/u.test(terminalKind)) {
    return outcome === "success";
  }
  if (/\.(?:skipped|dropped|cancelled|rejected)$/u.test(terminalKind)) {
    return outcome === "cancelled";
  }
  if (terminalKind.endsWith(".failed")) return outcome === "error" || outcome === "timeout";
  return false;
}

function isAncestor(
  ancestorId: string,
  child: ProductionActivityLedgerEntryDraft,
  entries: ReadonlyMap<string, ProductionActivityLedgerEntryDraft>,
): boolean {
  const pending = [...child.causality.parentEntryIds];
  const visited = new Set<string>();
  let cursor = 0;
  while (cursor < pending.length && visited.size <= MAX_CAUSAL_ANCESTORS) {
    const candidate = pending.at(cursor) as string;
    cursor += 1;
    if (candidate === ancestorId) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const parent = entries.get(candidate);
    if (parent !== undefined) pending.push(...parent.causality.parentEntryIds);
  }
  return false;
}

function sameContext(
  request: ProductionActivityLedgerEntryDraft,
  terminal: ProductionActivityLedgerEntryDraft,
): boolean {
  return (
    request.causality.traceCommitmentSha256 === terminal.causality.traceCommitmentSha256 &&
    request.causality.sessionCommitmentSha256 === terminal.causality.sessionCommitmentSha256 &&
    request.causality.runCommitmentSha256 === terminal.causality.runCommitmentSha256 &&
    request.causality.jobCommitmentSha256 === terminal.causality.jobCommitmentSha256
  );
}

function validateCassetteSemantics(
  draft: ProductionActivityLedgerDraft,
): Result<void, ProductionActivityLedgerError> {
  const entries = new Map(draft.entries.map((entry) => [entry.entryId, entry] as const));
  const cassetteIds = new Set<string>();
  const referencedEntries = new Set<string>();
  const kindCounts = new Map<ReplayCassetteKind, number>();
  for (const cassette of draft.cassettes) {
    if (cassetteIds.has(cassette.cassetteId)) {
      return invalid("cassettes", "Cassette identity is duplicated");
    }
    const priorKindCount = kindCounts.get(cassette.kind) ?? 0;
    if (cassette.ordinal !== priorKindCount + 1) {
      return invalid("cassettes", "Cassette ordinals must be contiguous within each bundle kind");
    }
    const request = entries.get(cassette.requestEntryId);
    const terminal = entries.get(cassette.terminalEntryId);
    const lifecycle = request === undefined ? undefined : LIFECYCLES.get(request.kind);
    if (
      request === undefined ||
      terminal === undefined ||
      lifecycle === undefined ||
      lifecycle.kind !== cassette.kind ||
      !lifecycle.terminals.includes(terminal.kind) ||
      request.sequence >= terminal.sequence ||
      request.replay.cassetteId !== cassette.cassetteId ||
      request.replay.cassetteRole !== "request" ||
      terminal.replay.cassetteId !== cassette.cassetteId ||
      terminal.replay.cassetteRole !== "terminal" ||
      referencedEntries.has(request.entryId) ||
      referencedEntries.has(terminal.entryId) ||
      !isAncestor(request.entryId, terminal, entries) ||
      !sameContext(request, terminal) ||
      cassette.requestPayloadCommitmentSha256 !== request.payload.contentCommitmentSha256 ||
      cassette.responsePayloadCommitmentSha256 !== terminal.payload.contentCommitmentSha256 ||
      cassette.requestBlobDigestSha256 !== (request.payload.vaultBlob?.digestSha256 ?? null) ||
      cassette.responseBlobDigestSha256 !== (terminal.payload.vaultBlob?.digestSha256 ?? null) ||
      cassette.latencyMs !== terminal.timing.wallTimeMs - request.timing.wallTimeMs ||
      !expectedOutcome(terminal.kind, cassette.outcome)
    ) {
      return invalid("cassettes", "Cassette does not reconcile with its request and terminal lifecycle");
    }
    cassetteIds.add(cassette.cassetteId);
    referencedEntries.add(request.entryId);
    referencedEntries.add(terminal.entryId);
    kindCounts.set(cassette.kind, priorKindCount + 1);
  }
  for (const entry of draft.entries) {
    if (entry.replay.cassetteId !== null && !referencedEntries.has(entry.entryId)) {
      return invalid("cassettes", "Cassette event reference is not bijective");
    }
  }
  return ok(undefined);
}

function validateRecorderIdentifierNamespaces(
  draft: ProductionActivityLedgerDraft,
): Result<void, ProductionActivityLedgerError> {
  const identifiers = new Set<string>();
  const add = (identifier: string): boolean => {
    if (identifiers.has(identifier)) return false;
    identifiers.add(identifier);
    return true;
  };
  if (!add(draft.captureId)) {
    return invalid("order", "Recorder identifier is reused across capture namespaces");
  }
  for (const authority of draft.sourceAuthorities) {
    for (const epoch of authority.epochs) {
      if (!add(epoch.epochId)) {
        return invalid("order", "Recorder identifier is reused across capture namespaces");
      }
    }
  }
  for (const entry of draft.entries) {
    if (!add(entry.entryId)) {
      return invalid("order", "Recorder identifier is reused across capture namespaces");
    }
  }
  for (const cassette of draft.cassettes) {
    if (!add(cassette.cassetteId)) {
      return invalid("order", "Recorder identifier is reused across capture namespaces");
    }
  }
  return ok(undefined);
}

function validateDraft(
  raw: unknown,
): Result<ProductionActivityLedgerDraft, ProductionActivityLedgerError> {
  if (!isRecord(raw) || !hasExactKeys(raw, DRAFT_KEYS) || !isOpaqueId(raw.captureId)) {
    return invalid("ledger", "Production activity ledger draft is invalid");
  }
  if (!validateWindow(raw.captureWindow)) return invalid("captureWindow", "Capture window is invalid");
  if (!validateIdentity(raw.identity)) return invalid("identity", "Keyed capture identity is invalid");
  if (!validateDeterminism(raw.determinism)) return invalid("determinism", "Deterministic capture references are invalid");
  if (!validateAuthoritiesShape(raw.sourceAuthorities)) {
    return invalid("sourceAuthorities", "Exact source authorities or epochs are invalid");
  }
  if (
    !isDenseBoundedArray(raw.entries, MAX_LEDGER_ENTRIES) ||
    raw.entries.some((entry) => !validateEntryShape(entry, false))
  ) {
    return invalid("entries", "Ledger entries are sparse, over-bounded, malformed, or contain inline content");
  }
  if (
    !isDenseBoundedArray(raw.cassettes, MAX_CASSETTES) ||
    raw.cassettes.some((cassette) => !validateCassetteShape(cassette))
  ) {
    return invalid("cassettes", "Replay cassette inventory is malformed or over-bounded");
  }
  const draft = raw as unknown as ProductionActivityLedgerDraft;
  const identifiers = validateRecorderIdentifierNamespaces(draft);
  if (identifiers.ok === false) return err(identifiers.error);
  const entries = validateEntrySemantics(draft);
  if (entries.ok === false) return err(entries.error);
  const authorities = validateAuthoritySemantics(draft);
  if (authorities.ok === false) return err(authorities.error);
  const cassettes = validateCassetteSemantics(draft);
  if (cassettes.ok === false) return err(cassettes.error);
  const canonical = tryCatch(() => canonicalJson(draft));
  if (
    canonical.ok === false ||
    Buffer.byteLength(canonical.value, "utf8") > MAX_PRODUCTION_ACTIVITY_LEDGER_BYTES
  ) {
    return invalid("ledger", "Production activity ledger draft exceeds its serialized byte bound");
  }
  return ok(draft);
}

function deriveCaptureAssertion(
  draft: ProductionActivityLedgerDraft,
): ProductionActivityCaptureAssertion {
  const blockers: ProductionActivityCaptureBlocker[] = [
    { kind: "authenticated_bundle_reconciliation_required" },
  ];
  if (draft.captureWindow.initialCheckpointManifestDigestSha256 === null) {
    blockers.push({ kind: "initial_checkpoint_missing" });
  }
  if (draft.captureWindow.finalObservationDigestSha256 === null) {
    blockers.push({ kind: "final_observation_missing" });
  }
  for (const [sequenceKind, artifact] of [
    ["clock", draft.determinism.clockSequence],
    ["random", draft.determinism.randomSequence],
    ["identifier", draft.determinism.identifierSequence],
  ] as const) {
    if (artifact.vaultBlob === null) {
      blockers.push({ kind: "deterministic_sequence_missing", sequenceKind });
    }
  }
  for (const authority of draft.sourceAuthorities) {
    if (authority.status !== "gap") continue;
    blockers.push({
      kind: "source_loss",
      sourceKind: authority.kind,
      sourceIdCommitmentSha256: authority.sourceIdCommitmentSha256,
      gap: authority.gap as ProductionActivitySourceGap,
      lossCount: authority.epochs.reduce((total, epoch) => total + epoch.lossCount, 0),
    });
  }
  const cassettesByRequest = new Map(
    draft.cassettes.map((cassette) => [cassette.requestEntryId, cassette] as const),
  );
  for (const entry of draft.entries) {
    if (isInjectableRoot(entry.kind) && entry.payload.vaultBlob === null) {
      blockers.push({ kind: "injectable_payload_missing", entryId: entry.entryId });
    }
    const lifecycle = LIFECYCLES.get(entry.kind);
    if (lifecycle !== undefined && !cassettesByRequest.has(entry.entryId)) {
      blockers.push({
        kind: "cassette_missing",
        requestEntryId: entry.entryId,
        cassetteKind: lifecycle.kind,
      });
    }
    const terminalLifecycle = [...LIFECYCLES.values()].find((candidate) =>
      candidate.terminals.includes(entry.kind),
    );
    if (terminalLifecycle !== undefined && entry.replay.cassetteId === null) {
      blockers.push({
        kind: "cassette_terminal_missing",
        terminalEntryId: entry.entryId,
        cassetteKind: terminalLifecycle.kind,
      });
    }
  }
  for (const cassette of draft.cassettes) {
    if (cassette.requestBlobDigestSha256 === null) {
      blockers.push({ kind: "cassette_blob_missing", cassetteId: cassette.cassetteId, endpoint: "request" });
    }
    if (cassette.responseBlobDigestSha256 === null) {
      blockers.push({ kind: "cassette_blob_missing", cassetteId: cassette.cassetteId, endpoint: "response" });
    }
  }
  return { classification: "bounded_capture", replayReady: false, blockers };
}

function validateBlocker(raw: unknown): raw is ProductionActivityCaptureBlocker {
  if (!isRecord(raw) || typeof raw.kind !== "string") return false;
  switch (raw.kind) {
    case "authenticated_bundle_reconciliation_required":
    case "initial_checkpoint_missing":
    case "final_observation_missing":
      return hasExactKeys(raw, ["kind"]);
    case "deterministic_sequence_missing":
      return (
        hasExactKeys(raw, ["kind", "sequenceKind"]) &&
        (raw.sequenceKind === "clock" || raw.sequenceKind === "random" || raw.sequenceKind === "identifier")
      );
    case "source_loss":
      return (
        hasExactKeys(raw, ["kind", "sourceKind", "sourceIdCommitmentSha256", "gap", "lossCount"]) &&
        typeof raw.sourceKind === "string" &&
        SOURCE_KIND_VALUES.has(raw.sourceKind) &&
        isDigest(raw.sourceIdCommitmentSha256) &&
        typeof raw.gap === "string" &&
        SOURCE_GAP_VALUES.has(raw.gap) &&
        isNonNegativeInteger(raw.lossCount)
      );
    case "injectable_payload_missing":
      return hasExactKeys(raw, ["kind", "entryId"]) && isOpaqueId(raw.entryId);
    case "cassette_missing":
      return (
        hasExactKeys(raw, ["kind", "requestEntryId", "cassetteKind"]) &&
        isOpaqueId(raw.requestEntryId) &&
        typeof raw.cassetteKind === "string" &&
        CASSETTE_KIND_VALUES.has(raw.cassetteKind)
      );
    case "cassette_terminal_missing":
      return (
        hasExactKeys(raw, ["kind", "terminalEntryId", "cassetteKind"]) &&
        isOpaqueId(raw.terminalEntryId) &&
        typeof raw.cassetteKind === "string" &&
        CASSETTE_KIND_VALUES.has(raw.cassetteKind)
      );
    case "cassette_blob_missing":
      return (
        hasExactKeys(raw, ["kind", "cassetteId", "endpoint"]) &&
        isOpaqueId(raw.cassetteId) &&
        (raw.endpoint === "request" || raw.endpoint === "response")
      );
    default:
      return false;
  }
}

function validateCaptureAssertion(raw: unknown): raw is ProductionActivityCaptureAssertion {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, ASSERTION_KEYS) &&
    raw.classification === "bounded_capture" &&
    raw.replayReady === false &&
    isDenseBoundedArray(raw.blockers, MAX_SOURCE_AUTHORITIES + MAX_LEDGER_ENTRIES + MAX_CASSETTES * 2) &&
    raw.blockers.every(validateBlocker)
  );
}

function genesisHash(
  draft: ProductionActivityLedgerDraft,
  commitmentKeyIdSha256: string,
): string {
  return sha256(
    `comis-production-activity-ledger-genesis-v1\0${canonicalJson({
      schema: "comis-production-activity-ledger",
      schemaVersion: 1,
      captureId: draft.captureId,
      captureWindow: draft.captureWindow,
      identity: draft.identity,
      commitmentKeyIdSha256,
      determinism: draft.determinism,
      sourceAuthorities: draft.sourceAuthorities,
    })}`,
  );
}

function hashEntry(
  entry: Omit<ProductionActivityLedgerEntry, "entryHashSha256">,
): string {
  return sha256(`comis-production-activity-ledger-entry-v1\0${canonicalJson(entry)}`);
}

function unsignedLedger(
  ledger: ProductionActivityLedger,
): Omit<ProductionActivityLedger, "seal"> {
  const { seal: _seal, ...unsigned } = ledger;
  return unsigned;
}

function sealLedger(
  unsigned: Omit<ProductionActivityLedger, "seal">,
  sealKey: Uint8Array,
): ProductionActivityLedgerSeal {
  const ledgerDigestSha256 = sha256(canonicalJson(unsigned));
  return {
    algorithm: "hmac-sha256",
    canonicalization: "comis-json-c14n-v1",
    keyIdSha256: keyId("seal", sealKey),
    ledgerDigestSha256,
    authenticationTagSha256: createHmac("sha256", sealKey)
      .update(`comis-production-activity-ledger-seal-v1\0${ledgerDigestSha256}`)
      .digest("hex"),
  };
}

export function createProductionActivityLedger(
  rawDraft: unknown,
  rawKeys: unknown,
): Result<ProductionActivityLedger, ProductionActivityLedgerError> {
  const keys = validateKeys(rawKeys);
  if (keys.ok === false) return err(keys.error);
  const parsed = validateDraft(rawDraft);
  if (parsed.ok === false) return err(parsed.error);
  const draft = parsed.value;
  const commitmentKeyIdSha256 = keyId("commitment", keys.value.commitmentKey);
  const genesisHashSha256 = genesisHash(draft, commitmentKeyIdSha256);
  let previousEntryHashSha256 = genesisHashSha256;
  const entries = draft.entries.map((entry) => {
    const chained = { ...entry, previousEntryHashSha256 };
    const completed: ProductionActivityLedgerEntry = {
      ...chained,
      entryHashSha256: hashEntry(chained),
    };
    previousEntryHashSha256 = completed.entryHashSha256;
    return completed;
  });
  const unsigned: Omit<ProductionActivityLedger, "seal"> = {
    schema: "comis-production-activity-ledger",
    schemaVersion: 1,
    ...draft,
    commitmentKeyIdSha256,
    genesisHashSha256,
    entries,
    captureAssertion: deriveCaptureAssertion(draft),
  };
  const ledger: ProductionActivityLedger = {
    ...unsigned,
    seal: sealLedger(unsigned, keys.value.sealKey),
  };
  const serializedBytes = Buffer.byteLength(canonicalJson(ledger), "utf8");
  return serializedBytes <= MAX_PRODUCTION_ACTIVITY_LEDGER_BYTES
    ? ok(ledger)
    : invalid("ledger", "Authenticated activity ledger exceeds its serialized byte bound");
}

function draftFromLedger(
  raw: Record<string, unknown>,
): Result<ProductionActivityLedgerDraft, ProductionActivityLedgerError> {
  if (
    !isDenseBoundedArray(raw.entries, MAX_LEDGER_ENTRIES) ||
    raw.entries.some((entry) => !validateEntryShape(entry, true))
  ) {
    return invalid("entries", "Authenticated ledger entries are invalid");
  }
  const entries = (raw.entries as unknown as readonly ProductionActivityLedgerEntry[]).map(
    (entry) => {
      const {
        previousEntryHashSha256: _previous,
        entryHashSha256: _entryHash,
        ...draft
      } = entry;
      return draft;
    },
  );
  return validateDraft({
    captureId: raw.captureId,
    captureWindow: raw.captureWindow,
    identity: raw.identity,
    determinism: raw.determinism,
    sourceAuthorities: raw.sourceAuthorities,
    entries,
    cassettes: raw.cassettes,
  });
}

function validateSeal(raw: unknown): raw is ProductionActivityLedgerSeal {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, SEAL_KEYS) &&
    raw.algorithm === "hmac-sha256" &&
    raw.canonicalization === "comis-json-c14n-v1" &&
    isDigest(raw.keyIdSha256) &&
    isDigest(raw.ledgerDigestSha256) &&
    isDigest(raw.authenticationTagSha256)
  );
}

export function verifyProductionActivityLedger(
  raw: unknown,
  rawKeys: unknown,
): Result<ProductionActivityLedger, ProductionActivityLedgerError> {
  const keys = validateKeys(rawKeys);
  if (keys.ok === false) return err(keys.error);
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, LEDGER_KEYS) ||
    raw.schema !== "comis-production-activity-ledger" ||
    raw.schemaVersion !== 1 ||
    !isDigest(raw.commitmentKeyIdSha256) ||
    !isDigest(raw.genesisHashSha256)
  ) {
    return invalid("ledger", "Authenticated activity ledger root is invalid");
  }
  const expectedCommitmentKeyId = keyId("commitment", keys.value.commitmentKey);
  if (!equalHex(raw.commitmentKeyIdSha256, expectedCommitmentKeyId)) {
    return err({
      kind: "invalid_authentication",
      message: "Activity commitment key identity does not match",
    });
  }
  const draft = draftFromLedger(raw);
  if (draft.ok === false) return err(draft.error);
  if (!validateCaptureAssertion(raw.captureAssertion)) {
    return invalid("captureAssertion", "Bounded capture assertion shape is invalid");
  }
  const derivedAssertion = deriveCaptureAssertion(draft.value);
  if (canonicalJson(raw.captureAssertion) !== canonicalJson(derivedAssertion)) {
    return invalid("captureAssertion", "Capture assertion exceeds or disagrees with captured evidence");
  }
  if (!validateSeal(raw.seal)) return invalid("seal", "Activity ledger seal shape is invalid");
  const ledger = raw as unknown as ProductionActivityLedger;
  let previous = genesisHash(draft.value, expectedCommitmentKeyId);
  if (!equalHex(ledger.genesisHashSha256, previous)) {
    return err({
      kind: "broken_hash_chain",
      sequence: 0,
      message: "Ledger genesis does not bind the capture authority",
    });
  }
  for (const entry of ledger.entries) {
    const { entryHashSha256, ...hashed } = entry;
    if (
      !equalHex(entry.previousEntryHashSha256, previous) ||
      !equalHex(entryHashSha256, hashEntry(hashed))
    ) {
      return err({
        kind: "broken_hash_chain",
        sequence: entry.sequence,
        message: "Ledger entry hash chain is discontinuous or altered",
      });
    }
    previous = entryHashSha256;
  }
  const expectedSeal = sealLedger(unsignedLedger(ledger), keys.value.sealKey);
  if (
    !equalHex(ledger.seal.keyIdSha256, expectedSeal.keyIdSha256) ||
    !equalHex(ledger.seal.ledgerDigestSha256, expectedSeal.ledgerDigestSha256) ||
    !equalHex(ledger.seal.authenticationTagSha256, expectedSeal.authenticationTagSha256)
  ) {
    return err({ kind: "invalid_authentication", message: "Activity ledger authentication failed" });
  }
  return ok(ledger);
}

export function serializeProductionActivityLedger(
  ledger: ProductionActivityLedger,
): Result<string, ProductionActivityLedgerError> {
  const encoded = tryCatch(() => canonicalJson(ledger));
  if (encoded.ok === false) {
    return err({ kind: "serialization_failed", message: "Activity ledger cannot be serialized" });
  }
  const envelope = `${PRODUCTION_ACTIVITY_LEDGER_BEGIN}\n${encoded.value}\n${PRODUCTION_ACTIVITY_LEDGER_END}\n`;
  return Buffer.byteLength(envelope, "utf8") <= MAX_PRODUCTION_ACTIVITY_LEDGER_BYTES
    ? ok(envelope)
    : err({ kind: "serialization_failed", message: "Activity ledger exceeds its envelope byte bound" });
}

export function parseProductionActivityLedger(
  raw: string,
  keys: unknown,
): Result<ProductionActivityLedger, ProductionActivityLedgerError> {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_PRODUCTION_ACTIVITY_LEDGER_BYTES ||
    raw.includes("\r") ||
    raw.includes("\0")
  ) {
    return err({ kind: "invalid_envelope", message: "Activity ledger envelope is invalid" });
  }
  const lines = raw.split("\n");
  if (
    lines.length !== 4 ||
    lines[0] !== PRODUCTION_ACTIVITY_LEDGER_BEGIN ||
    lines[2] !== PRODUCTION_ACTIVITY_LEDGER_END ||
    lines[3] !== "" ||
    lines[1] === ""
  ) {
    return err({ kind: "invalid_envelope", message: "Activity ledger envelope is not exact" });
  }
  const decoded = tryCatch(() => JSON.parse(lines[1] as string) as unknown);
  if (decoded.ok === false) {
    return err({ kind: "invalid_envelope", message: "Activity ledger payload is not valid JSON" });
  }
  const verified = verifyProductionActivityLedger(decoded.value, keys);
  if (verified.ok === false) return err(verified.error);
  if (lines[1] !== canonicalJson(verified.value)) {
    return err({ kind: "invalid_envelope", message: "Activity ledger payload is not canonical" });
  }
  return verified;
}
