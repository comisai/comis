// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  ACTIVITY_RECORDING_EXACTNESS_BLOCKERS,
  type ActivityRecordingHeadAuthorityPort,
  type ActivityRecordingInspection,
  type ActivityRecordingTrustedHead,
} from "@comis/core";

import {
  ACTIVITY_RECORDING_ZERO_HASH,
  makeTrustedHead,
  trustedHeadsEqual,
} from "./production-activity-recorder-integrity.js";
import type {
  ActivityRecordingMetaRow,
  ActivityRecordingRecordRow,
} from "./production-activity-recorder-row-schema.js";

interface InspectionState {
  readonly sequence: number;
  readonly headHash: string;
  readonly logicalBytes: number;
  readonly gapCount: number;
}

interface CreateActivityRecordingHeadStateOptions {
  readonly streamId: string;
  readonly instanceId: string;
  readonly authority: ActivityRecordingHeadAuthorityPort | undefined;
  readonly readMeta: () => Result<ActivityRecordingMetaRow, Error>;
  readonly readRecord: (
    sequence: number,
  ) => Result<ActivityRecordingRecordRow | undefined, Error>;
  readonly verifyRow: (row: ActivityRecordingRecordRow) => Result<string, Error>;
  readonly runReadTransaction: (
    operation: () => Result<ActivityRecordingInspection, Error>,
  ) => Result<ActivityRecordingInspection, Error>;
}

export interface ActivityRecordingHeadState {
  synchronize(): Result<void, Error>;
  inspectionForState(input: InspectionState): ActivityRecordingInspection;
  inspect(): Result<ActivityRecordingInspection, Error>;
}

/** Owns external-head synchronization and authenticated inspection projection. */
export function createActivityRecordingHeadState(
  options: CreateActivityRecordingHeadStateOptions,
): ActivityRecordingHeadState {
  function headForMeta(meta: ActivityRecordingMetaRow): ActivityRecordingTrustedHead {
    return makeTrustedHead({
      streamId: options.streamId,
      instanceId: options.instanceId,
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
    if (
      head.streamId !== options.streamId ||
      head.instanceId !== options.instanceId ||
      head.sequence !== head.recordCount
    ) {
      return err(new Error("Trusted activity head stream or instance identity mismatch"));
    }
    if (head.sequence > meta.record_count) {
      return err(new Error("Activity database is behind its trusted monotonic head"));
    }
    if (head.sequence === 0) {
      return head.recordHash === ACTIVITY_RECORDING_ZERO_HASH &&
        head.logicalBytes === 0 && head.gapCount === 0
        ? ok(undefined)
        : err(new Error("Trusted activity genesis head is invalid"));
    }
    const row = options.readRecord(head.sequence);
    if (!row.ok || row.value === undefined) {
      return err(row.ok ? new Error("Trusted head record missing") : row.error);
    }
    const authenticated = options.verifyRow(row.value);
    if (!authenticated.ok) return authenticated;
    return row.value.record_hash === head.recordHash &&
      row.value.state_logical_bytes === head.logicalBytes &&
      row.value.state_record_count === head.recordCount &&
      row.value.state_gap_count === head.gapCount
      ? ok(undefined)
      : err(new Error("Trusted head does not match its authenticated database prefix"));
  }

  function synchronize(): Result<void, Error> {
    if (options.authority === undefined) return ok(undefined);
    for (let attempt = 0; attempt < 4; attempt++) {
      const meta = options.readMeta();
      if (!meta.ok) return meta;
      const read = tryCatch(() => options.authority?.read(options.streamId));
      if (!read.ok) return read;
      if (read.value === undefined) return err(new Error("Trusted activity head authority missing"));
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
      const updated = tryCatch(() => options.authority?.compareAndSet({
        streamId: options.streamId,
        expected: current,
        next,
      }));
      if (!updated.ok) return updated;
      if (updated.value === undefined) return err(new Error("Trusted activity head authority missing"));
      if (!updated.value.ok) return updated.value;
      if (updated.value.value === "updated") return ok(undefined);
    }
    return err(new Error("Trusted activity head compare-and-set did not converge"));
  }

  function inspectionForState(input: InspectionState): ActivityRecordingInspection {
    const expectedHead = makeTrustedHead({
      streamId: options.streamId,
      instanceId: options.instanceId,
      sequence: input.sequence,
      recordHash: input.headHash,
      logicalBytes: input.logicalBytes,
      recordCount: input.sequence,
      gapCount: input.gapCount,
    });
    const checked = options.authority === undefined
      ? ok(false)
      : tryCatch(() => {
          const read = options.authority?.read(options.streamId);
          return read?.ok === true && trustedHeadsEqual(read.value, expectedHead);
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
      return meta.head_hash === ACTIVITY_RECORDING_ZERO_HASH &&
        meta.logical_bytes === 0 && meta.gap_count === 0 && meta.next_sequence === 1
        ? ok(undefined)
        : err(new Error("Activity recording genesis metadata failed validation"));
    }
    const row = options.readRecord(meta.record_count);
    if (!row.ok || row.value === undefined) {
      return err(row.ok ? new Error("Activity recording inspection head is missing") : row.error);
    }
    const authenticated = options.verifyRow(row.value);
    if (!authenticated.ok) return authenticated;
    return row.value.record_hash === meta.head_hash &&
      row.value.state_logical_bytes === meta.logical_bytes &&
      row.value.state_record_count === meta.record_count &&
      row.value.state_gap_count === meta.gap_count &&
      meta.next_sequence === meta.record_count + 1
      ? ok(undefined)
      : err(new Error("Activity recording inspection metadata failed validation"));
  }

  function inspect(): Result<ActivityRecordingInspection, Error> {
    return options.runReadTransaction(() => {
      const meta = options.readMeta();
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
  }

  return Object.freeze({ synchronize, inspectionForState, inspect });
}
