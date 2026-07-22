// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  BackgroundTaskOriginSchema,
  ResponseLocalePolicySchema,
  WorkspacePolicySnapshotSchema,
  validateMemoryWrite,
  verifyWorkspacePolicySnapshot,
  type WorkspacePolicySnapshot,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type { BoundTaskCandidate } from "./task-extractor.js";
import type {
  FollowupTaskRecord,
  FollowupTaskStoreError,
  FollowupTaskStoreFile,
  TaskAdmissionResult,
} from "./task-types.js";

const MAX_TASK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TASK_TEXT_BYTES = 4 * 1_024;

export function admitTaskCandidate(input: {
  readonly root: FollowupTaskStoreFile;
  readonly candidate: BoundTaskCandidate;
  readonly confidenceThreshold: number;
  readonly nowMs: number;
  readonly idFactory: () => string;
  readonly maxActiveTasks: number;
  readonly hasCapacity: (root: FollowupTaskStoreFile) => boolean;
}): Result<{ root: FollowupTaskStoreFile; result: TaskAdmissionResult }, FollowupTaskStoreError> {
  const validated = validateCandidate(input.candidate);
  if (!validated.ok) return validated;
  const { candidate, root } = input;
  const itemId = candidate.item.itemId;
  if (candidate.confidence < input.confidenceThreshold) {
    return ok({ root, result: { itemId, disposition: "below_threshold" } });
  }
  const content = validateMemoryWrite(candidate.text);
  if (content.severity === "critical") {
    return ok({ root, result: { itemId, disposition: "unsafe_content" } });
  }
  if (candidate.dueLatestMs < input.nowMs || candidate.expiresAtMs < input.nowMs) {
    return ok({ root, result: { itemId, disposition: "expired" } });
  }
  const dedupeKey = computeTaskDedupeKey(candidate);
  const duplicate = root.tasks.find((task) => (
    task.dedupeKey === dedupeKey
    && (task.status === "pending" || task.status === "checking" || task.status === "delivering")
  ));
  if (duplicate !== undefined) {
    if (duplicate.status !== "pending") {
      return ok({ root, result: { itemId, disposition: "active_conflict" } });
    }
    if (candidate.dueLatestMs > duplicate.expiresAtMs) {
      return ok({ root, result: { itemId, disposition: "expired" } });
    }
    const updated: FollowupTaskRecord = {
      ...duplicate,
      lastSourceExecutionId: candidate.item.sourceExecutionId,
      sourceOccurrenceCount: duplicate.sourceOccurrenceCount + 1,
      contentTrust: duplicate.contentTrust === "external" || content.severity === "warn" ? "external" : "derived",
      confidence: Math.max(duplicate.confidence, candidate.confidence),
      dueEarliestMs: Math.min(duplicate.dueEarliestMs, candidate.dueEarliestMs),
      dueLatestMs: Math.max(duplicate.dueLatestMs, candidate.dueLatestMs),
      nextAttemptAtMs: duplicate.preAcceptanceFailureCount === 0
        ? Math.min(duplicate.nextAttemptAtMs, candidate.dueEarliestMs)
        : duplicate.nextAttemptAtMs,
    };
    const merged = { ...root, tasks: root.tasks.map((task) => task.id === duplicate.id ? updated : task) };
    return input.hasCapacity(merged)
      ? ok({ root: merged, result: { itemId, disposition: "merged", taskId: duplicate.id } })
      : ok({ root, result: { itemId, disposition: "store_full" } });
  }
  if (activeTaskCount(root) >= input.maxActiveTasks) {
    return ok({ root, result: { itemId, disposition: "store_full" } });
  }
  const taskId = input.idFactory();
  if (!validId(taskId)) return err(admissionError("Opaque id factory returned an invalid task id"));
  const task: FollowupTaskRecord = {
    id: taskId,
    agentId: candidate.item.origin.turnScope.conversation.agentId,
    origin: candidate.item.origin,
    sourceExecutionId: candidate.item.sourceExecutionId,
    lastSourceExecutionId: candidate.item.sourceExecutionId,
    sourceOccurrenceCount: 1,
    workspacePolicyHash: candidate.item.workspacePolicySnapshot.combinedHash,
    responseLocalePolicy: candidate.item.responseLocalePolicy,
    text: candidate.text,
    contentTrust: content.severity === "warn" ? "external" : "derived",
    confidence: candidate.confidence,
    createdAtMs: candidate.item.capturedAtMs,
    dueEarliestMs: candidate.dueEarliestMs,
    dueLatestMs: candidate.dueLatestMs,
    expiresAtMs: candidate.expiresAtMs,
    dedupeKey,
    attemptCount: 0,
    preAcceptanceFailureCount: 0,
    status: "pending",
    nextAttemptAtMs: Math.max(candidate.dueEarliestMs, input.nowMs),
  };
  const policies = addPolicy(root.policySnapshots, candidate.item.workspacePolicySnapshot);
  if (!policies.ok) return policies;
  const created = { ...root, tasks: [...root.tasks, task], policySnapshots: policies.value };
  return input.hasCapacity(created)
    ? ok({ root: created, result: { itemId, disposition: "created", taskId } })
    : ok({ root, result: { itemId, disposition: "store_full" } });
}

