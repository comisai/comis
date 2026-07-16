// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  ACTIVITY_RECORDING_EXACTNESS_BLOCKERS,
  type ActivityRecordingAttemptReceipt,
  type ActivityRecordingCiphertext,
  type ActivityRecordingCryptoContext,
  type ActivityRecordingCryptoPurpose,
  type ActivityRecordingEvidenceExport,
  type ActivityRecordingFailure,
  type ActivityRecordingGapReason,
  type ActivityRecordingInspection,
  type ActivityRecordingReceipt,
  type ActivityRecordingSourceKind,
  type ActivityRecordingTrustedHead,
  type BeginDeliveryPlatformAttemptInput,
  type FinishDeliveryPlatformAttemptInput,
  type ProductionActivityRecorderPort,
  type RecordInboundChannelActivityInput,
} from "@comis/core";

import { createRowMapper } from "./row-mapper.js";
import { exportActivityEvidence } from "./production-activity-recorder-evidence.js";
import {
  DeliveryAttemptInputSchema,
  DeliveryOutcomeInputSchema,
  InboundActivityInputSchema,
} from "./production-activity-recorder-input-schema.js";
import {
  ACTIVITY_RECORDING_ZERO_HASH,
  canonicalRecordIndex,
  ciphertextBytes,
  ciphertextDigest,
  isActivityRecordingCiphertext,
  makeTrustedHead,
  sha256,
  trustedHeadsEqual,
} from "./production-activity-recorder-integrity.js";
import { serializeActivityPayload } from "./production-activity-recorder-json.js";
import {
  ActivityRecordingMetaRowSchema,
  ActivityRecordingParentStateRowSchema,
  ActivityRecordingRecordRowSchema,
  ActivityRecordingWriterStateRowSchema,
  type ActivityRecordingMetaRow,
  type ActivityRecordingRecordRow,
  type ActivityRecordingWriterStateRow,
} from "./production-activity-recorder-row-schema.js";
import { createActivityRecorderStatements } from "./production-activity-recorder-statements.js";
import {
  type AppendRecordInput,
  type CreateSqliteProductionActivityRecorderOptions,
  type InternalAppendFailure,
  type RuntimeProductionActivityRecorder,
  type SealedRecord,
  DEFAULT_ACTIVITY_RECORDING_WRITER_LEASE_MS,
  databaseFailureReason,
  errorKindFor,
  initSchema,
  recordIdFor,
  validLimits,
} from "./production-activity-recorder-support.js";
import { createActivityRecordingVerifier } from "./production-activity-recorder-verifier.js";

const metaMapper = createRowMapper(ActivityRecordingMetaRowSchema);
const recordMapper = createRowMapper(ActivityRecordingRecordRowSchema);
const parentStateMapper = createRowMapper(ActivityRecordingParentStateRowSchema);
const writerStateMapper = createRowMapper(ActivityRecordingWriterStateRowSchema);

export function createSqliteProductionActivityRecorderOnDatabase(
  options: CreateSqliteProductionActivityRecorderOptions,
): Result<ProductionActivityRecorderPort, Error> {
  const created = tryCatch(() => createSqliteProductionActivityRecorderUnchecked(options));
  return created.ok ? created.value : created;
}

