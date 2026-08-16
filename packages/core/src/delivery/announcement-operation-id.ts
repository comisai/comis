// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Build the bounded allocation key for one completion-announcement operation. */
export function createStableAnnouncementOperationId(
  agentId: string,
  callerSessionKey: string,
  runId: string,
  partId?: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      agentId,
      callerSessionKey,
      kind: "completion_announcement",
      partId: partId ?? null,
      runId,
    }))
    .digest("hex");
  return `completion-announcement:${digest}`;
}

export function createStableAnnouncementChunkPartId(
  partId: string | undefined,
  chunkIndex: number,
): string {
  return `${partId ?? "text"}:chunk:${chunkIndex}`;
}

export function createStableAnnouncementChunkOperationId(
  agentId: string,
  callerSessionKey: string,
  runId: string,
  partId: string | undefined,
  chunkIndex: number,
): string {
  return createStableAnnouncementOperationId(
    agentId,
    callerSessionKey,
    runId,
    createStableAnnouncementChunkPartId(partId, chunkIndex),
  );
}

export function isStableAnnouncementChunkPartId(
  partId: string | undefined,
): boolean {
  return partId !== undefined && /:chunk:\d+$/u.test(partId);
}