function validateCandidate(candidate: BoundTaskCandidate): Result<void, FollowupTaskStoreError> {
  const origin = BackgroundTaskOriginSchema.safeParse(candidate.item.origin);
  const policy = WorkspacePolicySnapshotSchema.safeParse(candidate.item.workspacePolicySnapshot);
  const locale = ResponseLocalePolicySchema.safeParse(candidate.item.responseLocalePolicy);
  const expectedExpiry = candidate.item.capturedAtMs + MAX_TASK_LIFETIME_MS;
  if (
    !origin.success
    || !policy.success
    || !locale.success
    || !verifyWorkspacePolicySnapshot(candidate.item.workspacePolicySnapshot).ok
    || policy.data.agentId !== origin.data.turnScope.conversation.agentId
    || !validId(candidate.item.itemId)
    || !validId(candidate.item.sourceExecutionId)
    || candidate.text.trim().length === 0
    || Buffer.byteLength(candidate.text, "utf8") > MAX_TASK_TEXT_BYTES
    || !Number.isFinite(candidate.confidence)
    || candidate.confidence < 0
    || candidate.confidence > 1
    || !validTime(candidate.item.capturedAtMs)
    || !validTime(candidate.item.minimumDueAtMs)
    || !validTime(candidate.dueEarliestMs)
    || !validTime(candidate.dueLatestMs)
    || !validTime(candidate.expiresAtMs)
    || !Number.isSafeInteger(expectedExpiry)
    || candidate.expiresAtMs !== expectedExpiry
    || candidate.dueEarliestMs < candidate.item.minimumDueAtMs
    || candidate.dueEarliestMs > candidate.dueLatestMs
    || candidate.dueLatestMs > candidate.expiresAtMs
  ) return err(admissionError("Bound task candidate is invalid"));
  return ok(undefined);
}

function addPolicy(
  policies: readonly WorkspacePolicySnapshot[],
  policy: WorkspacePolicySnapshot,
): Result<WorkspacePolicySnapshot[], FollowupTaskStoreError> {
  const existing = policies.find((candidate) => candidate.combinedHash === policy.combinedHash);
  if (existing === undefined) return ok([...policies, policy]);
  return JSON.stringify(existing) === JSON.stringify(policy)
    ? ok([...policies])
    : err(admissionError("Workspace policy hash identifies conflicting authority"));
}

function computeTaskDedupeKey(candidate: BoundTaskCandidate): string {
  const { origin } = candidate.item;
  const values = [
    origin.turnScope.conversation.tenantId,
    origin.turnScope.conversation.agentId,
    origin.conversationRef,
    JSON.stringify(origin.turnScope.conversation),
    JSON.stringify(origin.turnScope.principal),
    JSON.stringify(origin.turnScope.endpoint),
    JSON.stringify(origin.deliveryOrigin),
    candidate.item.workspacePolicySnapshot.combinedHash,
    JSON.stringify(candidate.item.responseLocalePolicy),
    candidate.text.normalize("NFC").trim().replace(/\s+/gu, " "),
  ];
  const canonical = values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function activeTaskCount(root: FollowupTaskStoreFile): number {
  return root.tasks.filter((task) => task.status === "pending" || task.status === "checking" || task.status === "delivering").length;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256;
}

function admissionError(message: string): FollowupTaskStoreError {
  return { code: "invalid_state", errorKind: "validation", message };
}
