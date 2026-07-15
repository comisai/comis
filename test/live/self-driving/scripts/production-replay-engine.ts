// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

import {
  CASSETTE_KINDS,
  formatProductionReplayBundleManifest,
  type DeterministicSequenceKind,
  type ProductionReplayBundleManifest,
  type ReplayBundleBlobKind,
  type ReplayCassette,
  type ReplayCassetteKind,
} from "./production-bundle.js";
import {
  diffProductionReplay,
  type ProductionReplayDivergenceKind,
  type ReplayObservedRecord,
} from "./production-diff.js";
import {
  parseProductionCaptureEpisode,
  type ProductionCaptureEpisode,
} from "./production-episode.js";
import {
  parseCanonicalProductionTranscript,
  type CanonicalProductionEvent,
  type CanonicalProductionTranscript,
  type TranscriptEventKind,
  type TranscriptFidelity,
  type TranscriptSourceKind,
} from "./production-transcript.js";

type MaybePromise<T> = T | Promise<T>;

export interface ProductionReplayPortCallContext {
  /** The engine aborts this signal when the operation reaches its deadline. */
  readonly signal: AbortSignal;
  /** Absolute engine-wall-clock deadline for cooperative adapter cancellation. */
  readonly deadlineAtMs: number;
}

export interface ProductionReplayPortFailure {
  readonly kind: "port_failure";
  readonly failureDigestSha256: string;
}

export interface ProductionReplayArtifactRequest {
  readonly kind: ReplayBundleBlobKind;
  readonly digestSha256: string;
}

export interface ProductionReplayVerifiedBundle {
  readonly authentication: "verified";
  readonly authorityKeyIdSha256: string;
  readonly manifest: ProductionReplayBundleManifest;
}

