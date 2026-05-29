// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-trace runtime recorder — RED STUB (pre-patch state).
 *
 * Intentionally writes each recall record VERBATIM (no sanitize, no
 * bounding) so the mandatory OBS-02 redaction proof + the bounded-payload
 * test in runtime.test.ts FAIL on this commit. The GREEN patch wires the
 * `sanitizeForPersistence` chokepoint.
 *
 * @module
 */

import { systemDateFrom, systemGetEnv, systemNowMs, tryGetContext } from "@comis/core";

import {
  getQueuedFileWriter,
  type QueuedFileWriter,
} from "../shared/queued-file-writer.js";
import { safeJsonStringify } from "../shared/safe-json-stringify.js";

import { resolveRecallTraceFilePath } from "./paths.js";

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

const writerRegistry = new Map<string, QueuedFileWriter>();

export interface RecallTraceInit {
  readonly enabled: boolean;
  readonly filePath?: string;
  readonly confinedBaseDir?: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly envelope?: {
    readonly sessionKey?: string;
    readonly tenantId?: string;
    readonly runId?: string;
  };
  readonly maxFileBytes?: number;
  readonly maxQueuedBytes?: number;
}

export interface RecallTrace {
  readonly filePath: string;
  recordRecall(record: Record<string, unknown>): "queued" | "dropped";
  flush(): Promise<void>;
  flushAndClose(): Promise<void>;
  failureCount(): number;
}

export function createRecallTrace(init: RecallTraceInit): RecallTrace | null {
  if (init.enabled === false) return null;
  if (isDisabledByEnv()) return null;

  const filePath = resolveRecallTraceFilePath({
    ...(init.filePath !== undefined ? { filePath: init.filePath } : {}),
    ...(init.confinedBaseDir !== undefined ? { confinedBaseDir: init.confinedBaseDir } : {}),
  });
  const maxFileBytes = init.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxQueuedBytes = init.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const writer = getQueuedFileWriter(writerRegistry, filePath, {
    maxQueuedBytes,
    maxFileBytes,
    ...(init.confinedBaseDir !== undefined ? { confinedBaseDir: init.confinedBaseDir } : {}),
  });

  const state = { seq: 0, closed: false };

  return {
    filePath,
    recordRecall(record: Record<string, unknown>): "queued" | "dropped" {
      if (state.closed) return "dropped";
      // RED STUB: NO sanitizeForPersistence — write the record verbatim.
      const event = buildEvent(init, state.seq, record);
      const result = writer.write(`${safeJsonStringify(event)}\n`);
      if (result === "queued") state.seq += 1;
      return result;
    },
    async flush(): Promise<void> {
      await writer.flush();
    },
    async flushAndClose(): Promise<void> {
      if (state.closed) return;
      state.closed = true;
      await writer.flushAndClose();
    },
    failureCount(): number {
      return writer.failureCount();
    },
  };
}

function isDisabledByEnv(): boolean {
  const raw = systemGetEnv("COMIS_DISABLE_RECALL_TRACE");
  if (typeof raw !== "string") return false;
  const norm = raw.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

function buildEvent(
  init: RecallTraceInit,
  seq: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const ts = systemDateFrom(systemNowMs()).toISOString();
  const traceId = resolveTraceId(init.sessionId);
  const envelope: Record<string, unknown> = {
    traceSchema: "comis-recall-trace",
    schemaVersion: 1,
    ts,
    seq,
    agentId: init.agentId,
    sessionId: init.sessionId,
    traceId,
  };
  const env = init.envelope;
  if (env?.sessionKey !== undefined) envelope.sessionKey = env.sessionKey;
  if (env?.tenantId !== undefined) envelope.tenantId = env.tenantId;
  if (env?.runId !== undefined) envelope.runId = env.runId;
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) envelope[k] = v;
  }
  return envelope;
}

function resolveTraceId(sessionId: string): string {
  const ctx = tryGetContext();
  if (ctx !== undefined && typeof ctx.traceId === "string" && ctx.traceId.length > 0) {
    return ctx.traceId;
  }
  return sessionId;
}
