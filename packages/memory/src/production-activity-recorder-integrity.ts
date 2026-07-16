// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import type {
  ActivityRecordingCiphertext,
  ActivityRecordingRecordKind,
  ActivityRecordingTrustedHead,
} from "@comis/core";

export const ACTIVITY_RECORDING_ZERO_HASH = "0".repeat(64);
export const ACTIVITY_RECORDING_IV_BYTES = 12;
export const ACTIVITY_RECORDING_AUTH_TAG_BYTES = 16;
export const ACTIVITY_RECORDING_SALT_BYTES = 32;
const ACTIVITY_RECORDING_CIPHERTEXT_DIGEST_DOMAIN = Buffer.from(
  "comis-activity-recording-ciphertext-v2\0",
  "utf8",
);

export interface AuthenticatedRecordIndexInput {
  readonly streamId: string;
  readonly instanceId: string;
  readonly sequence: number;
  readonly recordId: string;
  readonly kind: ActivityRecordingRecordKind;
  readonly traceId: string | null;
  readonly parentRecordId: string | null;
  readonly attemptId: string | null;
  readonly capabilityDigest: string | null;
  readonly writerId: string;
  readonly occurredAtMs: number;
  readonly payloadDigest: string;
  readonly payloadBytes: number;
  readonly previousHash: string;
  readonly stateLogicalBytes: number;
  readonly stateRecordCount: number;
  readonly stateGapCount: number;
}

export function sha256(parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function framedPart(value: Buffer): readonly [Buffer, Buffer] {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  return [length, value];
}

/** Require the fixed AES-GCM component sizes used by the recorder crypto port. */
export function isActivityRecordingCiphertext(
  value: unknown,
): value is ActivityRecordingCiphertext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActivityRecordingCiphertext>;
  return Buffer.isBuffer(candidate.ciphertext)
    && Buffer.isBuffer(candidate.iv) && candidate.iv.length === ACTIVITY_RECORDING_IV_BYTES
    && Buffer.isBuffer(candidate.authTag)
    && candidate.authTag.length === ACTIVITY_RECORDING_AUTH_TAG_BYTES
    && Buffer.isBuffer(candidate.salt) && candidate.salt.length === ACTIVITY_RECORDING_SALT_BYTES;
}

export function ciphertextDigest(value: ActivityRecordingCiphertext): string {
  return sha256([
    ACTIVITY_RECORDING_CIPHERTEXT_DIGEST_DOMAIN,
    ...framedPart(value.ciphertext),
    ...framedPart(value.iv),
    ...framedPart(value.authTag),
    ...framedPart(value.salt),
  ]);
}

export function ciphertextBytes(value: ActivityRecordingCiphertext): number {
  return value.ciphertext.length + value.iv.length + value.authTag.length + value.salt.length;
}

export function canonicalRecordIndex(input: AuthenticatedRecordIndexInput): string {
  return JSON.stringify({
    schema: "comis-activity-recording-index",
    schemaVersion: 3,
    streamId: input.streamId,
    instanceId: input.instanceId,
    sequence: input.sequence,
    recordId: input.recordId,
    kind: input.kind,
    traceId: input.traceId,
    parentRecordId: input.parentRecordId,
    attemptId: input.attemptId,
    capabilityDigest: input.capabilityDigest,
    writerId: input.writerId,
    occurredAtMs: input.occurredAtMs,
    payloadDigest: input.payloadDigest,
    payloadBytes: input.payloadBytes,
    previousHash: input.previousHash,
    state: {
      logicalBytes: input.stateLogicalBytes,
      recordCount: input.stateRecordCount,
      gapCount: input.stateGapCount,
    },
  });
}

export function trustedHeadStateHash(input: Omit<ActivityRecordingTrustedHead, "stateHash">): string {
  return sha256([Buffer.from(JSON.stringify({
    schema: "comis-activity-recording-head",
    schemaVersion: 1,
    streamId: input.streamId,
    instanceId: input.instanceId,
    sequence: input.sequence,
    recordHash: input.recordHash,
    logicalBytes: input.logicalBytes,
    recordCount: input.recordCount,
    gapCount: input.gapCount,
  }), "utf8")]);
}

export function makeTrustedHead(input: Omit<ActivityRecordingTrustedHead, "stateHash">): ActivityRecordingTrustedHead {
  return { ...input, stateHash: trustedHeadStateHash(input) };
}

export function trustedHeadsEqual(
  left: ActivityRecordingTrustedHead | undefined,
  right: ActivityRecordingTrustedHead | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.streamId === right.streamId
    && left.instanceId === right.instanceId
    && left.sequence === right.sequence
    && left.recordHash === right.recordHash
    && left.stateHash === right.stateHash
    && left.logicalBytes === right.logicalBytes
    && left.recordCount === right.recordCount
    && left.gapCount === right.gapCount;
}