export interface ProductionReplayBundleAuthorityPort {
  verify(
    sealedBundleEnvelope: string,
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<ProductionReplayVerifiedBundle, ProductionReplayPortFailure>>;
}

export interface ProductionReplayResolvedArtifact {
  readonly authentication: "verified";
  readonly kind: ReplayBundleBlobKind;
  readonly digestSha256: string;
  readonly bytes: number;
  readonly plaintext: Uint8Array;
}

export interface ProductionReplayArtifactResolverPort {
  resolve(
    request: ProductionReplayArtifactRequest,
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<ProductionReplayResolvedArtifact, ProductionReplayPortFailure>>;
}

export interface ProductionReplayCheckpointAttestation {
  readonly authentication: "verified";
  readonly kind: "prospective_pre_window" | "historical_snapshot";
  readonly manifestDigestSha256: string;
  readonly runtimeDigestSha256: string;
  readonly stateDigestSha256: string;
  readonly completedAtMs: number;
}

export interface ProductionReplayCheckpointPort {
  attest(
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<ProductionReplayCheckpointAttestation, ProductionReplayPortFailure>>;
}

export interface ProductionReplayDeterminismFailure {
  readonly kind: "determinism_unavailable";
  readonly component: DeterministicSequenceKind | "cassette";
  readonly evidenceDigestSha256: string;
}

export interface ProductionReplayCassetteResult {
  readonly outcome: ReplayCassette["outcome"];
  readonly latencyMs: number;
  readonly responsePayloadDigestSha256: string;
  readonly responsePayload: Uint8Array;
}

export interface ProductionReplayDeterminismPort {
  nextClock(): Result<number, ProductionReplayDeterminismFailure>;
  nextRandom(byteLength: number): Result<Uint8Array, ProductionReplayDeterminismFailure>;
  nextIdentifier(): Result<string, ProductionReplayDeterminismFailure>;
  consumeCassette(
    kind: ReplayCassetteKind,
    requestPayload: Uint8Array,
  ): Result<ProductionReplayCassetteResult, ProductionReplayDeterminismFailure>;
}

export interface ProductionReplayTrigger {
  readonly kind: TranscriptEventKind;
  readonly sourceKind: TranscriptSourceKind;
  readonly sourceId: string;
  readonly wallTimeMs: number;
  readonly idempotencyKeySha256: string;
  readonly payloadDigestSha256: string;
  readonly payload: Uint8Array;
}

export interface ProductionReplayDriverPort {
  start(
    input: {
      readonly determinism: ProductionReplayDeterminismPort;
      readonly checkpointDigestSha256: string;
      readonly windowStartMs: number;
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<void, ProductionReplayPortFailure>>;
  injectTrigger(
    trigger: ProductionReplayTrigger,
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<void, ProductionReplayPortFailure>>;
  finish(
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<void, ProductionReplayPortFailure>>;
  stop(
    input: ProductionReplayCleanupInput,
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<void, ProductionReplayPortFailure>>;
}

export interface ProductionReplayObserverResult {
  readonly outputs: readonly ReplayObservedRecord[];
  readonly state: readonly ReplayObservedRecord[];
}

export interface ProductionReplayObserverPort {
  start(
    input: {
      readonly windowStartMs: number;
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<void, ProductionReplayPortFailure>>;
  nextEvent(
    input: {
      readonly ordinal: number;
      readonly deadlineWallTimeMs: number;
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<
    Result<CanonicalProductionEvent | null, ProductionReplayPortFailure>
  >;
  finish(
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<ProductionReplayObserverResult, ProductionReplayPortFailure>>;
  stop(
    input: ProductionReplayCleanupInput,
    context: ProductionReplayPortCallContext,
  ): MaybePromise<Result<void, ProductionReplayPortFailure>>;
}

export interface ProductionReplayHardOracleCheck {
  readonly oracleIdSha256: string;
  readonly passed: boolean;
  readonly evidenceDigestSha256: string;
}

export interface ProductionReplayHardOracleResult {
  readonly oracleSetDigestSha256: string;
  readonly checks: readonly ProductionReplayHardOracleCheck[];
}

export interface ProductionReplayHardOraclePort {
  evaluate(
    input: {
      readonly actualTranscript: CanonicalProductionTranscript;
      readonly outputs: readonly ReplayObservedRecord[];
      readonly state: readonly ReplayObservedRecord[];
    },
    context: ProductionReplayPortCallContext,
  ): MaybePromise<
    Result<ProductionReplayHardOracleResult, ProductionReplayPortFailure>
  >;
}

/** Stop is invoked after every attempted start and must be idempotent. */
export interface ProductionReplayCleanupInput {
  readonly outcome: "completed" | "failed";
  readonly primaryErrorDigestSha256: string | null;
}

export interface ProductionReplayEnginePorts {
  readonly bundleAuthority: ProductionReplayBundleAuthorityPort;
  readonly artifacts: ProductionReplayArtifactResolverPort;
  readonly checkpoint: ProductionReplayCheckpointPort;
  readonly driver: ProductionReplayDriverPort;
  readonly observer: ProductionReplayObserverPort;
  readonly hardOracle: ProductionReplayHardOraclePort;
}

export interface ProductionReplayEngineRequest {
  readonly sealedBundleEnvelope: string;
  readonly maxEventLagMs: number;
  readonly portCallTimeoutMs: number;
}

export interface ProductionReplayEngineReport {
  readonly engineKind: "generic_contract";
  readonly status: "accepted" | "correctness_failed";
  readonly fidelity: TranscriptFidelity;
  readonly fidelityMatched: true;
  readonly correctness: "passed" | "failed";
  readonly exact: false;
  readonly exactBlockers: readonly ["generic_contract_is_not_operational_attestation"];
  readonly manifestDigestSha256: string;
  readonly expectedTranscriptDigestSha256: string;
  readonly actualTranscriptDigestSha256: string;
  readonly expectedStateDigestSha256: string;
  readonly actualStateDigestSha256: string;
  readonly hardOracleDigestSha256: string;
  readonly expectedEventCount: number;
  readonly observedEventCount: number;
  readonly injectedTriggerCount: number;
  readonly outputCount: number;
  readonly finalStateRecordCount: number;
  readonly deterministicConsumptionCount: number;
  readonly hardOracleCheckCount: number;
  readonly hardOracleFailedCount: number;
  readonly artifactCount: number;
  readonly windowStartedAtMs: number;
  readonly windowCompletedAtMs: number;
  readonly durationMs: number;
}

export type ProductionReplayPortName =
  | "bundle"
  | "artifact"
  | "checkpoint"
  | "driver"
  | "observer"
  | "hard_oracle";

export type ProductionReplayPortOperation =
  | "verify"
  | "resolve"
  | "attest"
  | "start"
  | "inject_trigger"
  | "next_event"
  | "finish"
  | "evaluate"
  | "stop";

export interface ProductionReplayCleanupFailure {
  readonly port: "driver" | "observer";
  readonly failureKind: "reported" | "thrown" | "invalid" | "timeout";
  readonly failureDigestSha256: string;
}

type ProductionReplayEnginePrimaryError =
  | {
      readonly kind: "authentication_failed";
      readonly component: "bundle";
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "artifact_invalid";
      readonly artifact: ReplayBundleBlobKind;
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "checkpoint_ineligible";
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "invalid_replay_policy";
      readonly expectedEventSeq: number;
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "port_failure";
      readonly port: Exclude<ProductionReplayPortName, "bundle">;
      readonly failureDigestSha256: string;
      readonly expectedEventSeq: number | null;
    }
  | {
      readonly kind: "invalid_port_result";
      readonly port: Exclude<ProductionReplayPortName, "bundle">;
      readonly evidenceDigestSha256: string;
      readonly expectedEventSeq: number | null;
    }
  | {
      readonly kind: "port_timeout";
      readonly port: ProductionReplayPortName;
      readonly operation: ProductionReplayPortOperation;
      readonly evidenceDigestSha256: string;
      readonly expectedEventSeq: number | null;
    }
  | {
      readonly kind: "determinism_violation";
      readonly use: "under" | "over" | "mismatch";
      readonly component: DeterministicSequenceKind | "cassette";
      readonly evidenceDigestSha256: string;
    }
  | {
      readonly kind: "divergence";
      readonly phase:
        | "event_missing"
        | "event_changed"
        | "event_unexpected"
        | "observed_records";
      readonly divergenceKind: ProductionReplayDivergenceKind | null;
      readonly expectedEventSeq: number | null;
      readonly observedEventCount: number;
      readonly expectedDigestSha256: string;
      readonly actualDigestSha256: string;
    }
  | {
      readonly kind: "hard_oracle_invalid";
      readonly evidenceDigestSha256: string;
    };

export type ProductionReplayEngineError =
  | (ProductionReplayEnginePrimaryError & {
      readonly cleanupFailures?: readonly ProductionReplayCleanupFailure[];
    })
  | {
      readonly kind: "cleanup_failed";
      readonly evidenceDigestSha256: string;
      readonly cleanupFailures: readonly ProductionReplayCleanupFailure[];
    };

interface InternalPortError {
  readonly kind: "reported" | "thrown" | "invalid" | "timeout";
  readonly digestSha256: string;
}

interface ClockRecord {
  readonly ordinal: number;
  readonly valueMs: number;
}

interface RandomRecord {
  readonly ordinal: number;
  readonly value: Uint8Array;
}

interface IdentifierRecord {
  readonly ordinal: number;
  readonly value: string;
}

interface ParsedSequences {
  clock: readonly ClockRecord[];
  random: readonly RandomRecord[];
  identifier: readonly IdentifierRecord[];
}

interface ParsedCassette {
  readonly manifest: ReplayCassette;
  readonly requestPayloadDigestSha256: string;
  readonly responsePayloadDigestSha256: string;
  readonly responsePayload: Uint8Array;
}

interface ParsedExpectedRecords {
  readonly outputs: readonly ReplayObservedRecord[];
  readonly state: readonly ReplayObservedRecord[];
}

interface DeterminismTracker {
  readonly port: ProductionReplayDeterminismPort;
  readonly audit: () => Result<number, ProductionReplayEngineError>;
  readonly violation: () => ProductionReplayEngineError | null;
}

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,511}$/u;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_SEQUENCE_RECORDS = 1_000_000;
const MAX_OBSERVED_RECORDS = 1_000_000;
const MAX_HARD_ORACLES = 10_000;
const MAX_PORT_CALL_TIMEOUT_MS = 5 * 60 * 1_000;
const PORT_CALL_TIMED_OUT = Symbol("production-replay-port-call-timed-out");
const OBSERVED_SURFACES = new Set<string>([
  "wire",
  "sqlite",
  "file",
  "security",
  "durable",
  "delivery",
  "memory",
  "scheduler",
  "workspace",
  "config",
]);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function digestCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

function observedRecordsDigest(records: readonly ReplayObservedRecord[]): string {
  return digestCanonical(
    [...records].sort((left, right) =>
      `${left.surface}\0${left.recordId}`.localeCompare(
        `${right.surface}\0${right.recordId}`,
        "en",
      ),
    ),
  );
}

function safeThrownDigest(value: unknown): string {
  return value instanceof Error
    ? sha256(`production-replay-port-v2\0${value.name}\0${value.message}`)
    : sha256("production-replay-port-v2\0non-error");
}

function evidenceDigest(code: string): string {
  return sha256(`production-replay-engine-v2\0${code}`);
}

async function invokePort<T>(
  operation: (
    context: ProductionReplayPortCallContext,
  ) => MaybePromise<Result<T, ProductionReplayPortFailure>>,
  timeoutMs: number,
  operationName: ProductionReplayPortOperation,
): Promise<Result<T, InternalPortError>> {
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + timeoutMs;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<typeof PORT_CALL_TIMED_OUT>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      resolve(PORT_CALL_TIMED_OUT);
    }, timeoutMs);
  });
  const attempted = await fromPromise(
    Promise.race([
      Promise.resolve().then(() =>
        operation({ signal: controller.signal, deadlineAtMs }),
      ),
      timedOut,
    ]),
  );
  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  if (!attempted.ok) {
    return err({ kind: "thrown", digestSha256: safeThrownDigest(attempted.error) });
  }
  if (attempted.value === PORT_CALL_TIMED_OUT) {
    return err({
      kind: "timeout",
      digestSha256: evidenceDigest(`port-timeout-${operationName}`),
    });
  }
  const result = attempted.value as unknown;
  if (!isRecord(result) || typeof result.ok !== "boolean") {
    return err({ kind: "invalid", digestSha256: evidenceDigest("port-result") });
  }
  if (result.ok) {
    return hasExactKeys(result, ["ok", "value"])
      ? ok(result.value as T)
      : err({ kind: "invalid", digestSha256: evidenceDigest("port-success") });
  }
  if (
    !hasExactKeys(result, ["ok", "error"]) ||
    !isRecord(result.error) ||
    !hasExactKeys(result.error, ["kind", "failureDigestSha256"]) ||
    result.error.kind !== "port_failure" ||
    !isDigest(result.error.failureDigestSha256)
  ) {
    return err({ kind: "invalid", digestSha256: evidenceDigest("port-failure") });
  }
  return err({ kind: "reported", digestSha256: result.error.failureDigestSha256 });
}

function mapPortError(
  error: InternalPortError,
  port: Exclude<ProductionReplayPortName, "bundle">,
  operation: ProductionReplayPortOperation,
  expectedEventSeq: number | null = null,
): ProductionReplayEngineError {
  if (error.kind === "timeout") {
    return {
      kind: "port_timeout",
      port,
      operation,
      evidenceDigestSha256: error.digestSha256,
      expectedEventSeq,
    };
  }
  return error.kind === "invalid"
    ? {
        kind: "invalid_port_result",
        port,
        evidenceDigestSha256: error.digestSha256,
        expectedEventSeq,
      }
    : {
        kind: "port_failure",
        port,
        failureDigestSha256: error.digestSha256,
        expectedEventSeq,
      };
}

function validateVerifiedBundle(
  value: unknown,
  sealedBundleEnvelope: string,
): ProductionReplayBundleManifest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["authentication", "authorityKeyIdSha256", "manifest"]) ||
    value.authentication !== "verified" ||
    !isDigest(value.authorityKeyIdSha256) ||
    !isRecord(value.manifest) ||
    !isRecord(value.manifest.seal) ||
    value.manifest.seal.keyIdSha256 !== value.authorityKeyIdSha256
  ) {
    return null;
  }
  const formatted = tryCatch(() =>
    formatProductionReplayBundleManifest(
      value.manifest as unknown as ProductionReplayBundleManifest,
    ),
  );
  return formatted.ok && formatted.value === sealedBundleEnvelope
    ? (value.manifest as unknown as ProductionReplayBundleManifest)
    : null;
}

function decodeUtf8Json(
  plaintext: Uint8Array,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_ARTIFACT_BYTES) return null;
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  if (!decoded.ok || decoded.value.includes("\0") || decoded.value.includes("\r")) return null;
  const parsed = tryCatch(() => JSON.parse(decoded.value) as unknown);
  if (!parsed.ok || !isRecord(parsed.value) || !hasExactKeys(parsed.value, keys)) return null;
  if (JSON.stringify(parsed.value) !== decoded.value) return null;
  return parsed.value;
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

async function resolveArtifact(
  manifest: ProductionReplayBundleManifest,
  resolver: ProductionReplayArtifactResolverPort,
  digestSha256: string,
  kind: ReplayBundleBlobKind,
  portCallTimeoutMs: number,
): Promise<Result<ProductionReplayResolvedArtifact, ProductionReplayEngineError>> {
  const declared = manifest.vault.blobs.find((blob) => blob.digestSha256 === digestSha256);
  if (declared?.kind !== kind) {
    return err({ kind: "artifact_invalid", artifact: kind, evidenceDigestSha256: evidenceDigest("reference") });
  }
  const resolved = await invokePort(
    (context) => resolver.resolve({ kind, digestSha256 }, context),
    portCallTimeoutMs,
    "resolve",
  );
  if (!resolved.ok) {
    return err(mapPortError(resolved.error, "artifact", "resolve"));
  }
  const value = resolved.value;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["authentication", "kind", "digestSha256", "bytes", "plaintext"]) ||
    value.authentication !== "verified" ||
    value.kind !== kind ||
    value.digestSha256 !== digestSha256 ||
    value.bytes !== declared.bytes ||
    !(value.plaintext instanceof Uint8Array) ||
    value.plaintext.byteLength !== declared.bytes ||
    sha256(value.plaintext) !== digestSha256
  ) {
    return err({ kind: "artifact_invalid", artifact: kind, evidenceDigestSha256: evidenceDigest("authentication") });
  }
  return ok(value as unknown as ProductionReplayResolvedArtifact);
}

function parseSequence(
  plaintext: Uint8Array,
  kind: DeterministicSequenceKind,
  expectedCount: number,
): Result<ParsedSequences[DeterministicSequenceKind], ProductionReplayEngineError> {
  const artifactKind = `${kind}_sequence` as ReplayBundleBlobKind;
  const decoded = decodeUtf8Json(plaintext, ["schema", "schemaVersion", "kind", "records"]);
  if (
    decoded === null ||
    decoded.schema !== "comis-production-replay-sequence" ||
    decoded.schemaVersion !== 1 ||
    decoded.kind !== kind ||
    !Array.isArray(decoded.records) ||
    decoded.records.length !== expectedCount ||
    decoded.records.length > MAX_SEQUENCE_RECORDS
  ) {
    return err({ kind: "artifact_invalid", artifact: artifactKind, evidenceDigestSha256: evidenceDigest("sequence-header") });
  }
  if (kind === "clock") {
    const records: ClockRecord[] = [];
    for (let index = 0; index < decoded.records.length; index += 1) {
      const record = decoded.records.at(index);
      if (!isRecord(record) || !hasExactKeys(record, ["ordinal", "valueMs"]) || record.ordinal !== index + 1 || !isCount(record.valueMs)) {
        return err({ kind: "artifact_invalid", artifact: artifactKind, evidenceDigestSha256: evidenceDigest("clock-record") });
      }
      records.push({ ordinal: record.ordinal, valueMs: record.valueMs });
    }
    return ok(records);
  }
  if (kind === "random") {
    const records: RandomRecord[] = [];
    for (let index = 0; index < decoded.records.length; index += 1) {
      const record = decoded.records.at(index);
      const value = isRecord(record) ? decodeBase64(record.valueBase64) : null;
      if (!isRecord(record) || !hasExactKeys(record, ["ordinal", "valueBase64"]) || record.ordinal !== index + 1 || value === null) {
        return err({ kind: "artifact_invalid", artifact: artifactKind, evidenceDigestSha256: evidenceDigest("random-record") });
      }
      records.push({ ordinal: record.ordinal, value });
    }
    return ok(records);
  }
  const records: IdentifierRecord[] = [];
  for (let index = 0; index < decoded.records.length; index += 1) {
    const record = decoded.records.at(index);
    if (!isRecord(record) || !hasExactKeys(record, ["ordinal", "value"]) || record.ordinal !== index + 1 || typeof record.value !== "string" || !SAFE_ID_RE.test(record.value)) {
      return err({ kind: "artifact_invalid", artifact: artifactKind, evidenceDigestSha256: evidenceDigest("identifier-record") });
    }
    records.push({ ordinal: record.ordinal, value: record.value });
  }
  return ok(records);
}

function parseCassetteRequest(
  plaintext: Uint8Array,
  cassette: ReplayCassette,
): Result<Uint8Array, ProductionReplayEngineError> {
  const decoded = decodeUtf8Json(plaintext, ["schema", "schemaVersion", "direction", "cassetteId", "kind", "ordinal", "payloadBase64"]);
  const payload = decoded === null ? null : decodeBase64(decoded.payloadBase64);
  if (
    decoded === null ||
    decoded.schema !== "comis-production-replay-cassette" ||
    decoded.schemaVersion !== 1 ||
    decoded.direction !== "request" ||
    decoded.cassetteId !== cassette.cassetteId ||
    decoded.kind !== cassette.kind ||
    decoded.ordinal !== cassette.ordinal ||
    payload === null
  ) {
    return err({ kind: "artifact_invalid", artifact: "cassette_request", evidenceDigestSha256: evidenceDigest("cassette-request") });
  }
  return ok(payload);
}

function parseCassetteResponse(
  plaintext: Uint8Array,
  cassette: ReplayCassette,
): Result<Uint8Array, ProductionReplayEngineError> {
  const decoded = decodeUtf8Json(plaintext, ["schema", "schemaVersion", "direction", "cassetteId", "kind", "ordinal", "outcome", "latencyMs", "payloadBase64"]);
  const payload = decoded === null ? null : decodeBase64(decoded.payloadBase64);
  if (
    decoded === null ||
    decoded.schema !== "comis-production-replay-cassette" ||
    decoded.schemaVersion !== 1 ||
    decoded.direction !== "response" ||
    decoded.cassetteId !== cassette.cassetteId ||
    decoded.kind !== cassette.kind ||
    decoded.ordinal !== cassette.ordinal ||
    decoded.outcome !== cassette.outcome ||
    decoded.latencyMs !== cassette.latencyMs ||
    payload === null
  ) {
    return err({ kind: "artifact_invalid", artifact: "cassette_response", evidenceDigestSha256: evidenceDigest("cassette-response") });
  }
  return ok(payload);
}

function validObservedRecord(value: unknown): value is ReplayObservedRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["surface", "recordId", "valueDigest", "causalEventId"]) &&
    typeof value.surface === "string" &&
    OBSERVED_SURFACES.has(value.surface) &&
    typeof value.recordId === "string" &&
    SAFE_ID_RE.test(value.recordId) &&
    isDigest(value.valueDigest) &&
    (value.causalEventId === null ||
      (typeof value.causalEventId === "string" && SAFE_ID_RE.test(value.causalEventId)))
  );
}

