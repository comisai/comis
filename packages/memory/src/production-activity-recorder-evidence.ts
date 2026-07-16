// SPDX-License-Identifier: Apache-2.0
import type {
  ActivityRecordingCiphertext,
  ActivityRecordingEvidenceExport,
  ActivityRecordingEvidenceExportInput,
  ActivityRecordingInspection,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

import { EvidenceExportInputSchema } from "./production-activity-recorder-input-schema.js";
import { ACTIVITY_RECORDING_ZERO_HASH } from "./production-activity-recorder-integrity.js";
import { validateActivityJsonGraph } from "./production-activity-recorder-json.js";
import type {
  ActivityRecordingMetaRow,
  ActivityRecordingRecordRow,
} from "./production-activity-recorder-row-schema.js";

export interface ActivityEvidenceExportDeps {
  readonly maxPayloadBytes: number;
  readonly readMeta: () => Result<ActivityRecordingMetaRow, Error>;
  readonly readRecord: (sequence: number) => Result<ActivityRecordingRecordRow | undefined, Error>;
  readonly readPage: (
    afterSequence: number,
    snapshotHeadSequence: number,
    limit: number,
  ) => Result<ActivityRecordingRecordRow[], Error>;
  readonly verifyRow: (row: ActivityRecordingRecordRow) => Result<string, Error>;
  readonly openPayload: (encrypted: ActivityRecordingCiphertext) => Result<Buffer, Error>;
  readonly inspectionForState: (input: {
    readonly sequence: number;
    readonly headHash: string;
    readonly logicalBytes: number;
    readonly gapCount: number;
  }) => ActivityRecordingInspection;
}

function authenticateSnapshotHead(
  deps: ActivityEvidenceExportDeps,
  snapshotHead: number,
): Result<{
  readonly sequence: number;
  readonly headHash: string;
  readonly logicalBytes: number;
  readonly gapCount: number;
}, Error> {
  if (snapshotHead === 0) {
    return ok({
      sequence: 0,
      headHash: ACTIVITY_RECORDING_ZERO_HASH,
      logicalBytes: 0,
      gapCount: 0,
    });
  }
  const row = deps.readRecord(snapshotHead);
  if (!row.ok || row.value === undefined) {
    return err(row.ok ? new Error("Evidence snapshot head missing") : row.error);
  }
  const authenticated = deps.verifyRow(row.value);
  if (!authenticated.ok) return authenticated;
  return ok({
    sequence: snapshotHead,
    headHash: row.value.record_hash,
    logicalBytes: row.value.state_logical_bytes,
    gapCount: row.value.state_gap_count,
  });
}

/** Authenticate and decrypt at most one requested evidence page plus its boundaries. */
export function exportActivityEvidence(
  deps: ActivityEvidenceExportDeps,
  input: ActivityRecordingEvidenceExportInput,
): Result<ActivityRecordingEvidenceExport, Error> {
  const parsed = tryCatch(() => EvidenceExportInputSchema.safeParse(input));
  if (!parsed.ok) return parsed;
  if (!parsed.value.success) return err(new Error("Invalid activity evidence export bounds"));
  const exportInput = parsed.value.data;
  const meta = deps.readMeta();
  if (!meta.ok) return meta;
  const snapshotHead = exportInput.snapshotHeadSequence ?? meta.value.record_count;
  const after = exportInput.afterSequence ?? 0;
  if (snapshotHead > meta.value.record_count || after > snapshotHead) {
    return err(new Error("Invalid activity evidence snapshot cursor"));
  }

  let previousHash = ACTIVITY_RECORDING_ZERO_HASH;
  let previousLogicalBytes = 0;
  let previousGapCount = 0;
  if (after > 0) {
    const boundary = deps.readRecord(after);
    if (!boundary.ok || boundary.value === undefined) {
      return err(boundary.ok ? new Error("Evidence cursor boundary missing") : boundary.error);
    }
    const authenticated = deps.verifyRow(boundary.value);
    if (!authenticated.ok) return authenticated;
    previousHash = boundary.value.record_hash;
    previousLogicalBytes = boundary.value.state_logical_bytes;
    previousGapCount = boundary.value.state_gap_count;
  }

  const pageRead = deps.readPage(after, snapshotHead, exportInput.limit + 1);
  if (!pageRead.ok) return pageRead;
  const hasMore = pageRead.value.length > exportInput.limit;
  const pageRows = pageRead.value.slice(0, exportInput.limit);
  const records: ActivityRecordingEvidenceExport["records"][number][] = [];
  let expectedSequence = after + 1;
  for (const row of pageRows) {
    const authenticated = deps.verifyRow(row);
    if (!authenticated.ok) return authenticated;
    const expectedGapCount = previousGapCount + (row.kind === "gap" ? 1 : 0);
    if (row.sequence !== expectedSequence || row.previous_hash !== previousHash
      || row.state_logical_bytes !== previousLogicalBytes + row.logical_bytes
      || row.state_gap_count !== expectedGapCount) {
      return err(new Error("Evidence page chain validation failed"));
    }
    const opened = deps.openPayload({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      authTag: row.payload_auth_tag,
      salt: row.payload_salt,
    });
    if (!opened.ok) return err(new Error("Activity evidence payload authentication failed"));
    const decoded = tryCatch(() => JSON.parse(opened.value.toString("utf8")) as unknown);
    opened.value.fill(0);
    if (!decoded.ok) return err(new Error("Activity evidence payload JSON failed validation"));
    const bounded = validateActivityJsonGraph(decoded.value, deps.maxPayloadBytes);
    if (!bounded.ok) return err(bounded.error.cause);
    records.push({
      sequence: row.sequence,
      recordId: row.record_id,
      kind: row.kind,
      traceId: row.trace_id,
      parentRecordId: row.parent_record_id,
      occurredAtMs: row.occurred_at_ms,
      payloadBytes: row.payload_bytes,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
      payload: decoded.value,
    });
    expectedSequence += 1;
    previousHash = row.record_hash;
    previousLogicalBytes = row.state_logical_bytes;
    previousGapCount = row.state_gap_count;
  }

  const snapshotState = authenticateSnapshotHead(deps, snapshotHead);
  if (!snapshotState.ok) return snapshotState;
  const lastSequence = pageRows.at(-1)?.sequence;
  return ok({
    records,
    ...(hasMore && lastSequence !== undefined ? { nextAfterSequence: lastSequence } : {}),
    totalRecordCount: snapshotHead,
    snapshotHeadSequence: snapshotHead,
    inspection: deps.inspectionForState(snapshotState.value),
  });
}