function createSqliteProductionActivityRecorderUnchecked(
  options: CreateSqliteProductionActivityRecorderOptions,
): Result<ProductionActivityRecorderPort, Error> {
  if (!validLimits(options.limits)) return err(new Error("Invalid activity recorder limits"));
  const db = options.db;
  const crypto = options.crypto;
  const limits = options.limits;
  const streamId = options.streamId ?? "injected-activity-recorder";
  const writerId = options.writerId ?? randomUUID();
  const writerLeaseMs = options.writerLeaseMs ?? DEFAULT_ACTIVITY_RECORDING_WRITER_LEASE_MS;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(writerId)
    || !Number.isSafeInteger(writerLeaseMs) || writerLeaseMs <= 0) {
    return err(new Error("Invalid activity recorder writer lease configuration"));
  }
  function readClockMs(): Result<number, Error> {
    const read = tryCatch(options.nowMs);
    if (!read.ok) return read;
    return Number.isSafeInteger(read.value) && read.value >= 0
      ? read
      : err(new Error("Activity recorder clock returned an invalid timestamp"));
  }
  const initialClock = readClockMs();
  if (!initialClock.ok) return initialClock;
  const initialized = tryCatch(() => {
    db.pragma(`busy_timeout = ${limits.busyTimeoutMs ?? 5_000}`);
    initSchema(db, streamId);
  });
  if (!initialized.ok) return initialized;

  const {
    selectMeta,
    selectRecords,
    selectRecordAt,
    selectPage,
    selectUnsettledAttempts,
    selectRecoverableAttempts,
    selectParentState,
    selectWriterState,
    insertRecord,
    updateMeta,
    insertWriter,
    renewWriter,
    closeWriter,
  } = createActivityRecorderStatements(db);
  function digestCapability(value: string): string {
    return sha256([Buffer.from(value, "utf8")]);
  }

  function leaseExpiry(now: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, now + writerLeaseMs);
  }

  function capabilityMatches(value: string, expectedDigest: string): boolean {
    const actual = Buffer.from(digestCapability(value), "hex");
    const expected = Buffer.from(expectedDigest, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function readMeta(): Result<ActivityRecordingMetaRow, Error> {
    const read = tryCatch(() => metaMapper.parseOptionalRow(selectMeta.get()));
    if (!read.ok) return read;
    if (!read.value.ok) return err(new Error(read.value.error.message));
    if (read.value.value === undefined) return err(new Error("Activity recording metadata row missing"));
    if (read.value.value.stream_id !== streamId) return err(new Error("Activity recording stream identity mismatch"));
    return ok(read.value.value);
  }

  const initialMeta = readMeta();
  if (!initialMeta.ok) return initialMeta;
  const instanceId = initialMeta.value.instance_id;

  function readWriterState(id: string): Result<ActivityRecordingWriterStateRow | undefined, Error> {
    const read = tryCatch(() => writerStateMapper.parseOptionalRow(selectWriterState.get(id)));
    if (!read.ok) return read;
    return read.value.ok ? ok(read.value.value) : err(new Error(read.value.error.message));
  }

  function cryptoContext(purpose: ActivityRecordingCryptoPurpose): ActivityRecordingCryptoContext {
    return { streamId, instanceId, purpose };
  }

  function sealBlob(
    purpose: ActivityRecordingCryptoPurpose,
    plaintext: Buffer,
  ): Result<ActivityRecordingCiphertext, Error> {
    const invoked = tryCatch(() => crypto.seal(cryptoContext(purpose), plaintext));
    if (!invoked.ok) return invoked;
    if (!invoked.value.ok) return invoked.value;
    const sealed = invoked.value.value;
    const valid = tryCatch(() => isActivityRecordingCiphertext(sealed));
    return valid.ok && valid.value
      ? ok(sealed)
      : err(new Error("Activity recording crypto returned malformed ciphertext"));
  }

  function openBlob(
    purpose: ActivityRecordingCryptoPurpose,
    encrypted: ActivityRecordingCiphertext,
  ): Result<Buffer, Error> {
    const invoked = tryCatch(() => crypto.open(cryptoContext(purpose), encrypted));
    if (!invoked.ok) return invoked;
    if (!invoked.value.ok) return invoked.value;
    return Buffer.isBuffer(invoked.value.value)
      ? invoked.value
      : err(new Error("Activity recording crypto returned malformed plaintext"));
  }

  function parseRecord(raw: unknown): Result<ActivityRecordingRecordRow | undefined, Error> {
    const parsed = recordMapper.parseOptionalRow(raw);
    if (!parsed.ok) return err(new Error(parsed.error.message));
    return ok(parsed.value);
  }

  const verifier = createActivityRecordingVerifier({
    streamId,
    instanceId,
    openProof: (encrypted) => openBlob("index_proof", encrypted),
    openPayload: (encrypted) => openBlob("payload", encrypted),
    readRows: () => {
      const read = tryCatch(() => recordMapper.parseRows(selectRecords.all()));
      if (!read.ok) return read;
      return read.value.ok ? ok(read.value.value) : err(new Error(read.value.error.message));
    },
    readMeta,
  });
  const verifyRowAuthenticity = verifier.verifyRow;
  const verifyRows = verifier.verifyAll;
  function headForMeta(meta: ActivityRecordingMetaRow): ActivityRecordingTrustedHead {
    return makeTrustedHead({
      streamId,
      instanceId,
      sequence: meta.record_count,
      recordHash: meta.head_hash,
      logicalBytes: meta.logical_bytes,
      recordCount: meta.record_count,
      gapCount: meta.gap_count,
    });
  }

  function validateAuthorityHead(
    head: ActivityRecordingTrustedHead,
    meta: ActivityRecordingMetaRow,
  ): Result<void, Error> {
    if (!trustedHeadsEqual(head, makeTrustedHead({
      streamId: head.streamId,
      instanceId: head.instanceId,
      sequence: head.sequence,
      recordHash: head.recordHash,
      logicalBytes: head.logicalBytes,
      recordCount: head.recordCount,
      gapCount: head.gapCount,
    }))) return err(new Error("Trusted activity head failed state authentication"));
    if (head.streamId !== streamId || head.instanceId !== instanceId || head.sequence !== head.recordCount) {
      return err(new Error("Trusted activity head stream or instance identity mismatch"));
    }
    if (head.sequence > meta.record_count) return err(new Error("Activity database is behind its trusted monotonic head"));
    if (head.sequence === 0) {
      return head.recordHash === ACTIVITY_RECORDING_ZERO_HASH
        && head.logicalBytes === 0 && head.gapCount === 0
        ? ok(undefined)
        : err(new Error("Trusted activity genesis head is invalid"));
    }
    const row = parseRecord(selectRecordAt.get(head.sequence));
    if (!row.ok || row.value === undefined) return err(row.ok ? new Error("Trusted head record missing") : row.error);
    const authenticated = verifyRowAuthenticity(row.value);
    if (!authenticated.ok) return authenticated;
    return row.value.record_hash === head.recordHash
      && row.value.state_logical_bytes === head.logicalBytes
      && row.value.state_record_count === head.recordCount
      && row.value.state_gap_count === head.gapCount
      ? ok(undefined)
      : err(new Error("Trusted head does not match its authenticated database prefix"));
  }

  function synchronizeTrustedHead(): Result<void, Error> {
    const authority = options.headAuthority;
    if (authority === undefined) return ok(undefined);
    for (let attempt = 0; attempt < 4; attempt++) {
      const meta = readMeta();
      if (!meta.ok) return meta;
      const read = tryCatch(() => authority.read(streamId));
      if (!read.ok) return read;
      if (!read.value.ok) return read.value;
      const current = read.value.value;
      if (current !== undefined) {
        const valid = validateAuthorityHead(current, meta.value);
        if (!valid.ok) return valid;
      } else if (meta.value.record_count > 0) {
        return err(new Error("Trusted activity head is missing for a nonempty database"));
      }
      const next = headForMeta(meta.value);
      if (trustedHeadsEqual(current, next)) return ok(undefined);
      const updated = tryCatch(() => authority.compareAndSet({ streamId, expected: current, next }));
      if (!updated.ok) return updated;
      if (!updated.value.ok) return updated.value;
      if (updated.value.value === "updated") return ok(undefined);
    }
    return err(new Error("Trusted activity head compare-and-set did not converge"));
  }

  const verifyTransaction = db.transaction(() => verifyRows());
  const verification = tryCatch(() => verifyTransaction.deferred());
  const verified = verification.ok ? verification.value : verification;
  if (!verified.ok) return verified;
  const anchored = synchronizeTrustedHead();
  if (!anchored.ok) return anchored;
  const registrationClock = readClockMs();
  if (!registrationClock.ok) return registrationClock;
  const registered = tryCatch(() => {
    insertWriter.run(writerId, instanceId, leaseExpiry(registrationClock.value));
  });
  if (!registered.ok) return registered;

  function buildSealedRecord(
    input: AppendRecordInput,
    meta: ActivityRecordingMetaRow,
  ): Result<SealedRecord, InternalAppendFailure> {
    const serialized = serializeActivityPayload(input.payload, limits.maxPayloadBytes);
    if (!serialized.ok) return serialized;
    const payload = sealBlob("payload", Buffer.from(serialized.value, "utf8"));
    if (!payload.ok) return err({ reason: "crypto_failed", cause: payload.error });
    const payloadBytes = ciphertextBytes(payload.value);
    const payloadDigest = ciphertextDigest(payload.value);
    const sequence = meta.next_sequence;
    const recordId = recordIdFor(sequence);
    let logicalBytes = payloadBytes + 256;
    for (let iteration = 0; iteration < 8; iteration++) {
      const stateLogicalBytes = meta.logical_bytes + logicalBytes;
      const stateRecordCount = meta.record_count + 1;
      const stateGapCount = meta.gap_count + (input.kind === "gap" ? 1 : 0);
      const index = canonicalRecordIndex({
        streamId,
        instanceId,
        sequence,
        recordId,
        kind: input.kind,
        traceId: input.traceId,
        parentRecordId: input.parentRecordId,
        attemptId: input.attemptId,
        capabilityDigest: input.capabilityDigest,
        writerId,
        occurredAtMs: input.occurredAtMs,
        payloadDigest,
        payloadBytes,
        previousHash: meta.head_hash,
        stateLogicalBytes,
        stateRecordCount,
        stateGapCount,
      });
      const recordHash = sha256([Buffer.from(index, "utf8")]);
      const proof = sealBlob(
        "index_proof",
        Buffer.from(JSON.stringify({ index, recordHash }), "utf8"),
      );
      if (!proof.ok) return err({ reason: "crypto_failed", cause: proof.error });
      const nextLogicalBytes = payloadBytes + ciphertextBytes(proof.value)
        + Buffer.byteLength(index, "utf8") + 64;
      if (nextLogicalBytes === logicalBytes) {
        return ok({
          payload: payload.value,
          proof: proof.value,
          payloadDigest,
          payloadBytes,
          previousHash: meta.head_hash,
          recordHash,
          index,
          logicalBytes,
          stateLogicalBytes,
          stateRecordCount,
          stateGapCount,
        });
      }
      logicalBytes = nextLogicalBytes;
    }
    return err({
      reason: "storage_failed",
      cause: new Error("Logical byte accounting did not converge"),
    });
  }

  const appendTransaction = db.transaction((input: AppendRecordInput) => {
    let leaseNow: number;
    if (input.recovery !== undefined) {
      leaseNow = input.recovery.asOfMs;
    } else {
      const leaseClock = readClockMs();
      if (!leaseClock.ok) {
        return err<InternalAppendFailure>({
          reason: "clock_unavailable",
          cause: leaseClock.error,
        });
      }
      leaseNow = leaseClock.value;
    }
    const renewed = renewWriter.run(leaseExpiry(leaseNow), writerId, instanceId, leaseNow);
    if (renewed.changes !== 1) {
      return err<InternalAppendFailure>({
        reason: "writer_lease_expired",
        cause: new Error("Activity recorder writer lease expired"),
      });
    }
    const meta = readMeta();
    if (!meta.ok) return err<InternalAppendFailure>({ reason: "storage_failed", cause: meta.error });
    if (meta.value.record_count > 0) {
      const last = parseRecord(selectRecordAt.get(meta.value.record_count));
      if (!last.ok || last.value === undefined) {
        return err<InternalAppendFailure>({
          reason: "integrity_check_failed",
          cause: last.ok ? new Error("Activity head row missing") : last.error,
        });
      }
      const authentic = verifyRowAuthenticity(last.value);
      if (!authentic.ok || last.value.record_hash !== meta.value.head_hash
        || last.value.state_logical_bytes !== meta.value.logical_bytes
        || last.value.state_gap_count !== meta.value.gap_count) {
        return err<InternalAppendFailure>({
          reason: "integrity_check_failed",
          cause: authentic.ok ? new Error("Activity head metadata mismatch") : authentic.error,
        });
      }
    }
    if (input.recovery !== undefined) {
      const parentRead = parentStateMapper.parseOptionalRow(selectParentState.get(input.parentRecordId));
      const writerRead = readWriterState(input.recovery.writerId);
      const parent = parentRead.ok ? parentRead.value : undefined;
      const owner = writerRead.ok ? writerRead.value : undefined;
      if (!parentRead.ok || !writerRead.ok || parent === undefined || owner === undefined
        || input.kind !== "gap" || parent.kind !== "delivery_platform_attempt"
        || parent.record_id !== input.parentRecordId
        || parent.writer_id !== input.recovery.writerId || parent.settlement_count > 0
        || (owner.closed_at_ms === null && owner.lease_expires_at_ms > input.recovery.asOfMs)) {
        return err<InternalAppendFailure>({
          reason: "causal_parent_invalid",
          cause: new Error("Delivery attempt is no longer eligible for lease recovery"),
          recoveryNoLongerEligible: true,
        });
      }
    } else if (input.kind === "delivery_platform_outcome") {
      const settlement = input.settlement;
      if (settlement === undefined) {
        return err<InternalAppendFailure>({
          reason: "causal_parent_invalid",
          cause: new Error("Delivery outcome has no attempt authority"),
        });
      }
      const parentRead = parentStateMapper.parseOptionalRow(selectParentState.get(settlement.recordId));
      if (!parentRead.ok) {
        return err<InternalAppendFailure>({
          reason: "storage_failed",
          cause: new Error(parentRead.error.message),
        });
      }
      const parent = parentRead.value;
      if (parent === undefined || parent.kind !== "delivery_platform_attempt"
        || parent.record_id !== settlement.recordId
        || parent.sequence !== settlement.sequence
        || parent.record_hash !== settlement.recordHash
        || parent.attempt_id !== settlement.attemptId
        || parent.occurred_at_ms !== settlement.occurredAtMs) {
        return err<InternalAppendFailure>({
          reason: "causal_parent_invalid",
          cause: new Error("Delivery outcome attempt authority does not match its parent"),
        });
      }
      if (parent.capability_digest === null
        || !capabilityMatches(settlement.settlementCapability, parent.capability_digest)) {
        return err<InternalAppendFailure>({
          reason: "settlement_capability_invalid",
          cause: new Error("Delivery outcome capability authentication failed"),
        });
      }
      if (parent.trace_id !== settlement.traceId || input.traceId !== parent.trace_id) {
        return err<InternalAppendFailure>({
          reason: "trace_mismatch",
          cause: new Error("Delivery outcome trace does not match its attempt"),
        });
      }
      if (input.occurredAtMs < parent.occurred_at_ms) {
        return err<InternalAppendFailure>({
          reason: "timestamp_order_invalid",
          cause: new Error("Delivery outcome predates its attempt"),
        });
      }
      if (parent.settlement_count > 0) {
        return err<InternalAppendFailure>({
          reason: "attempt_already_settled",
          cause: new Error("Delivery attempt already has an outcome or gap"),
        });
      }
    }
    const primaryLimit = limits.maxRecords - limits.gapReserveRecords;
    const recordLimit = input.useGapReserve ? limits.maxRecords : primaryLimit;
    if (meta.value.record_count >= recordLimit) {
      return err<InternalAppendFailure>({ reason: "record_limit_exceeded", cause: new Error("Record cap reached") });
    }
    const sealed = buildSealedRecord(input, meta.value);
    if (!sealed.ok) return sealed;
    const storedLimit = input.useGapReserve
      ? limits.maxStoredBytes
      : limits.maxStoredBytes - limits.gapReserveBytes;
    if (sealed.value.stateLogicalBytes > storedLimit) {
      return err<InternalAppendFailure>({ reason: "storage_limit_exceeded", cause: new Error("Storage cap reached") });
    }
    const sequence = meta.value.next_sequence;
    const recordId = recordIdFor(sequence);
    insertRecord.run(
      sequence, recordId, input.kind, input.traceId, input.parentRecordId,
      input.attemptId, input.capabilityDigest, writerId, input.occurredAtMs,
      sealed.value.payload.ciphertext, sealed.value.payload.iv,
      sealed.value.payload.authTag, sealed.value.payload.salt,
      sealed.value.payloadDigest, sealed.value.payloadBytes,
      sealed.value.previousHash, sealed.value.recordHash,
      sealed.value.stateLogicalBytes, sealed.value.stateRecordCount,
      sealed.value.stateGapCount, sealed.value.proof.ciphertext,
      sealed.value.proof.iv, sealed.value.proof.authTag, sealed.value.proof.salt,
      sealed.value.logicalBytes,
    );
    updateMeta.run(
      sequence + 1,
      sealed.value.recordHash,
      sealed.value.stateLogicalBytes,
      sealed.value.stateRecordCount,
      sealed.value.stateGapCount,
    );
    return ok<ActivityRecordingReceipt>({ recordId, sequence, recordHash: sealed.value.recordHash });
  });

  function appendRecord(input: AppendRecordInput): Result<ActivityRecordingReceipt, InternalAppendFailure> {
    const committed = tryCatch(() => appendTransaction.immediate(input));
    if (!committed.ok) {
      return err({ reason: databaseFailureReason(committed.error), cause: committed.error });
    }
    if (!committed.value.ok) return committed.value;
    const synchronized = synchronizeTrustedHead();
    if (synchronized.ok) {
      return committed.value;
    }
    return err({
      reason: synchronized.error.message.includes("compare-and-set")
        ? "head_anchor_conflict"
        : "head_anchor_unavailable",
      cause: synchronized.error,
      persistedReceipt: committed.value.value,
    });
  }

  function currentGapCount(): number {
    const meta = readMeta();
    return meta.ok ? meta.value.gap_count : 0;
  }

  function rejectWithoutGap(input: {
    readonly sourceKind: ActivityRecordingSourceKind;
    readonly reason: ActivityRecordingGapReason;
    readonly occurredAtMs: number;
    readonly cause: Error;
  }): ActivityRecordingFailure {
    return {
      ...input,
      gapDurablyAccounted: false,
      gapCount: currentGapCount(),
      errorKind: errorKindFor(input.reason),
    };
  }

  function accountLoss(input: {
    readonly sourceKind: ActivityRecordingSourceKind;
    readonly reason: ActivityRecordingGapReason;
    readonly cause: Error;
    readonly traceId: string | null;
    readonly parentRecordId: string | null;
    readonly occurredAtMs: number;
  }): ActivityRecordingFailure {
    const gap = appendRecord({
      kind: "gap",
      traceId: input.traceId,
      parentRecordId: input.parentRecordId,
      attemptId: null,
      capabilityDigest: null,
      occurredAtMs: input.occurredAtMs,
      payload: { reason: input.reason, sourceKind: input.sourceKind },
      useGapReserve: true,
    });
    return {
      reason: input.reason,
      sourceKind: input.sourceKind,
      gapDurablyAccounted: gap.ok,
      gapCount: currentGapCount(),
      occurredAtMs: input.occurredAtMs,
      errorKind: errorKindFor(input.reason),
      cause: input.cause,
    };
  }

  function isSettlementRejection(reason: ActivityRecordingGapReason): boolean {
    return reason === "causal_parent_invalid"
      || reason === "attempt_already_settled"
      || reason === "settlement_capability_invalid"
      || reason === "trace_mismatch"
      || reason === "timestamp_order_invalid"
      || reason === "outcome_shape_invalid";
  }

  function appendOrAccount(
    sourceKind: ActivityRecordingSourceKind,
    input: AppendRecordInput,
  ): Result<ActivityRecordingReceipt, ActivityRecordingFailure> {
    const appended = appendRecord(input);
    if (appended.ok) return appended;
    if (appended.error.persistedReceipt !== undefined
      || appended.error.reason === "head_anchor_conflict"
      || appended.error.reason === "head_anchor_unavailable"
      || isSettlementRejection(appended.error.reason)) {
      return err({
        reason: appended.error.reason,
        sourceKind,
        gapDurablyAccounted: false,
        gapCount: currentGapCount(),
        occurredAtMs: input.occurredAtMs,
        errorKind: errorKindFor(appended.error.reason),
        cause: appended.error.cause,
      });
    }
    return err(accountLoss({
      sourceKind,
      reason: appended.error.reason,
      cause: appended.error.cause,
      traceId: input.traceId,
      parentRecordId: input.parentRecordId,
      occurredAtMs: input.occurredAtMs,
    }));
  }

  function renewCurrentWriterLease(): Result<void, Error> {
    const clock = readClockMs();
    if (!clock.ok) return clock;
    const now = clock.value;
    const renewed = tryCatch(() => renewWriter.run(
      leaseExpiry(now), writerId, instanceId, now,
    ));
    if (!renewed.ok) return renewed;
    return renewed.value.changes === 1
      ? ok(undefined)
      : err(new Error("Activity recorder writer lease expired"));
  }

  function recoverAbandonedAttempts(asOfOverride?: number): Result<void, Error> {
    const clock = asOfOverride === undefined ? readClockMs() : ok(asOfOverride);
    if (!clock.ok) return clock;
    const asOfMs = clock.value;
    const read = tryCatch(() => recordMapper.parseRows(selectRecoverableAttempts.all(asOfMs)));
    if (!read.ok) return read;
    if (!read.value.ok) return err(new Error(read.value.error.message));
    for (const attempt of read.value.value) {
      const recovered = appendRecord({
        kind: "gap",
        traceId: attempt.trace_id,
        parentRecordId: attempt.record_id,
        attemptId: null,
        capabilityDigest: null,
        occurredAtMs: Math.max(asOfMs, attempt.occurred_at_ms),
        payload: {
          reason: "unknown_after_restart",
          sourceKind: "delivery_platform_attempt",
        },
        useGapReserve: true,
        recovery: { writerId: attempt.writer_id, asOfMs },
      });
      if (!recovered.ok && recovered.error.recoveryNoLongerEligible !== true) {
        return err(recovered.error.cause);
      }
    }
    return ok(undefined);
  }

  const recovered = recoverAbandonedAttempts(registrationClock.value);
  if (!recovered.ok) return recovered;

  let closed = false;

  function closedFailure(
    sourceKind: ActivityRecordingSourceKind,
    occurredAtMs: number,
  ): ActivityRecordingFailure {
    return rejectWithoutGap({
      sourceKind,
      reason: "recorder_closed",
      occurredAtMs,
      cause: new Error("Production activity recorder is closed"),
    });
  }

  function accountUnsettledAtShutdown(): Result<void, Error> {
    const clock = readClockMs();
    if (!clock.ok) return clock;
    const read = tryCatch(() => recordMapper.parseRows(selectUnsettledAttempts.all(writerId)));
    if (!read.ok) return read;
    if (!read.value.ok) return err(new Error(read.value.error.message));
    for (const attempt of read.value.value) {
      const failure = accountLoss({
        sourceKind: "delivery_platform_attempt",
        reason: "unknown_at_shutdown",
        cause: new Error("Delivery attempt remained unsettled at recorder shutdown"),
        traceId: attempt.trace_id,
        parentRecordId: attempt.record_id,
        occurredAtMs: Math.max(clock.value, attempt.occurred_at_ms),
      });
      if (!failure.gapDurablyAccounted) return err(failure.cause);
    }
    return ok(undefined);
  }

  function markWriterClosed(): Result<void, Error> {
    const clock = readClockMs();
    if (!clock.ok) return clock;
    const now = clock.value;
    const marked = tryCatch(() => closeWriter.run(now, now, writerId, instanceId));
    if (!marked.ok) return marked;
    return marked.value.changes === 1
      ? ok(undefined)
      : err(new Error("Activity recorder writer lease could not be closed"));
  }

  function inspectionForState(input: {
    readonly sequence: number;
    readonly headHash: string;
    readonly logicalBytes: number;
    readonly gapCount: number;
  }): ActivityRecordingInspection {
    const expectedHead = makeTrustedHead({
      streamId,
      instanceId,
      sequence: input.sequence,
      recordHash: input.headHash,
      logicalBytes: input.logicalBytes,
      recordCount: input.sequence,
      gapCount: input.gapCount,
    });
    const authority = options.headAuthority;
    const checked = authority === undefined
      ? ok(false)
      : tryCatch(() => {
          const read = authority.read(streamId);
          return read.ok && trustedHeadsEqual(read.value, expectedHead);
        });
    const trustedHeadAnchor = checked.ok && checked.value;
    const blockers = !trustedHeadAnchor
      ? ACTIVITY_RECORDING_EXACTNESS_BLOCKERS
      : ACTIVITY_RECORDING_EXACTNESS_BLOCKERS.filter(
          (blocker) => blocker !== "trusted_external_head_anchor_missing",
        );
    return {
      headSequence: input.sequence,
      headHash: input.headHash,
      recordCount: input.sequence,
      logicalBytes: input.logicalBytes,
      gapCount: input.gapCount,
      trustedHeadAnchor,
      exactness: { eligible: false, blockers },
    };
  }

  function authenticateMetaState(meta: ActivityRecordingMetaRow): Result<void, Error> {
    if (meta.record_count === 0) {
      return meta.head_hash === ACTIVITY_RECORDING_ZERO_HASH
        && meta.logical_bytes === 0 && meta.gap_count === 0 && meta.next_sequence === 1
        ? ok(undefined)
        : err(new Error("Activity recording genesis metadata failed validation"));
    }
    const row = parseRecord(selectRecordAt.get(meta.record_count));
    if (!row.ok || row.value === undefined) {
      return err(row.ok ? new Error("Activity recording inspection head is missing") : row.error);
    }
    const authenticated = verifyRowAuthenticity(row.value);
    if (!authenticated.ok) return authenticated;
    return row.value.record_hash === meta.head_hash
      && row.value.state_logical_bytes === meta.logical_bytes
      && row.value.state_record_count === meta.record_count
      && row.value.state_gap_count === meta.gap_count
      && meta.next_sequence === meta.record_count + 1
      ? ok(undefined)
      : err(new Error("Activity recording inspection metadata failed validation"));
  }

  function inspectState(): Result<ActivityRecordingInspection, Error> {
    const inspectTransaction = db.transaction(() => {
      const meta = readMeta();
      if (!meta.ok) return meta;
      const authenticated = authenticateMetaState(meta.value);
      if (!authenticated.ok) return authenticated;
      return ok(inspectionForState({
        sequence: meta.value.record_count,
        headHash: meta.value.head_hash,
        logicalBytes: meta.value.logical_bytes,
        gapCount: meta.value.gap_count,
      }));
    });
    const inspected = tryCatch(() => inspectTransaction.deferred());
    return inspected.ok ? inspected.value : inspected;
  }

  const recorder: RuntimeProductionActivityRecorder = {
    recordInboundChannelActivity(input: RecordInboundChannelActivityInput) {
      if (closed) return Promise.resolve(err(closedFailure(
        "channel_inbound_normalized", input.occurredAtMs,
      )));
      const parsed = tryCatch(() => InboundActivityInputSchema.safeParse(input));
      if (!parsed.ok || !parsed.value.success) {
        const clock = readClockMs();
        if (!clock.ok) {
          return Promise.resolve(err(rejectWithoutGap({
            sourceKind: "channel_inbound_normalized",
            reason: "clock_unavailable",
            occurredAtMs: 0,
            cause: clock.error,
          })));
        }
        return Promise.resolve(err(accountLoss({
          sourceKind: "channel_inbound_normalized",
          reason: "payload_invalid",
          cause: parsed.ok ? new Error("Normalized channel input failed validation") : parsed.error,
          traceId: null,
          parentRecordId: null,
          occurredAtMs: clock.value,
        })));
      }
      return Promise.resolve(appendOrAccount("channel_inbound_normalized", {
        kind: "channel_inbound_normalized",
        traceId: parsed.value.data.traceId,
        parentRecordId: null,
        attemptId: null,
        capabilityDigest: null,
        occurredAtMs: parsed.value.data.occurredAtMs,
        payload: { message: parsed.value.data.message },
        useGapReserve: false,
      }));
    },

    beginDeliveryPlatformAttempt(input: BeginDeliveryPlatformAttemptInput) {
      if (closed) return Promise.resolve(err(closedFailure(
        "delivery_platform_attempt", input.occurredAtMs,
      )));
      const parsed = tryCatch(() => DeliveryAttemptInputSchema.safeParse(input));
      if (!parsed.ok || !parsed.value.success) {
        const clock = readClockMs();
        if (!clock.ok) {
          return Promise.resolve(err(rejectWithoutGap({
            sourceKind: "delivery_platform_attempt",
            reason: "clock_unavailable",
            occurredAtMs: 0,
            cause: clock.error,
          })));
        }
        return Promise.resolve(err(accountLoss({
          sourceKind: "delivery_platform_attempt",
          reason: "payload_invalid",
          cause: new Error("Delivery attempt failed bounded-field validation"),
          traceId: null,
          parentRecordId: null,
          occurredAtMs: clock.value,
        })));
      }
      const bounded = parsed.value.data;
      if (Buffer.byteLength(bounded.text, "utf8") > limits.maxPayloadBytes) {
        return Promise.resolve(err(accountLoss({
          sourceKind: "delivery_platform_attempt",
          reason: "payload_too_large",
          cause: new Error("Delivery attempt text exceeds configured byte cap"),
          traceId: bounded.traceId,
          parentRecordId: null,
          occurredAtMs: bounded.occurredAtMs,
        })));
      }
      const attemptId = randomUUID();
      const settlementCapability = randomBytes(32).toString("base64url");
      const appended = appendOrAccount("delivery_platform_attempt", {
        kind: "delivery_platform_attempt",
        traceId: bounded.traceId,
        parentRecordId: null,
        attemptId,
        capabilityDigest: digestCapability(settlementCapability),
        occurredAtMs: bounded.occurredAtMs,
        payload: bounded,
        useGapReserve: false,
      });
      return Promise.resolve(appended.ok
        ? ok<ActivityRecordingAttemptReceipt>({
            ...appended.value,
            attemptId,
            settlementCapability,
            traceId: bounded.traceId,
            occurredAtMs: bounded.occurredAtMs,
          })
        : appended);
    },

    finishDeliveryPlatformAttempt(input: FinishDeliveryPlatformAttemptInput) {
      if (closed) return Promise.resolve(err(closedFailure(
        "delivery_platform_outcome", input.occurredAtMs,
      )));
      const parsed = tryCatch(() => DeliveryOutcomeInputSchema.safeParse(input));
      if (!parsed.ok || !parsed.value.success) {
        const clock = readClockMs();
        if (!clock.ok) {
          return Promise.resolve(err(rejectWithoutGap({
            sourceKind: "delivery_platform_outcome",
            reason: "clock_unavailable",
            occurredAtMs: 0,
            cause: clock.error,
          })));
        }
        const rawOutcomeClass = typeof input === "object" && input !== null
          ? (input as { readonly outcomeClass?: unknown }).outcomeClass
          : undefined;
        const reason = rawOutcomeClass === "success"
          || rawOutcomeClass === "platform_error"
          || rawOutcomeClass === "adapter_throw"
          ? "outcome_shape_invalid" as const
          : "payload_invalid" as const;
        return Promise.resolve(err(rejectWithoutGap({
          sourceKind: "delivery_platform_outcome",
          reason,
          cause: new Error("Delivery outcome failed bounded-field validation"),
          occurredAtMs: clock.value,
        })));
      }
      const bounded = parsed.value.data;
      const durationMs = bounded.occurredAtMs - bounded.attempt.occurredAtMs;
      const payload = {
        attemptRecordId: bounded.attempt.recordId,
        traceId: bounded.attempt.traceId,
        occurredAtMs: bounded.occurredAtMs,
        durationMs,
        outcomeClass: bounded.outcomeClass,
        ...(bounded.outcomeClass === "success"
          ? { platformMessageId: bounded.platformMessageId }
          : { error: bounded.error }),
      };
      return Promise.resolve(appendOrAccount("delivery_platform_outcome", {
        kind: "delivery_platform_outcome",
        traceId: bounded.attempt.traceId,
        parentRecordId: bounded.attempt.recordId,
        attemptId: null,
        capabilityDigest: null,
        occurredAtMs: bounded.occurredAtMs,
        payload,
        useGapReserve: false,
        settlement: bounded.attempt,
      }));
    },

    exportEvidence(input): Promise<Result<ActivityRecordingEvidenceExport, Error>> {
      if (closed) return Promise.resolve(err(new Error("Production activity recorder is closed")));
      return Promise.resolve(exportActivityEvidence({
        maxPayloadBytes: limits.maxPayloadBytes,
        readMeta,
        readRecord: (sequence) => parseRecord(selectRecordAt.get(sequence)),
        readPage: (after, snapshot, limit) => {
          const read = tryCatch(() => recordMapper.parseRows(selectPage.all(after, snapshot, limit)));
          if (!read.ok) return read;
          return read.value.ok ? ok(read.value.value) : err(new Error(read.value.error.message));
        },
        verifyRow: verifyRowAuthenticity,
        openPayload: (encrypted) => openBlob("payload", encrypted),
        inspectionForState,
      }, input));
    },
    inspect(): Promise<Result<ActivityRecordingInspection, Error>> {
      if (closed) return Promise.resolve(err(new Error("Production activity recorder is closed")));
      return Promise.resolve(inspectState());
    },

    heartbeat(): Promise<Result<void, Error>> {
      if (closed) return Promise.resolve(err(new Error("Production activity recorder is closed")));
      const renewed = renewCurrentWriterLease();
      if (!renewed.ok) return Promise.resolve(renewed);
      return Promise.resolve(recoverAbandonedAttempts());
    },

    close(): Promise<Result<void, Error>> {
      if (closed) return Promise.resolve(ok(undefined));
      const accounted = accountUnsettledAtShutdown();
      if (!accounted.ok) return Promise.resolve(accounted);
      const writerClosed = markWriterClosed();
      if (!writerClosed.ok) return Promise.resolve(writerClosed);
      if (!options.closeDatabase) {
        closed = true;
        return Promise.resolve(ok(undefined));
      }
      const result = tryCatch(() => {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.pragma("optimize");
        db.close();
      });
      if (result.ok) closed = true;
      return Promise.resolve(result);
    },
  };

  return ok(Object.freeze(recorder));
}