function hasUniqueObservedRecordKeys(records: readonly ReplayObservedRecord[]): boolean {
  const keys = new Set(records.map((record) => `${record.surface}\0${record.recordId}`));
  return keys.size === records.length;
}

function parseExpectedRecords(
  plaintext: Uint8Array,
  kind: "expected_outputs" | "expected_state",
): Result<readonly ReplayObservedRecord[], ProductionReplayEngineError> {
  const decoded = decodeUtf8Json(plaintext, ["schema", "schemaVersion", "kind", "records"]);
  if (
    decoded === null ||
    decoded.schema !== "comis-production-replay-observed-records" ||
    decoded.schemaVersion !== 1 ||
    decoded.kind !== kind ||
    !Array.isArray(decoded.records) ||
    decoded.records.length > MAX_OBSERVED_RECORDS ||
    decoded.records.some((record: unknown) => !validObservedRecord(record)) ||
    !hasUniqueObservedRecordKeys(decoded.records as ReplayObservedRecord[]) ||
    decoded.records.some((record: ReplayObservedRecord) =>
      kind === "expected_outputs" ? record.surface !== "wire" : record.surface === "wire",
    )
  ) {
    return err({ kind: "artifact_invalid", artifact: kind, evidenceDigestSha256: evidenceDigest("observed-records") });
  }
  return ok(decoded.records as ReplayObservedRecord[]);
}

