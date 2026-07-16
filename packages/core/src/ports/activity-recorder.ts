// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

import type { NormalizedMessage } from "../domain/normalized-message.js";
import type {
  ActivityRecordingExactnessBlocker,
  ActivityRecordingGapReason,
  ActivityRecordingOutcomeClass,
  ActivityRecordingRecordKind,
  ActivityRecordingSourceKind,
} from "../domain/activity-recording.js";
import type { SendMessageOptions } from "./channel.js";
import type { ErrorKind } from "../logging/log-fields.js";

/** Purpose verified inside every authenticated-encryption plaintext envelope. */
export type ActivityRecordingCryptoPurpose = "payload" | "index_proof";

/** Storage-neutral authenticated ciphertext. */
export interface ActivityRecordingCiphertext {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly salt: Buffer;
}

export interface ActivityRecordingCryptoContext {
  readonly streamId: string;
  readonly instanceId: string;
  readonly purpose: ActivityRecordingCryptoPurpose;
}

/** Injected key authority; implementations must authenticate the embedded purpose. */
export interface ActivityRecordingCryptoPort {
  seal(
    context: ActivityRecordingCryptoContext,
    plaintext: Buffer,
  ): Result<ActivityRecordingCiphertext, Error>;
  open(
    context: ActivityRecordingCryptoContext,
    encrypted: ActivityRecordingCiphertext,
  ): Result<Buffer, Error>;
}

/** Head state authenticated by an authority outside the mutable recorder DB. */
export interface ActivityRecordingTrustedHead {
  readonly streamId: string;
  readonly instanceId: string;
  readonly sequence: number;
  readonly recordHash: string;
  readonly stateHash: string;
  readonly logicalBytes: number;
  readonly recordCount: number;
  readonly gapCount: number;
}

/**
 * Implementations authenticate values and enforce monotonic compare-and-set
 * outside the recorder database. A local mutable sidecar does not satisfy this
 * contract.
 */
export interface ActivityRecordingHeadAuthorityPort {
  read(streamId: string): Result<ActivityRecordingTrustedHead | undefined, Error>;
  compareAndSet(input: {
    readonly streamId: string;
    readonly expected: ActivityRecordingTrustedHead | undefined;
    readonly next: ActivityRecordingTrustedHead;
  }): Result<"updated" | "conflict", Error>;
}

export interface ActivityRecordingReceipt {
  readonly recordId: string;
  readonly sequence: number;
  readonly recordHash: string;
}

/** Opaque authority returned only to the code that initiated a platform send. */
export interface ActivityRecordingAttemptReceipt extends ActivityRecordingReceipt {
  readonly attemptId: string;
  readonly settlementCapability: string;
  readonly traceId: string;
  readonly occurredAtMs: number;
}

/** Typed failure whose public fields are safe for content-free health reporting. */
export interface ActivityRecordingFailure {
  readonly reason: ActivityRecordingGapReason;
  readonly sourceKind: ActivityRecordingSourceKind;
  readonly gapDurablyAccounted: boolean;
  readonly gapCount: number;
  readonly occurredAtMs: number;
  readonly errorKind: ErrorKind;
  /** Boundary-only cause. Callers must not put its text in logs or events. */
  readonly cause: Error;
}

export interface ActivityRecordingEvidenceExportInput {
  readonly afterSequence?: number;
  readonly snapshotHeadSequence?: number;
  readonly limit: number;
}

/** Authenticated index plus its purpose-verified decrypted JSON payload. */
export interface ActivityRecordingEvidenceRecord {
  readonly sequence: number;
  readonly recordId: string;
  readonly kind: ActivityRecordingRecordKind;
  readonly traceId: string | null;
  readonly parentRecordId: string | null;
  readonly occurredAtMs: number;
  readonly payloadBytes: number;
  readonly previousHash: string;
  readonly recordHash: string;
  readonly payload: unknown;
}

export interface ActivityRecordingEvidenceExport {
  readonly records: readonly ActivityRecordingEvidenceRecord[];
  readonly nextAfterSequence?: number;
  readonly totalRecordCount: number;
  readonly snapshotHeadSequence: number;
  readonly inspection: ActivityRecordingInspection;
}

export interface RecordInboundChannelActivityInput {
  readonly traceId: string;
  readonly occurredAtMs: number;
  readonly message: NormalizedMessage;
}

export interface BeginDeliveryPlatformAttemptInput {
  readonly traceId: string;
  readonly occurredAtMs: number;
  readonly channelType: string;
  readonly channelId: string;
  readonly text: string;
  readonly options: SendMessageOptions;
  readonly origin: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
}

interface FinishDeliveryPlatformAttemptBase {
  readonly attempt: ActivityRecordingAttemptReceipt;
  readonly occurredAtMs: number;
}

interface ActivityRecordingErrorProjection {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type FinishDeliveryPlatformAttemptInput = FinishDeliveryPlatformAttemptBase & (
  | {
      readonly outcomeClass: "success";
      readonly platformMessageId: string;
      readonly error?: never;
    }
  | {
      readonly outcomeClass: Exclude<ActivityRecordingOutcomeClass, "success">;
      readonly platformMessageId?: never;
      /** Full error projection is encrypted; never copied to the plaintext index. */
      readonly error: ActivityRecordingErrorProjection;
    }
);

export interface ActivityRecordingExactness {
  readonly eligible: false;
  readonly blockers: readonly ActivityRecordingExactnessBlocker[];
}

export interface ActivityRecordingInspection {
  readonly headSequence: number;
  readonly headHash: string;
  readonly recordCount: number;
  readonly logicalBytes: number;
  readonly gapCount: number;
  readonly trustedHeadAnchor: boolean;
  readonly exactness: ActivityRecordingExactness;
}

/** Prospective evidence port for the first normalized-turn/delivery slice. */
export interface ProductionActivityRecorderPort {
  recordInboundChannelActivity(
    input: RecordInboundChannelActivityInput,
  ): Promise<Result<ActivityRecordingReceipt, ActivityRecordingFailure>>;
  beginDeliveryPlatformAttempt(
    input: BeginDeliveryPlatformAttemptInput,
  ): Promise<Result<ActivityRecordingAttemptReceipt, ActivityRecordingFailure>>;
  finishDeliveryPlatformAttempt(
    input: FinishDeliveryPlatformAttemptInput,
  ): Promise<Result<ActivityRecordingReceipt, ActivityRecordingFailure>>;
  exportEvidence(
    input: ActivityRecordingEvidenceExportInput,
  ): Promise<Result<ActivityRecordingEvidenceExport, Error>>;
  inspect(): Promise<Result<ActivityRecordingInspection, Error>>;
  close(): Promise<Result<void, Error>>;
}
