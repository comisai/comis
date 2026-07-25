// SPDX-License-Identifier: Apache-2.0
/** Lock-owned indexing and integrity checks for the inbound provenance sidecar. */

import { lstatSync } from "node:fs";
import {
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  parseInboundMessageProvenanceBatch,
  type NormalizedMessage,
} from "@comis/core";
import { readRegularFile } from "@comis/observability";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  planInboundMessageProvenance,
  type InboundMessageProvenancePayload,
  type InboundMessageProvenancePlan,
  type InboundMessageProvenancePlanError,
} from "./inbound-message-provenance.js";

/** Fail closed before an unbounded or operator-corrupted ledger allocation. */
export const MAX_INBOUND_PROVENANCE_LEDGER_BYTES = 64 * 1024 * 1024;

interface PersistedInboundBatch {
  batchId: string;
  chunkIndex: number;
  chunkCount: number;
  recordedAt: number;
  messages: InboundMessageProvenancePayload["messages"];
}

export interface InboundLedgerFileSignature {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
}

export interface InboundLedgerIndex {
  readonly signature: InboundLedgerFileSignature;
  readonly batches: Map<string, readonly Partial<PersistedInboundBatch>[]>;
}

export function inboundLedgerFailure(
  message: string,
): InboundMessageProvenancePlanError {
  return {
    error: new Error(message),
    errorKind: "precondition",
  };
}

export function inboundLedgerResourceFailure(
  error: Error,
): InboundMessageProvenancePlanError {
  return { error, errorKind: "resource" };
}

/** Classify unsafe artifact shapes separately from ordinary storage failures. */
export function classifyInboundLedgerIoFailure(
  error: Error,
): InboundMessageProvenancePlanError {
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (
    code === "FILE_SIZE_LIMIT_EXCEEDED"
    || code === "PATH_ESCAPES_CONFINEMENT"
    || code === "REGULAR_FILE_READ_REJECTED"
    || code === "SYMLINK_PARENT_REJECTED"
  ) {
    return inboundLedgerFailure(
      "Inbound provenance ledger failed artifact integrity validation",
    );
  }
  return inboundLedgerResourceFailure(error);
}

export function readInboundLedgerSignature(
  ledgerPath: string,
): Result<InboundLedgerFileSignature, InboundMessageProvenancePlanError> {
  const stat = tryCatch(() => lstatSync(ledgerPath, { bigint: true }));
  if (!stat.ok) return err(inboundLedgerResourceFailure(stat.error));
  if (!stat.value.isFile()) {
    return err(inboundLedgerFailure(
      "Inbound provenance ledger is not a regular file",
    ));
  }
  return ok({
    device: stat.value.dev,
    inode: stat.value.ino,
    size: stat.value.size,
    modifiedAtNs: stat.value.mtimeNs,
    changedAtNs: stat.value.ctimeNs,
  });
}

export function sameInboundLedgerSignature(
  first: InboundLedgerFileSignature,
  second: InboundLedgerFileSignature,
): boolean {
  return first.device === second.device
    && first.inode === second.inode
    && first.size === second.size
    && first.modifiedAtNs === second.modifiedAtNs
    && first.changedAtNs === second.changedAtNs;
}

export function sameInboundLedgerFile(
  first: InboundLedgerFileSignature,
  second: InboundLedgerFileSignature,
): boolean {
  return first.device === second.device && first.inode === second.inode;
}

/** Compare immutable source content while allowing retry receipt clocks to differ. */
function sameInboundMessages(
  first: InboundMessageProvenancePayload["messages"],
  second: InboundMessageProvenancePayload["messages"],
): boolean {
  const withoutReceiptTimestamp = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const copy = { ...(value as Record<string, unknown>) };
    delete copy.timestamp;
    return copy;
  };
  return JSON.stringify(first.map(withoutReceiptTimestamp)) ===
    JSON.stringify(second.map(withoutReceiptTimestamp));
}

/** Encode a validated provenance payload sequence in the sidecar format. */
function encodeInboundProvenancePlan(
  payloads: readonly InboundMessageProvenancePayload[],
): InboundMessageProvenancePlan {
  return {
    payloads,
    ledgerContent: payloads.map((payload) => `${JSON.stringify({
      type: "custom",
      customType: INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
      data: payload,
    })}\n`).join(""),
  };
}

export type PersistedInboundBatchState =
  | { kind: "absent" }
  | { kind: "complete"; plan: InboundMessageProvenancePlan }
  | { kind: "incomplete"; plan: InboundMessageProvenancePlan; missingContent: string };