function reconcileTranscript(
  manifest: ProductionReplayBundleManifest,
  transcript: CanonicalProductionTranscript,
): boolean {
  if (manifest.transcript.captureId !== transcript.captureId || manifest.transcript.eventCount !== transcript.events.length) return false;
  const counts = new Map<string, number>();
  for (const event of transcript.events) {
    const key = `${event.source.kind}\0${event.source.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const declared = new Map(manifest.transcript.authorities.map((authority) => [`${authority.kind}\0${authority.sourceId}`, authority.transcriptCount]));
  return counts.size === declared.size && [...counts].every(([key, count]) => declared.get(key) === count);
}

function isInjectableRoot(event: CanonicalProductionEvent): boolean {
  return (
    event.causalParentEventId === null &&
    (/^channel\.native\..+_received$/u.test(event.kind) ||
      event.kind === "cron.fire.started" ||
      event.kind === "heartbeat.requested" ||
      event.kind === "proactive.triggered" ||
      event.kind === "system.dispatch.enqueued")
  );
}

function strictObservedEvent(value: unknown): value is CanonicalProductionEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["seq", "source", "kind", "eventId", "traceId", "sessionId", "runId", "jobId", "clockId", "wallTimeMs", "monotonicTimeNs", "causalParentEventId", "actor", "replay"]) &&
    isRecord(value.source) &&
    hasExactKeys(value.source, ["kind", "id", "seq"]) &&
    isRecord(value.actor) &&
    hasExactKeys(value.actor, ["kind", "id", "trust", "origin"]) &&
    isRecord(value.replay) &&
    hasExactKeys(value.replay, ["policy", "idempotencyKey", "payloadDigest", "blobDigest"])
  );
}

function createDeterminismTracker(
  sequences: ParsedSequences,
  cassettes: readonly ParsedCassette[],
): DeterminismTracker {
  const cursors: Record<DeterministicSequenceKind, number> = { clock: 0, random: 0, identifier: 0 };
  const cassetteCursors = new Map<ReplayCassetteKind, number>(CASSETTE_KINDS.map((kind) => [kind, 0]));
  let violation: ProductionReplayEngineError | null = null;
  let consumptionCount = 0;
  const fail = (use: "over" | "mismatch", component: DeterministicSequenceKind | "cassette"): ProductionReplayDeterminismFailure => {
    violation ??= { kind: "determinism_violation", use, component, evidenceDigestSha256: evidenceDigest(`${use}-${component}`) };
    return { kind: "determinism_unavailable", component, evidenceDigestSha256: evidenceDigest(`${use}-${component}`) };
  };
  const port: ProductionReplayDeterminismPort = {
    nextClock: () => {
      const record = sequences.clock.at(cursors.clock);
      if (record === undefined) return err(fail("over", "clock"));
      cursors.clock += 1;
      consumptionCount += 1;
      return ok(record.valueMs);
    },
    nextRandom: (byteLength) => {
      const record = sequences.random.at(cursors.random);
      if (record === undefined) return err(fail("over", "random"));
      if (!isCount(byteLength) || record.value.byteLength !== byteLength) return err(fail("mismatch", "random"));
      cursors.random += 1;
      consumptionCount += 1;
      return ok(Uint8Array.from(record.value));
    },
    nextIdentifier: () => {
      const record = sequences.identifier.at(cursors.identifier);
      if (record === undefined) return err(fail("over", "identifier"));
      cursors.identifier += 1;
      consumptionCount += 1;
      return ok(record.value);
    },
    consumeCassette: (kind, requestPayload) => {
      const byKind = cassettes.filter((cassette) => cassette.manifest.kind === kind);
      const cursor = cassetteCursors.get(kind) ?? 0;
      const cassette = byKind.at(cursor);
      if (cassette === undefined) return err(fail("over", "cassette"));
      if (!(requestPayload instanceof Uint8Array) || sha256(requestPayload) !== cassette.requestPayloadDigestSha256) return err(fail("mismatch", "cassette"));
      cassetteCursors.set(kind, cursor + 1);
      consumptionCount += 1;
      return ok({
        outcome: cassette.manifest.outcome,
        latencyMs: cassette.manifest.latencyMs,
        responsePayloadDigestSha256: cassette.responsePayloadDigestSha256,
        responsePayload: Uint8Array.from(cassette.responsePayload),
      });
    },
  };
  const audit = (): Result<number, ProductionReplayEngineError> => {
    if (violation !== null) return err(violation);
    const missingSequence: DeterministicSequenceKind | null =
      cursors.clock !== sequences.clock.length
        ? "clock"
        : cursors.random !== sequences.random.length
          ? "random"
          : cursors.identifier !== sequences.identifier.length
            ? "identifier"
            : null;
    if (missingSequence !== null) {
      return err({
        kind: "determinism_violation",
        use: "under",
        component: missingSequence,
        evidenceDigestSha256: evidenceDigest(`under-${missingSequence}`),
      });
    }
    for (const kind of CASSETTE_KINDS) {
      const expected = cassettes.filter((cassette) => cassette.manifest.kind === kind).length;
      if ((cassetteCursors.get(kind) ?? 0) !== expected) {
        return err({ kind: "determinism_violation", use: "under", component: "cassette", evidenceDigestSha256: evidenceDigest(`under-cassette-${kind}`) });
      }
    }
    return ok(consumptionCount);
  };
  return { port, audit, violation: () => violation };
}

async function loadTranscript(
  manifest: ProductionReplayBundleManifest,
  resolver: ProductionReplayArtifactResolverPort,
  portCallTimeoutMs: number,
): Promise<Result<{ transcript: CanonicalProductionTranscript; artifactCount: number }, ProductionReplayEngineError>> {
  const artifact = await resolveArtifact(
    manifest,
    resolver,
    manifest.transcript.blobDigestSha256,
    "canonical_transcript",
    portCallTimeoutMs,
  );
  if (!artifact.ok) return artifact;
  const decoded = tryCatch(() => new TextDecoder("utf-8", { fatal: true }).decode(artifact.value.plaintext));
  if (!decoded.ok) return err({ kind: "artifact_invalid", artifact: "canonical_transcript", evidenceDigestSha256: evidenceDigest("transcript-encoding") });
  const parsed = parseCanonicalProductionTranscript(decoded.value);
  if (!parsed.ok || !reconcileTranscript(manifest, parsed.value)) {
    return err({ kind: "artifact_invalid", artifact: "canonical_transcript", evidenceDigestSha256: evidenceDigest("transcript-contract") });
  }
  return ok({ transcript: parsed.value, artifactCount: 1 });
}

async function loadEpisode(
  manifest: ProductionReplayBundleManifest,
  resolver: ProductionReplayArtifactResolverPort,
  portCallTimeoutMs: number,
): Promise<Result<ProductionCaptureEpisode, ProductionReplayEngineError>> {
  const artifact = await resolveArtifact(
    manifest,
    resolver,
    manifest.episode.blobDigestSha256,
    "capture_episode",
    portCallTimeoutMs,
  );
  if (!artifact.ok) return artifact;
  const decoded = tryCatch(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(artifact.value.plaintext),
  );
  if (!decoded.ok) {
    return err({
      kind: "artifact_invalid",
      artifact: "capture_episode",
      evidenceDigestSha256: evidenceDigest("episode-encoding"),
    });
  }
  const parsed = parseProductionCaptureEpisode(decoded.value);
  if (!parsed.ok) {
    return err({
      kind: "artifact_invalid",
      artifact: "capture_episode",
      evidenceDigestSha256: evidenceDigest("episode-contract"),
    });
  }
  const episode = parsed.value;
  const summaryMatches =
    episode.episodeId === manifest.episode.episodeId &&
    episode.captureMode === manifest.episode.captureMode &&
    episode.window.startAtMs === manifest.episode.windowStartAtMs &&
    episode.window.endAtMs === manifest.episode.windowEndAtMs &&
    episode.initialCheckpoint.snapshotManifestDigestSha256 ===
      manifest.episode.initialCheckpointSnapshotManifestDigestSha256 &&
    episode.replayInput.inputSetDigestSha256 === manifest.episode.inputSetDigestSha256 &&
    episode.replayInput.target === manifest.episode.target &&
    episode.replayInput.classification === manifest.episode.classification &&
    episode.replayInput.exactEligible === manifest.episode.exactEligible;
  const checkpointMatches =
    episode.initialCheckpoint.status === "captured" &&
    episode.initialCheckpoint.quiescence === "verified" &&
    episode.initialCheckpoint.capturedAtMs !== null &&
    episode.initialCheckpoint.capturedAtMs < episode.window.startAtMs &&
    episode.initialCheckpoint.stateTreeDigestSha256 ===
      manifest.attestations.state.source.treeDigestSha256 &&
    episode.initialCheckpoint.entryCount === manifest.attestations.state.source.entryCount &&
    episode.initialCheckpoint.bytes === manifest.attestations.state.source.bytes;
  const sourceMatches = manifest.transcript.authorities.every((authority) => {
    const matching = episode.sourceAuthorities.find(
      (candidate) =>
        candidate.kind === authority.kind &&
        candidate.sourceIdDigestSha256 === sha256(authority.sourceId),
    );
    return (
      matching !== undefined &&
      matching.transcriptCount === authority.transcriptCount &&
      matching.authoritativeCount === authority.authoritativeCount
    );
  });
  const deterministicInputsMatch = manifest.determinism.sequences.every((sequence) => {
    const matching = episode.deterministicInputs.find(({ kind }) => kind === sequence.kind);
    return (
      matching !== undefined &&
      matching.capturedCount === sequence.recordCount &&
      matching.authoritativeCount === sequence.recordCount
    );
  });
  const cassettesMatch = manifest.determinism.cassetteAuthorities.every((authority) => {
    const matching = episode.cassetteAuthorities.find(({ kind }) => kind === authority.kind);
    return (
      matching !== undefined &&
      matching.cassetteCount === authority.cassetteCount &&
      matching.authoritativeCount === authority.authoritativeCount
    );
  });
  const finalObservationMatches =
    episode.finalObservation.outputIndexDigestSha256 ===
      manifest.expected.outputBlobDigestSha256 &&
    episode.finalObservation.outputCount === manifest.expected.outputCount &&
    episode.finalObservation.finalStateDigestSha256 ===
      manifest.expected.finalStateDigestSha256 &&
    episode.finalObservation.finalStateRecordCount ===
      manifest.expected.finalStateRecordCount;
  if (
    !summaryMatches ||
    !checkpointMatches ||
    !sourceMatches ||
    !deterministicInputsMatch ||
    !cassettesMatch ||
    !finalObservationMatches
  ) {
    return err({
      kind: "artifact_invalid",
      artifact: "capture_episode",
      evidenceDigestSha256: evidenceDigest("episode-reconciliation"),
    });
  }
  return ok(episode);
}

async function loadReplayArtifacts(
  manifest: ProductionReplayBundleManifest,
  resolver: ProductionReplayArtifactResolverPort,
  transcript: CanonicalProductionTranscript,
  portCallTimeoutMs: number,
): Promise<Result<{ sequences: ParsedSequences; cassettes: readonly ParsedCassette[]; expected: ParsedExpectedRecords; triggerPayloads: ReadonlyMap<string, Uint8Array>; artifactCount: number }, ProductionReplayEngineError>> {
  const parsedSequenceEntries: Partial<ParsedSequences> = {};
  let artifactCount = 0;
  for (const sequence of manifest.determinism.sequences) {
    if (sequence.status !== "captured" || sequence.blobDigestSha256 === null) {
      return err({ kind: "artifact_invalid", artifact: `${sequence.kind}_sequence`, evidenceDigestSha256: evidenceDigest("sequence-missing") });
    }
    const artifact = await resolveArtifact(
      manifest,
      resolver,
      sequence.blobDigestSha256,
      `${sequence.kind}_sequence`,
      portCallTimeoutMs,
    );
    if (!artifact.ok) return artifact;
    artifactCount += 1;
    const parsed = parseSequence(artifact.value.plaintext, sequence.kind, sequence.recordCount);
    if (!parsed.ok) return parsed;
    if (sequence.kind === "clock") parsedSequenceEntries.clock = parsed.value as readonly ClockRecord[];
    else if (sequence.kind === "random") parsedSequenceEntries.random = parsed.value as readonly RandomRecord[];
    else parsedSequenceEntries.identifier = parsed.value as readonly IdentifierRecord[];
  }
  if (parsedSequenceEntries.clock === undefined || parsedSequenceEntries.random === undefined || parsedSequenceEntries.identifier === undefined) {
    return err({ kind: "artifact_invalid", artifact: "clock_sequence", evidenceDigestSha256: evidenceDigest("sequence-inventory") });
  }

  const cassettes: ParsedCassette[] = [];
  const requestPayloads = new Map<string, Uint8Array>();
  for (const cassette of manifest.determinism.cassettes) {
    const request = await resolveArtifact(
      manifest,
      resolver,
      cassette.requestBlobDigestSha256,
      "cassette_request",
      portCallTimeoutMs,
    );
    if (!request.ok) return request;
    const response = await resolveArtifact(
      manifest,
      resolver,
      cassette.responseBlobDigestSha256,
      "cassette_response",
      portCallTimeoutMs,
    );
    if (!response.ok) return response;
    artifactCount += 2;
    const parsedRequest = parseCassetteRequest(request.value.plaintext, cassette);
    if (!parsedRequest.ok) return parsedRequest;
    const parsedResponse = parseCassetteResponse(response.value.plaintext, cassette);
    if (!parsedResponse.ok) return parsedResponse;
    requestPayloads.set(cassette.requestBlobDigestSha256, parsedRequest.value);
    cassettes.push({
      manifest: cassette,
      requestPayloadDigestSha256: sha256(parsedRequest.value),
      responsePayloadDigestSha256: sha256(parsedResponse.value),
      responsePayload: parsedResponse.value,
    });
  }

  const outputsArtifact = await resolveArtifact(
    manifest,
    resolver,
    manifest.expected.outputBlobDigestSha256,
    "expected_outputs",
    portCallTimeoutMs,
  );
  if (!outputsArtifact.ok) return outputsArtifact;
  const stateArtifact = await resolveArtifact(
    manifest,
    resolver,
    manifest.expected.finalStateBlobDigestSha256,
    "expected_state",
    portCallTimeoutMs,
  );
  if (!stateArtifact.ok) return stateArtifact;
  artifactCount += 2;
  const outputs = parseExpectedRecords(outputsArtifact.value.plaintext, "expected_outputs");
  if (!outputs.ok) return outputs;
  const state = parseExpectedRecords(stateArtifact.value.plaintext, "expected_state");
  if (!state.ok) return state;
  if (outputs.value.length !== manifest.expected.outputCount || state.value.length !== manifest.expected.finalStateRecordCount) {
    return err({ kind: "artifact_invalid", artifact: outputs.value.length !== manifest.expected.outputCount ? "expected_outputs" : "expected_state", evidenceDigestSha256: evidenceDigest("expected-count") });
  }

  for (const event of transcript.events) {
    if (isInjectableRoot(event) && event.replay.policy !== "inject") {
      return err({
        kind: "invalid_replay_policy",
        expectedEventSeq: event.seq,
        evidenceDigestSha256: evidenceDigest("causal-root-policy"),
      });
    }
    if (event.replay.policy !== "inject") continue;
    if (!isInjectableRoot(event) || event.replay.blobDigest === null) {
      return err({ kind: "invalid_replay_policy", expectedEventSeq: event.seq, evidenceDigestSha256: evidenceDigest("inject-policy") });
    }
    const payload = requestPayloads.get(event.replay.blobDigest);
    if (payload === undefined || sha256(payload) !== event.replay.payloadDigest) {
      return err({ kind: "invalid_replay_policy", expectedEventSeq: event.seq, evidenceDigestSha256: evidenceDigest("trigger-payload") });
    }
  }

  return ok({
    sequences: parsedSequenceEntries as ParsedSequences,
    cassettes,
    expected: { outputs: outputs.value, state: state.value },
    triggerPayloads: requestPayloads,
    artifactCount,
  });
}

function validateCheckpoint(
  value: unknown,
  manifest: ProductionReplayBundleManifest,
  windowStartMs: number,
): Result<{ attestation: ProductionReplayCheckpointAttestation; prospective: boolean }, ProductionReplayEngineError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["authentication", "kind", "manifestDigestSha256", "runtimeDigestSha256", "stateDigestSha256", "completedAtMs"]) ||
    value.authentication !== "verified" ||
    (value.kind !== "prospective_pre_window" && value.kind !== "historical_snapshot") ||
    value.manifestDigestSha256 !== manifest.seal.manifestDigestSha256 ||
    value.runtimeDigestSha256 !== manifest.attestations.runtime.source.digestSha256 ||
    value.stateDigestSha256 !== manifest.attestations.state.source.treeDigestSha256 ||
    !isCount(value.completedAtMs) ||
    value.completedAtMs > windowStartMs
  ) {
    return err({ kind: "checkpoint_ineligible", evidenceDigestSha256: evidenceDigest("checkpoint-contract") });
  }
  if (manifest.fidelity.exactEligible && value.kind !== "prospective_pre_window") {
    return err({ kind: "checkpoint_ineligible", evidenceDigestSha256: evidenceDigest("checkpoint-prospective") });
  }
  return ok({ attestation: value as unknown as ProductionReplayCheckpointAttestation, prospective: value.kind === "prospective_pre_window" });
}

function validateObserverResult(value: unknown): value is ProductionReplayObserverResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["outputs", "state"]) &&
    Array.isArray(value.outputs) &&
    Array.isArray(value.state) &&
    value.outputs.length <= MAX_OBSERVED_RECORDS &&
    value.state.length <= MAX_OBSERVED_RECORDS &&
    value.outputs.every(validObservedRecord) &&
    value.state.every(validObservedRecord) &&
    value.outputs.every((record) => record.surface === "wire") &&
    value.state.every((record) => record.surface !== "wire")
  );
}

function validateHardOracles(
  value: unknown,
  expectedOracleSetDigestSha256: string,
  expectedOracleCount: number,
): value is ProductionReplayHardOracleResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["oracleSetDigestSha256", "checks"]) &&
    value.oracleSetDigestSha256 === expectedOracleSetDigestSha256 &&
    Array.isArray(value.checks) &&
    value.checks.length === expectedOracleCount &&
    value.checks.length <= MAX_HARD_ORACLES &&
    value.checks.every(
      (check) =>
        isRecord(check) &&
        hasExactKeys(check, ["oracleIdSha256", "passed", "evidenceDigestSha256"]) &&
        isDigest(check.oracleIdSha256) &&
        typeof check.passed === "boolean" &&
        isDigest(check.evidenceDigestSha256),
    ) &&
    new Set(value.checks.map((check) => check.oracleIdSha256)).size === value.checks.length
  );
}

async function stopReplayPort(
  port: "driver" | "observer",
  stop: (
    input: ProductionReplayCleanupInput,
    context: ProductionReplayPortCallContext,
  ) => MaybePromise<Result<void, ProductionReplayPortFailure>>,
  input: ProductionReplayCleanupInput,
  portCallTimeoutMs: number,
): Promise<ProductionReplayCleanupFailure | null> {
  const stopped = await invokePort(
    (context) => stop(input, context),
    portCallTimeoutMs,
    "stop",
  );
  if (!stopped.ok) {
    return {
      port,
      failureKind: stopped.error.kind,
      failureDigestSha256: stopped.error.digestSha256,
    };
  }
  if (stopped.value !== undefined) {
    return {
      port,
      failureKind: "invalid",
      failureDigestSha256: evidenceDigest(`${port}-stop-result`),
    };
  }
  return null;
}

function attachCleanupFailures(
  result: Result<ProductionReplayEngineReport, ProductionReplayEngineError>,
  cleanupFailures: readonly ProductionReplayCleanupFailure[],
): Result<ProductionReplayEngineReport, ProductionReplayEngineError> {
  if (cleanupFailures.length === 0) return result;
  if (!result.ok) {
    return err({ ...result.error, cleanupFailures });
  }
  return err({
    kind: "cleanup_failed",
    evidenceDigestSha256: evidenceDigest("cleanup-failed"),
    cleanupFailures,
  });
}

export async function replayProductionTranscript(
  request: ProductionReplayEngineRequest,
  ports: ProductionReplayEnginePorts,
): Promise<Result<ProductionReplayEngineReport, ProductionReplayEngineError>> {
  if (
    !isRecord(request) ||
    !hasExactKeys(request, [
      "sealedBundleEnvelope",
      "maxEventLagMs",
      "portCallTimeoutMs",
    ]) ||
    typeof request?.sealedBundleEnvelope !== "string" ||
    !isCount(request?.maxEventLagMs) ||
    request.maxEventLagMs === 0 ||
    !isCount(request?.portCallTimeoutMs) ||
    request.portCallTimeoutMs === 0 ||
    request.portCallTimeoutMs > MAX_PORT_CALL_TIMEOUT_MS
  ) {
    return err({ kind: "authentication_failed", component: "bundle", evidenceDigestSha256: evidenceDigest("request") });
  }
  const verifiedBundleAttempt = await invokePort(
    (context) =>
      ports.bundleAuthority.verify(request.sealedBundleEnvelope, context),
    request.portCallTimeoutMs,
    "verify",
  );
  if (!verifiedBundleAttempt.ok) {
    if (verifiedBundleAttempt.error.kind === "timeout") {
      return err({
        kind: "port_timeout",
        port: "bundle",
        operation: "verify",
        evidenceDigestSha256: verifiedBundleAttempt.error.digestSha256,
        expectedEventSeq: null,
      });
    }
    return err({ kind: "authentication_failed", component: "bundle", evidenceDigestSha256: evidenceDigest("bundle") });
  }
  const manifest = validateVerifiedBundle(
    verifiedBundleAttempt.value,
    request.sealedBundleEnvelope,
  );
  if (manifest === null) {
    return err({
      kind: "authentication_failed",
      component: "bundle",
      evidenceDigestSha256: evidenceDigest("bundle-authority"),
    });
  }
  const episodeResult = await loadEpisode(
    manifest,
    ports.artifacts,
    request.portCallTimeoutMs,
  );
  if (!episodeResult.ok) return episodeResult;
  const episode = episodeResult.value;
  const transcriptResult = await loadTranscript(
    manifest,
    ports.artifacts,
    request.portCallTimeoutMs,
  );
  if (!transcriptResult.ok) return transcriptResult;
  const transcript = transcriptResult.value.transcript;
  const windowStartMs = episode.window.startAtMs;
  const windowCompletedAtMs = episode.window.endAtMs;
  if (
    transcript.events.some(
      ({ wallTimeMs }) => wallTimeMs < windowStartMs || wallTimeMs > windowCompletedAtMs,
    )
  ) {
    return err({
      kind: "artifact_invalid",
      artifact: "capture_episode",
      evidenceDigestSha256: evidenceDigest("episode-window"),
    });
  }

  const loaded = await loadReplayArtifacts(
    manifest,
    ports.artifacts,
    transcript,
    request.portCallTimeoutMs,
  );
  if (!loaded.ok) return loaded;
  const checkpointAttempt = await invokePort(
    (context) => ports.checkpoint.attest(context),
    request.portCallTimeoutMs,
    "attest",
  );
  if (!checkpointAttempt.ok) {
    return err(mapPortError(checkpointAttempt.error, "checkpoint", "attest"));
  }
  const checkpoint = validateCheckpoint(checkpointAttempt.value, manifest, windowStartMs);
  if (!checkpoint.ok) return checkpoint;

  const expectedFinalStateDigest = observedRecordsDigest(loaded.value.expected.state);
  if (expectedFinalStateDigest !== manifest.expected.finalStateDigestSha256) {
    return err({ kind: "artifact_invalid", artifact: "expected_state", evidenceDigestSha256: evidenceDigest("state-digest") });
  }

  const determinism = createDeterminismTracker(
    loaded.value.sequences,
    loaded.value.cassettes,
  );
  let observerStartAttempted = false;
  let driverStartAttempted = false;
  const replayResult = await (async (): Promise<
    Result<ProductionReplayEngineReport, ProductionReplayEngineError>
  > => {
    observerStartAttempted = true;
    const observerStarted = await invokePort(
      (context) => ports.observer.start({ windowStartMs }, context),
      request.portCallTimeoutMs,
      "start",
    );
    if (!observerStarted.ok) {
      return err(mapPortError(observerStarted.error, "observer", "start"));
    }
    if (observerStarted.value !== undefined) {
      return err({ kind: "invalid_port_result", port: "observer", evidenceDigestSha256: evidenceDigest("observer-start"), expectedEventSeq: null });
    }

    driverStartAttempted = true;
    const driverStarted = await invokePort(
      (context) =>
        ports.driver.start(
          {
            determinism: determinism.port,
            checkpointDigestSha256: digestCanonical(checkpoint.value.attestation),
            windowStartMs,
          },
          context,
        ),
      request.portCallTimeoutMs,
      "start",
    );
    if (!driverStarted.ok) {
      return err(mapPortError(driverStarted.error, "driver", "start"));
    }
    if (driverStarted.value !== undefined) {
      return err({ kind: "invalid_port_result", port: "driver", evidenceDigestSha256: evidenceDigest("driver-start"), expectedEventSeq: null });
    }
    const startViolation = determinism.violation();
    if (startViolation !== null) return err(startViolation);

    const actualEvents: CanonicalProductionEvent[] = [];
    let injectedTriggerCount = 0;
    let priorDeadline = windowStartMs;
    for (const expectedEvent of transcript.events) {
      if (expectedEvent.replay.policy === "inject") {
        const blobDigest = expectedEvent.replay.blobDigest as string;
        const payload = loaded.value.triggerPayloads.get(blobDigest) as Uint8Array;
        const trigger: ProductionReplayTrigger = {
          kind: expectedEvent.kind,
          sourceKind: expectedEvent.source.kind,
          sourceId: expectedEvent.source.id,
          wallTimeMs: expectedEvent.wallTimeMs,
          idempotencyKeySha256: expectedEvent.replay.idempotencyKey,
          payloadDigestSha256: sha256(payload),
          payload: Uint8Array.from(payload),
        };
        const injected = await invokePort(
          (context) => ports.driver.injectTrigger(trigger, context),
          request.portCallTimeoutMs,
          "inject_trigger",
        );
        if (!injected.ok) {
          return err(
            mapPortError(
              injected.error,
              "driver",
              "inject_trigger",
              expectedEvent.seq,
            ),
          );
        }
        if (injected.value !== undefined) {
          return err({ kind: "invalid_port_result", port: "driver", evidenceDigestSha256: evidenceDigest("trigger-result"), expectedEventSeq: expectedEvent.seq });
        }
        injectedTriggerCount += 1;
        const triggerViolation = determinism.violation();
        if (triggerViolation !== null) return err(triggerViolation);
      }
      const deadlineWallTimeMs = Math.max(
        priorDeadline,
        expectedEvent.wallTimeMs + request.maxEventLagMs,
      );
      priorDeadline = deadlineWallTimeMs;
      const observed = await invokePort(
        (context) =>
          ports.observer.nextEvent(
            { ordinal: expectedEvent.seq, deadlineWallTimeMs },
            context,
          ),
        request.portCallTimeoutMs,
        "next_event",
      );
      if (!observed.ok) {
        return err(
          mapPortError(
            observed.error,
            "observer",
            "next_event",
            expectedEvent.seq,
          ),
        );
      }
      if (observed.value === null) {
        return err({
          kind: "divergence",
          phase: "event_missing",
          divergenceKind: "event_missing",
          expectedEventSeq: expectedEvent.seq,
          observedEventCount: actualEvents.length,
          expectedDigestSha256: digestCanonical(expectedEvent),
          actualDigestSha256: digestCanonical(actualEvents),
        });
      }
      if (!strictObservedEvent(observed.value)) {
        return err({ kind: "invalid_port_result", port: "observer", evidenceDigestSha256: evidenceDigest("observed-event"), expectedEventSeq: expectedEvent.seq });
      }
      const expectedDigestSha256 = digestCanonical(expectedEvent);
      const actualDigestSha256 = digestCanonical(observed.value);
      if (expectedDigestSha256 !== actualDigestSha256) {
        return err({
          kind: "divergence",
          phase: "event_changed",
          divergenceKind: "event_changed",
          expectedEventSeq: expectedEvent.seq,
          observedEventCount: actualEvents.length + 1,
          expectedDigestSha256,
          actualDigestSha256,
        });
      }
      actualEvents.push(observed.value);
    }

    const driverFinished = await invokePort(
      (context) => ports.driver.finish(context),
      request.portCallTimeoutMs,
      "finish",
    );
    if (!driverFinished.ok) {
      return err(mapPortError(driverFinished.error, "driver", "finish"));
    }
    if (driverFinished.value !== undefined) {
      return err({ kind: "invalid_port_result", port: "driver", evidenceDigestSha256: evidenceDigest("driver-finish"), expectedEventSeq: null });
    }
    const usage = determinism.audit();
    if (!usage.ok) return usage;

    const extra = await invokePort(
      (context) =>
        ports.observer.nextEvent(
          {
            ordinal: transcript.events.length + 1,
            deadlineWallTimeMs: priorDeadline,
          },
          context,
        ),
      request.portCallTimeoutMs,
      "next_event",
    );
    if (!extra.ok) {
      return err(mapPortError(extra.error, "observer", "next_event"));
    }
    if (extra.value !== null) {
      return err({
        kind: "divergence",
        phase: "event_unexpected",
        divergenceKind: "event_unexpected",
        expectedEventSeq: null,
        observedEventCount: actualEvents.length + 1,
        expectedDigestSha256: digestCanonical(transcript.events),
        actualDigestSha256: digestCanonical([...actualEvents, extra.value]),
      });
    }

    const observerFinished = await invokePort(
      (context) => ports.observer.finish(context),
      request.portCallTimeoutMs,
      "finish",
    );
    if (!observerFinished.ok) {
      return err(mapPortError(observerFinished.error, "observer", "finish"));
    }
    if (!validateObserverResult(observerFinished.value)) {
      return err({ kind: "invalid_port_result", port: "observer", evidenceDigestSha256: evidenceDigest("observer-finish"), expectedEventSeq: null });
    }
    const actualTranscript: CanonicalProductionTranscript = {
      ...transcript,
      events: actualEvents,
    };
    const expectedRecords = [
      ...loaded.value.expected.outputs,
      ...loaded.value.expected.state,
    ];
    const actualRecords = [
      ...observerFinished.value.outputs,
      ...observerFinished.value.state,
    ];
    const compared = diffProductionReplay({
      expectedTranscript: transcript,
      actualTranscript,
      expectedRecords,
      actualRecords,
    });
    if (!compared.ok) {
      return err({ kind: "invalid_port_result", port: "observer", evidenceDigestSha256: evidenceDigest("observed-record-contract"), expectedEventSeq: null });
    }
    if (!compared.value.matched) {
      return err({
        kind: "divergence",
        phase: "observed_records",
        divergenceKind: compared.value.divergence?.kind ?? null,
        expectedEventSeq: compared.value.divergence?.causalSeq ?? null,
        observedEventCount: actualEvents.length,
        expectedDigestSha256: compared.value.expectedStateDigest,
        actualDigestSha256: compared.value.actualStateDigest,
      });
    }

    const hardOracleAttempt = await invokePort(
      (context) =>
        ports.hardOracle.evaluate(
          {
            actualTranscript,
            outputs: observerFinished.value.outputs,
            state: observerFinished.value.state,
          },
          context,
        ),
      request.portCallTimeoutMs,
      "evaluate",
    );
    if (!hardOracleAttempt.ok) {
      return err(
        mapPortError(hardOracleAttempt.error, "hard_oracle", "evaluate"),
      );
    }
    if (
      !validateHardOracles(
        hardOracleAttempt.value,
        episode.correctness.oracleSetDigestSha256,
        episode.correctness.oracleCount,
      )
    ) {
      return err({ kind: "hard_oracle_invalid", evidenceDigestSha256: evidenceDigest("hard-oracle-result") });
    }
    const failedChecks = hardOracleAttempt.value.checks.filter(
      ({ passed }) => !passed,
    ).length;
    const correctness =
      hardOracleAttempt.value.checks.length > 0 && failedChecks === 0
        ? "passed"
        : "failed";
    return ok({
      engineKind: "generic_contract",
      status: correctness === "passed" ? "accepted" : "correctness_failed",
      fidelity: manifest.fidelity.classification,
      fidelityMatched: true,
      correctness,
      exact: false,
      exactBlockers: ["generic_contract_is_not_operational_attestation"],
      manifestDigestSha256: manifest.seal.manifestDigestSha256,
      expectedTranscriptDigestSha256: compared.value.expectedTranscriptDigest,
      actualTranscriptDigestSha256: compared.value.actualTranscriptDigest,
      expectedStateDigestSha256: expectedFinalStateDigest,
      actualStateDigestSha256: observedRecordsDigest(observerFinished.value.state),
      hardOracleDigestSha256: digestCanonical(hardOracleAttempt.value),
      expectedEventCount: transcript.events.length,
      observedEventCount: actualEvents.length,
      injectedTriggerCount,
      outputCount: observerFinished.value.outputs.length,
      finalStateRecordCount: observerFinished.value.state.length,
      deterministicConsumptionCount: usage.value,
      hardOracleCheckCount: hardOracleAttempt.value.checks.length,
      hardOracleFailedCount: failedChecks,
      artifactCount:
        1 + transcriptResult.value.artifactCount + loaded.value.artifactCount,
      windowStartedAtMs: windowStartMs,
      windowCompletedAtMs,
      durationMs: windowCompletedAtMs - windowStartMs,
    });
  })();

  const cleanupInput: ProductionReplayCleanupInput = {
    outcome: replayResult.ok ? "completed" : "failed",
    primaryErrorDigestSha256: replayResult.ok
      ? null
      : digestCanonical(replayResult.error),
  };
  const cleanupFailures: ProductionReplayCleanupFailure[] = [];
  if (driverStartAttempted) {
    const failure = await stopReplayPort(
      "driver",
      (input, context) => ports.driver.stop(input, context),
      cleanupInput,
      request.portCallTimeoutMs,
    );
    if (failure !== null) cleanupFailures.push(failure);
  }
  if (observerStartAttempted) {
    const failure = await stopReplayPort(
      "observer",
      (input, context) => ports.observer.stop(input, context),
      cleanupInput,
      request.portCallTimeoutMs,
    );
    if (failure !== null) cleanupFailures.push(failure);
  }
  return attachCleanupFailures(replayResult, cleanupFailures);
}
