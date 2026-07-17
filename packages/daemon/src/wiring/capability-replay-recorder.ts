// SPDX-License-Identifier: Apache-2.0
/** Content-free recording of successful capability calls for deterministic re-runs. */

import { createHash } from "node:crypto";
import { safePath, toSafeErrorLogString } from "@comis/core";
import type { ComisLogger, LeaseInfo } from "@comis/infra";
import { appendRegularFile, readRegularFile, stableStringify } from "@comis/observability";
import { safeResultRunId } from "@comis/skills/tools";

const REPLAY_RESULTS_DIR = "results";
const REPLAY_LOG_NAME = "replay.jsonl";
/** Bounds both restart scanning and cumulative replay-log growth. */
export const REPLAY_LOG_MAX_BYTES = 1024 * 1024;

/** Hash the canonical wire params identically for recording and playback. */
export function replayParamsDigest(params: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex");
}

interface ReplayLine {
  seq: number;
  method: string;
  paramsDigest: string;
  resultDigest: string;
  result: string;
}

export type ReplayResultMaterialize = (
  payload: string,
  ctx: { recordingRootPath: string; runId: string; nowMs: number; ttlMs?: number },
) => Promise<{ ref: string } | { error: string } | undefined>;

export interface ReplayRecorderDeps {
  isEnabled: (agentId: string) => boolean;
  /** Daemon-owned root that is never mounted into an agent jail. */
  recordingRootPath: string;
  materialize: ReplayResultMaterialize;
  nowMs: () => number;
  ttlMs?: number;
  logger?: ComisLogger;
}

export interface ReplayRecorder {
  record(lease: LeaseInfo, method: string, params: Record<string, unknown>, result: unknown): Promise<void>;
}

interface PersistedSequence {
  next: number;
  needsSeparator: boolean;
}

/** Resume after the highest valid persisted sequence; malformed lines are ignored. */
function persistedSequence(logPath: string, workspacePath: string): PersistedSequence {
  let highest = -1;
  const read = readRegularFile({
    path: logPath,
    maxFileBytes: REPLAY_LOG_MAX_BYTES,
    confinedBaseDir: workspacePath,
  });
  if (!read.ok) {
    if ((read.error as NodeJS.ErrnoException).code === "ENOENT") {
      return { next: 0, needsSeparator: false };
    }
    throw read.error;
  }
  const raw = read.value.content.toString("utf8");
  for (const line of raw.split("\n")) {
    try {
      const seq = (JSON.parse(line) as { seq?: unknown }).seq;
      if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) highest = Math.max(highest, seq);
    } catch { /* malformed lines remain isolated physical lines and are skipped */ }
  }
  if (highest === Number.MAX_SAFE_INTEGER) throw new Error("replay sequence exhausted");
  return { next: highest + 1, needsSeparator: raw.length > 0 && !raw.endsWith("\n") };
}

/** Build a serialized recorder with an independent queue for each run. */
export function createReplayRecorder(deps: ReplayRecorderDeps): ReplayRecorder {
  const log = deps.logger?.child({ submodule: "replay-recorder" });
  const seqByRoot = new Map<string, number>();
  const separatorByRoot = new Set<string>();
  const tailByRoot = new Map<string, Promise<void>>();

  function nextSeq(rootRunId: string): number {
    const next = seqByRoot.get(rootRunId) ?? 0;
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("replay sequence exhausted");
    seqByRoot.set(rootRunId, next + 1);
    return next;
  }

  async function recordOne(lease: LeaseInfo, recordingRunId: string, method: string,
    params: Record<string, unknown>, result: unknown): Promise<void> {
    const payload = JSON.stringify(result ?? null) ?? "null";
    const recordingRootPath = deps.recordingRootPath;
    const logPath = safePath(recordingRootPath, REPLAY_RESULTS_DIR, safeResultRunId(recordingRunId), REPLAY_LOG_NAME);
    if (!seqByRoot.has(recordingRunId)) {
      const persisted = persistedSequence(logPath, recordingRootPath);
      seqByRoot.set(recordingRunId, persisted.next);
      if (persisted.needsSeparator) separatorByRoot.add(recordingRunId);
    }
    const materialized = await deps.materialize(payload, {
      recordingRootPath,
      runId: recordingRunId,
      nowMs: deps.nowMs(),
      ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
    });
    if (materialized === undefined || !("ref" in materialized)) {
      log?.warn(
        {
          method,
          errorKind: "resource" as const,
          hint: "Replay result materialization failed; the completed live call remains successful but replay may diverge",
        },
        "Replay result was not recorded",
      );
      return;
    }

    const line: ReplayLine = {
      seq: nextSeq(recordingRunId),
      method,
      paramsDigest: replayParamsDigest(params),
      resultDigest: createHash("sha256").update(payload, "utf8").digest("hex"),
      result: materialized.ref,
    };
    try {
      const append = appendRegularFile({
        path: logPath,
        content: `${separatorByRoot.has(recordingRunId) ? "\n" : ""}${JSON.stringify(line)}\n`,
        maxFileBytes: REPLAY_LOG_MAX_BYTES,
        confinedBaseDir: recordingRootPath,
        rollbackOnError: "caller-holds-exclusive-lock",
      });
      if (!append.ok) throw append.error;
      separatorByRoot.delete(recordingRunId);
    } catch (cause) {
      log?.warn(
        {
          err: toSafeErrorLogString(cause),
          errorKind: "internal" as const,
          hint: "Writing the content-free replay line failed; the completed live call remains successful but replay may be incomplete",
        },
        "Replay line write failed",
      );
    }
  }

  function record(lease: LeaseInfo, method: string, params: Record<string, unknown>, result: unknown): Promise<void> {
    if (!deps.isEnabled(lease.agentId)) return Promise.resolve();
    const recordingRunId = lease.checkpointId ?? lease.rootRunId;
    const previous = tailByRoot.get(recordingRunId) ?? Promise.resolve();
    const task = previous.then(() => recordOne(lease, recordingRunId, method, params, result));
    const handled = task.catch((cause: unknown) => {
      log?.warn(
        {
          method,
          err: toSafeErrorLogString(cause),
          errorKind: "internal" as const,
          hint: "Replay recording failed after the live call completed; the call remains successful and replay may diverge",
        },
        "Replay recording failed",
      );
    });
    tailByRoot.set(recordingRunId, handled);
    return handled.finally(() => {
      if (tailByRoot.get(recordingRunId) === handled) {
        tailByRoot.delete(recordingRunId);
      }
    });
  }

  return { record };
}
