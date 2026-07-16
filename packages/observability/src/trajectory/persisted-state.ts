// SPDX-License-Identifier: Apache-2.0
/** Durable trajectory high-water state recovered before an append-only reopen. */

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  PathEscapesConfinementError,
  RegularFileReadRejected,
  SymlinkParentRejected,
  readRegularFile,
} from "../shared/fs-safe.js";

export type TrajectoryResumeFailureKind =
  | "permission"
  | "confinement"
  | "symlink"
  | "non_regular"
  | "size_limit"
  | "invalid_jsonl"
  | "changed"
  | "io";

/** Content-free classification for a persisted trajectory that cannot resume. */
export class TrajectoryResumeError extends Error {
  public readonly name = "TrajectoryResumeError" as const;
  public readonly code = "TRAJECTORY_RESUME_FAILED" as const;
  public readonly failureKind: TrajectoryResumeFailureKind;
  public readonly sourceCode: string | undefined;

  constructor(
    failureKind: TrajectoryResumeFailureKind,
    sourceCode?: string,
  ) {
    super("Trajectory persisted state could not be resumed");
    this.failureKind = failureKind;
    this.sourceCode = sourceCode;
  }
}

export interface PersistedTrajectoryState {
  readonly maxSeq: number;
  readonly writtenBytes: number;
  readonly malformedRecords: number;
  readonly sequenceRegressions: number;
  readonly needsLineBreak: boolean;
  readonly softClosed: boolean;
  /** Whether a session.started remains unmatched by a later session.ended. */
  readonly sessionStartedActive: boolean;
}

export interface ReadPersistedTrajectoryStateInput {
  readonly filePath: string;
  readonly sessionId: string;
  readonly maxFileBytes: number;
  readonly confinedBaseDir?: string;
}

const EMPTY_STATE: PersistedTrajectoryState = {
  maxSeq: 0,
  writtenBytes: 0,
  malformedRecords: 0,
  sequenceRegressions: 0,
  needsLineBreak: false,
  softClosed: false,
  sessionStartedActive: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyReadError(error: Error): TrajectoryResumeError {
  if (error instanceof PathEscapesConfinementError) {
    return new TrajectoryResumeError("confinement", error.code);
  }
  if (error instanceof SymlinkParentRejected) {
    return new TrajectoryResumeError("symlink", error.code);
  }
  if (error instanceof RegularFileReadRejected) {
    return new TrajectoryResumeError(error.kind, error.code);
  }
  const sourceCode = (error as NodeJS.ErrnoException).code;
  if (sourceCode === "EACCES" || sourceCode === "EPERM") {
    return new TrajectoryResumeError("permission", sourceCode);
  }
  return new TrajectoryResumeError("io", sourceCode ?? error.name);
}

/** Read and validate the durable counter/lifecycle state of one trajectory file. */
export function readPersistedTrajectoryState(
  input: ReadPersistedTrajectoryStateInput,
): Result<PersistedTrajectoryState, TrajectoryResumeError> {
  const readResult = readRegularFile({
    path: input.filePath,
    maxFileBytes: input.maxFileBytes,
    ...(input.confinedBaseDir !== undefined
      ? { confinedBaseDir: input.confinedBaseDir }
      : {}),
  });
  if (!readResult.ok) {
    if ((readResult.error as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(EMPTY_STATE);
    }
    return err(classifyReadError(readResult.error));
  }

  const raw = readResult.value.content;
  let maxSeq = 0;
  let malformedRecords = 0;
  let sequenceRegressions = 0;
  let validRecords = 0;
  let priorSeq: number | undefined;
  let softClosed = false;
  let sessionStartedActive = false;

  for (const line of raw.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = tryCatch<unknown>(() => JSON.parse(line) as unknown);
    if (!parsed.ok || !isRecord(parsed.value)) {
      malformedRecords += 1;
      continue;
    }
    const record = parsed.value;
    const seq = record["seq"];
    if (
      record["traceSchema"] !== "comis-trajectory" ||
      record["schemaVersion"] !== 1 ||
      record["sessionId"] !== input.sessionId ||
      !Number.isSafeInteger(seq) ||
      (seq as number) < 1 ||
      (seq as number) >= Number.MAX_SAFE_INTEGER
    ) {
      malformedRecords += 1;
      continue;
    }

    const validSeq = seq as number;
    if (priorSeq !== undefined && validSeq <= priorSeq) {
      sequenceRegressions += 1;
    }
    priorSeq = validSeq;
    validRecords += 1;
    maxSeq = Math.max(maxSeq, validSeq);

    if (record["type"] === "session.started") {
      sessionStartedActive = true;
    } else if (record["type"] === "session.ended") {
      sessionStartedActive = false;
    }

    const data = record["data"];
    if (
      record["type"] === "trace.truncated" &&
      isRecord(data) &&
      data["reason"] === "trajectory-runtime-file-size-limit"
    ) {
      softClosed = true;
    }
  }

  if (raw.length > 0 && validRecords === 0) {
    return err(new TrajectoryResumeError("invalid_jsonl", "NO_VALID_RECORDS"));
  }
  return ok({
    maxSeq,
    writtenBytes: readResult.value.totalBytes,
    malformedRecords,
    sequenceRegressions,
    needsLineBreak: raw.length > 0 && raw[raw.length - 1] !== 0x0a,
    softClosed,
    sessionStartedActive,
  });
}