/** Build a reusable index from one stable, bounded ledger snapshot. */
export function readInboundLedgerIndex(
  ledgerPath: string,
  sessionBaseDir: string,
): Result<InboundLedgerIndex, InboundMessageProvenancePlanError> {
  const before = readInboundLedgerSignature(ledgerPath);
  if (!before.ok) return before;
  const read = readRegularFile({
    path: ledgerPath,
    maxFileBytes: MAX_INBOUND_PROVENANCE_LEDGER_BYTES,
    confinedBaseDir: sessionBaseDir,
  });
  if (!read.ok) return err(classifyInboundLedgerIoFailure(read.error));
  const after = readInboundLedgerSignature(ledgerPath);
  if (!after.ok) return after;
  if (
    !sameInboundLedgerSignature(before.value, after.value)
    || after.value.size !== BigInt(read.value.totalBytes)
  ) {
    return err(inboundLedgerFailure(
      "Inbound provenance ledger changed while it was being validated",
    ));
  }

  const batches = new Map<string, Array<Partial<PersistedInboundBatch>>>();
  for (const line of read.value.content.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    const decoded = tryCatch(() => JSON.parse(line) as {
      customType?: unknown;
      data?: unknown;
    });
    if (!decoded.ok) {
      return err(inboundLedgerFailure(
        "Inbound provenance ledger contains invalid JSON",
      ));
    }
    if (decoded.value.customType !== INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE) continue;
    const parsed = parseInboundMessageProvenanceBatch(decoded.value.data);
    if (!parsed.ok) {
      return err(inboundLedgerFailure(
        "Inbound provenance ledger contains a malformed batch",
      ));
    }
    const data = parsed.value as PersistedInboundBatch;
    const matching = batches.get(data.batchId) ?? [];
    matching.push(data);
    batches.set(data.batchId, matching);
  }
  return ok({ signature: after.value, batches });
}

/** Recover one exact provenance batch from the locked ledger index. */
export function findPersistedInboundBatch(
  index: InboundLedgerIndex,
  message: NormalizedMessage,
  plan: InboundMessageProvenancePlan,
): Result<PersistedInboundBatchState, InboundMessageProvenancePlanError> {
  const batchId = plan.payloads[0]?.batchId;
  if (batchId === undefined) {
    return err({
      error: new Error("Inbound provenance plan has no batch identity"),
      errorKind: "validation",
    });
  }
  const matches = index.batches.get(batchId) ?? [];
  for (const data of matches) {
    if (
      typeof data.chunkIndex !== "number"
      || typeof data.chunkCount !== "number"
      || typeof data.recordedAt !== "number"
      || !Array.isArray(data.messages)
    ) {
      return err(inboundLedgerFailure(
        "Inbound provenance ledger contains a malformed matching batch",
      ));
    }
  }
  if (matches.length === 0) return ok({ kind: "absent" });
  const ordered = [...matches as PersistedInboundBatch[]]
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
  const expectedChunkCount = ordered[0]?.chunkCount;
  const firstRecordedAt = ordered[0]?.recordedAt;
  if (
    expectedChunkCount === undefined
    || firstRecordedAt === undefined
    || ordered.length > expectedChunkCount
    || ordered.some((chunk, index) =>
      chunk.chunkIndex !== index
      || chunk.chunkCount !== expectedChunkCount
      || chunk.recordedAt !== firstRecordedAt)
  ) {
    return err(inboundLedgerFailure(
      "Inbound provenance ledger contains a malformed matching batch",
    ));
  }
  const recovered = planInboundMessageProvenance(message, firstRecordedAt);
  if (!recovered.ok) return err(recovered.error);
  if (
    recovered.value.payloads.length !== expectedChunkCount
    || ordered.some((chunk, index) =>
      !sameInboundMessages(
        chunk.messages,
        recovered.value.payloads[index]?.messages ?? [],
      ))
  ) {
    return err(inboundLedgerFailure(
      "Inbound provenance batch identity collides with different content",
    ));
  }
  const recoveredPlan = encodeInboundProvenancePlan(
    recovered.value.payloads.map((payload, index) => ({
      ...payload,
      messages: ordered[index]?.messages ?? payload.messages,
    })),
  );
  if (ordered.length === expectedChunkCount) {
    return ok({ kind: "complete", plan: recoveredPlan });
  }
  const missingLines = recoveredPlan.ledgerContent.trimEnd().split("\n")
    .slice(ordered.length);
  return ok({
    kind: "incomplete",
    plan: recoveredPlan,
    missingContent: `${missingLines.join("\n")}\n`,
  });
}
