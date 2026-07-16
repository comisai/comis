// SPDX-License-Identifier: Apache-2.0
import type { ActivityRecordingCiphertext } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

import {
  ACTIVITY_RECORDING_ZERO_HASH,
  canonicalRecordIndex,
  ciphertextBytes,
  ciphertextDigest,
  isActivityRecordingCiphertext,
  sha256,
} from "./production-activity-recorder-integrity.js";
import type {
  ActivityRecordingMetaRow,
  ActivityRecordingRecordRow,
} from "./production-activity-recorder-row-schema.js";

export interface ActivityRecordingVerifierDeps {
  readonly streamId: string;
  readonly instanceId: string;
  readonly openProof: (encrypted: ActivityRecordingCiphertext) => Result<Buffer, Error>;
  readonly openPayload: (encrypted: ActivityRecordingCiphertext) => Result<Buffer, Error>;
  readonly readRows: () => Result<ActivityRecordingRecordRow[], Error>;
  readonly readMeta: () => Result<ActivityRecordingMetaRow, Error>;
}

export interface ActivityRecordingVerifier {
  verifyRow(row: ActivityRecordingRecordRow): Result<string, Error>;
  verifyAll(): Result<ActivityRecordingRecordRow[], Error>;
}

/** Authenticate content, index, chain links, and every cumulative state transition. */
export function createActivityRecordingVerifier(
  deps: ActivityRecordingVerifierDeps,
): ActivityRecordingVerifier {
  function verifyRow(row: ActivityRecordingRecordRow): Result<string, Error> {
    const payloadCiphertext: ActivityRecordingCiphertext = {
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      authTag: row.payload_auth_tag,
      salt: row.payload_salt,
    };
    if (!isActivityRecordingCiphertext(payloadCiphertext)
      || ciphertextDigest(payloadCiphertext) !== row.payload_digest
      || ciphertextBytes(payloadCiphertext) !== row.payload_bytes) {
      return err(new Error("Activity recording payload ciphertext digest failed validation"));
    }
    const payload = deps.openPayload(payloadCiphertext);
    if (!payload.ok) {
      return err(new Error("Activity recording payload authentication failed"));
    }
    payload.value.fill(0);
    const index = canonicalRecordIndex({
      streamId: deps.streamId,
      instanceId: deps.instanceId,
      sequence: row.sequence,
      recordId: row.record_id,
      kind: row.kind,
      traceId: row.trace_id,
      parentRecordId: row.parent_record_id,
      attemptId: row.attempt_id,
      capabilityDigest: row.capability_digest,
      writerId: row.writer_id,
      occurredAtMs: row.occurred_at_ms,
      payloadDigest: row.payload_digest,
      payloadBytes: row.payload_bytes,
      previousHash: row.previous_hash,
      stateLogicalBytes: row.state_logical_bytes,
      stateRecordCount: row.state_record_count,
      stateGapCount: row.state_gap_count,
    });
    const computedHash = sha256([Buffer.from(index, "utf8")]);
    if (computedHash !== row.record_hash) {
      return err(new Error("Activity recording index hash failed validation"));
    }
    const proofCiphertext: ActivityRecordingCiphertext = {
      ciphertext: row.proof_ciphertext,
      iv: row.proof_iv,
      authTag: row.proof_auth_tag,
      salt: row.proof_salt,
    };
    if (!isActivityRecordingCiphertext(proofCiphertext)) {
      return err(new Error("Activity recording index proof shape failed validation"));
    }
    const proof = deps.openProof(proofCiphertext);
    if (!proof.ok) return err(new Error("Activity recording index proof failed validation"));
    const proofText = proof.value.toString("utf8");
    proof.value.fill(0);
    if (proofText !== JSON.stringify({ index, recordHash: row.record_hash })) {
      return err(new Error("Activity recording index proof failed validation"));
    }
    const actualLogicalBytes = row.payload_bytes + ciphertextBytes(proofCiphertext)
      + Buffer.byteLength(index, "utf8") + 64;
    return actualLogicalBytes === row.logical_bytes
      ? ok(index)
      : err(new Error("Activity recording logical byte accounting failed validation"));
  }

  function verifyAll(): Result<ActivityRecordingRecordRow[], Error> {
    const read = deps.readRows();
    if (!read.ok) return read;
    let expectedSequence = 1;
    let previousHash = ACTIVITY_RECORDING_ZERO_HASH;
    let logicalBytes = 0;
    let gapCount = 0;
    for (const row of read.value) {
      const authenticated = verifyRow(row);
      if (!authenticated.ok) return authenticated;
      if (row.sequence !== expectedSequence || row.previous_hash !== previousHash) {
        return err(new Error("Activity recording sequence or hash-chain link failed validation"));
      }
      logicalBytes += row.logical_bytes;
      gapCount += row.kind === "gap" ? 1 : 0;
      if (row.state_logical_bytes !== logicalBytes
        || row.state_record_count !== expectedSequence
        || row.state_gap_count !== gapCount) {
        return err(new Error("Activity recording authenticated state transition failed validation"));
      }
      expectedSequence += 1;
      previousHash = row.record_hash;
    }
    const meta = deps.readMeta();
    if (!meta.ok) return meta;
    if (meta.value.next_sequence !== expectedSequence
      || meta.value.head_hash !== previousHash
      || meta.value.record_count !== read.value.length
      || meta.value.logical_bytes !== logicalBytes
      || meta.value.gap_count !== gapCount) {
      return err(new Error("Activity recording metadata does not match authenticated chain state"));
    }
    return read;
  }

  return Object.freeze({ verifyRow, verifyAll });
}
