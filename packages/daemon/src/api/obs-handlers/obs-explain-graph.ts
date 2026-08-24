// SPDX-License-Identifier: Apache-2.0
/** Bounded, content-free reader for terminal execution-graph metadata. */

import { z } from "zod";
import {
  IncidentGraphRunSchema,
  safePath,
  type IncidentGraphRun,
} from "@comis/core";
import { readRegularFile } from "@comis/observability";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  resolveGraphRunStatus,
  type GraphRunCancelReason,
} from "../../graph/graph-run-status.js";

const MAX_GRAPH_METADATA_BYTES = 1_048_576;

const PersistedGraphNodeSchema = z.object({
  status: z.enum(["pending", "ready", "running", "completed", "failed", "skipped"]),
  durationMs: z.number().nonnegative().nullable(),
  subAgentRunId: z.string().min(1).nullable(),
  attemptsUsed: z.number().int().positive(),
});

const PersistedGraphRunSchema = z.object({
  graphId: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  cancelReason: z.enum(["manual", "budget", "timeout", "killed"]).optional(),
  sessionKey: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  announcementDelivery: z.enum([
    "not-requested",
    "unavailable",
    "committed",
    "retained",
    "suppressed",
    "failed",
  ]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().nonnegative(),
  nodesTotal: z.number().int().nonnegative(),
  nodesSucceeded: z.number().int().nonnegative(),
  nodesFailed: z.number().int().nonnegative(),
  nodesSkipped: z.number().int().nonnegative(),
  nodesRetried: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  nodes: z.record(z.string(), PersistedGraphNodeSchema),
});

/** Read and validate one terminal graph record without exposing task or output content. */
export function readIncidentGraphRun(
  dataDir: string,
  graphId: string,
): Result<IncidentGraphRun, Error> {
  const graphDirResult = tryCatch(() => safePath(dataDir, "graph-runs", graphId));
  if (!graphDirResult.ok) return err(new Error("graph metadata path validation failed"));
  const metadataPathResult = tryCatch(() =>
    safePath(graphDirResult.value, "_run-metadata.json")
  );
  if (!metadataPathResult.ok) return err(new Error("graph metadata path validation failed"));
  const read = readRegularFile({
    path: metadataPathResult.value,
    maxFileBytes: MAX_GRAPH_METADATA_BYTES,
    confinedBaseDir: dataDir,
  });
  if (!read.ok) return err(new Error("graph metadata read failed"));
  const decoded = tryCatch(() => JSON.parse(read.value.content.toString("utf8")) as unknown);
  if (!decoded.ok) return err(new Error("graph metadata JSON is invalid"));
  const persisted = PersistedGraphRunSchema.safeParse(decoded.value);
  if (!persisted.success || persisted.data.graphId !== graphId) {
    return err(new Error("graph metadata schema is invalid"));
  }

  const raw = persisted.data;
  const cancelReason = raw.cancelReason as GraphRunCancelReason | undefined;
  const status = raw.status === "failed" || raw.status === "cancelled"
    ? raw.status
    : resolveGraphRunStatus(cancelReason, raw.status);
  const projected = IncidentGraphRunSchema.safeParse({
    graphId: raw.graphId,
    status,
    ...(raw.cancelReason === undefined ? {} : { cancelReason: raw.cancelReason }),
    ...(raw.sessionKey === undefined ? {} : { sessionKey: raw.sessionKey }),
    ...(raw.traceId === undefined ? {} : { traceId: raw.traceId }),
    announcementDelivery: raw.announcementDelivery,
    ...(raw.startedAt === undefined ? {} : { startedAt: raw.startedAt }),
    ...(raw.completedAt === undefined ? {} : { completedAt: raw.completedAt }),
    durationMs: raw.durationMs,
    nodesTotal: raw.nodesTotal,
    nodesSucceeded: raw.nodesSucceeded,
    nodesFailed: raw.nodesFailed,
    nodesSkipped: raw.nodesSkipped,
    nodesRetried: raw.nodesRetried,
    ...(raw.totalCostUsd === undefined ? {} : { totalCostUsd: raw.totalCostUsd }),
    ...(raw.totalTokens === undefined ? {} : { totalTokens: raw.totalTokens }),
    nodes: Object.entries(raw.nodes).map(([nodeId, node]) => ({
      nodeId,
      status: node.status,
      durationMs: node.durationMs,
      subAgentRunId: node.subAgentRunId,
      attemptsUsed: node.attemptsUsed,
    })),
  });
  return projected.success
    ? ok(projected.data)
    : err(new Error("graph incident projection is invalid"));
}
