// SPDX-License-Identifier: Apache-2.0
import type { WorkspacePolicySnapshot } from "@comis/core";
import {
  type FollowupTaskAttemptRecord,
  type FollowupTaskRecord,
  type FollowupTaskStoreFile,
} from "./task-types.js";

const ROLLING_DAY_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_CAP_RECHECK_MS = 60_000;
type PendingTask = Extract<FollowupTaskRecord, { status: "pending" }>;
type CheckingTask = Extract<FollowupTaskRecord, { status: "checking" }>;
type CheckingAttempt = Extract<FollowupTaskAttemptRecord, { status: "checking" }>;

export type TaskClaimResult =
  | { readonly status: "no_due" | "quiet_hours" }
  | {
    readonly status: "daily_cap";
    readonly deferredTaskCount: number;
    readonly expiredTaskCount: number;
  }
  | {
    readonly status: "claimed";
    readonly attempt: CheckingAttempt;
    readonly tasks: readonly CheckingTask[];
    readonly policySnapshot: WorkspacePolicySnapshot;
  };

export interface TaskClaimPlan {
  readonly root: FollowupTaskStoreFile;
  readonly result: TaskClaimResult;
}

export function planDueTaskClaim(input: {
  readonly root: FollowupTaskStoreFile;
  readonly nowMs: number;
  readonly agentId: string;
  readonly bootId: string;
  readonly rootRunId: string;
  readonly attemptId: string;
  readonly maxPerCheck: number;
  readonly maxPerDayPerConversation: number;
  readonly quietUntilMs: number | null;
}): TaskClaimPlan {
  const due = input.root.tasks.filter((task): task is PendingTask => (
    task.agentId === input.agentId
    && task.status === "pending"
    && task.nextAttemptAtMs <= input.nowMs
    && task.dueLatestMs >= input.nowMs
    && task.expiresAtMs >= input.nowMs
  )).sort(compareTasks);
  if (due.length === 0) return { root: input.root, result: { status: "no_due" } };
  if (input.quietUntilMs !== null && input.quietUntilMs > input.nowMs) {
    const tasks = deferGroup(input.root.tasks, due, input.quietUntilMs, input.nowMs);
    return {
      root: tasks === input.root.tasks ? input.root : { ...input.root, tasks },
      result: { status: "quiet_hours" },
    };
  }

  const groups = groupExactOrigin(due);
  let tasks = input.root.tasks;
  let saturated = 0;
  const saturatedTaskIds = new Set<string>();
  for (const group of groups) {
    const cap = visibleReservation(input.root.attempts, group[0]!, input.nowMs);
    if (cap.count >= input.maxPerDayPerConversation) {
      saturated += 1;
      for (const task of group) saturatedTaskIds.add(task.id);
      const nextSlot = cap.nextSlotMs ?? input.nowMs + ACTIVE_CAP_RECHECK_MS;
      tasks = deferGroup(tasks, group, nextSlot, input.nowMs);
      continue;
    }
    const selected = group.slice(0, input.maxPerCheck);
    const selectedIds = new Set(selected.map((task) => task.id));
    const claimedTasks = selected.map(toCheckingTask(input.attemptId));
    const replacements = new Map(claimedTasks.map((task) => [task.id, task]));
    tasks = tasks.map((task) => replacements.get(task.id) ?? task);
    const first = selected[0]!;
    const attempt: CheckingAttempt = {
      id: input.attemptId,
      bootId: input.bootId,
      rootRunId: input.rootRunId,
      taskIds: selected.map((task) => task.id),
      tenantId: first.origin.turnScope.conversation.tenantId,
      agentId: first.agentId,
      conversationRef: first.origin.conversationRef,
      startedAtMs: input.nowMs,
      status: "checking",
    };
    const policySnapshot = input.root.policySnapshots.find((policy) => policy.combinedHash === first.workspacePolicyHash)!;
    return {
      root: { ...input.root, tasks, attempts: [...input.root.attempts, attempt] },
      result: {
        status: "claimed",
        attempt,
        tasks: claimedTasks.filter((task) => selectedIds.has(task.id)),
        policySnapshot,
      },
    };
  }
  return {
    root: tasks === input.root.tasks ? input.root : { ...input.root, tasks },
    result: saturated === groups.length
      ? {
        status: "daily_cap",
        deferredTaskCount: tasks.filter((task) => saturatedTaskIds.has(task.id) && task.status === "pending").length,
        expiredTaskCount: tasks.filter((task) => saturatedTaskIds.has(task.id) && task.status === "expired").length,
      }
      : { status: "no_due" },
  };
}

function groupExactOrigin(tasks: readonly PendingTask[]): PendingTask[][] {
  const groups = new Map<string, PendingTask[]>();
  for (const task of tasks) {
    const key = JSON.stringify({
      conversation: task.origin.turnScope.conversation,
      principal: task.origin.turnScope.principal,
      endpoint: task.origin.turnScope.endpoint,
      conversationRef: task.origin.conversationRef,
      deliveryOrigin: task.origin.deliveryOrigin,
      workspacePolicyHash: task.workspacePolicyHash,
      responseLocalePolicy: task.responseLocalePolicy,
    });
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [task]);
    else group.push(task);
  }
  return [...groups.values()];
}

function compareTasks(left: FollowupTaskRecord, right: FollowupTaskRecord): number {
  const leftNext = left.status === "pending" ? left.nextAttemptAtMs : Number.MAX_SAFE_INTEGER;
  const rightNext = right.status === "pending" ? right.nextAttemptAtMs : Number.MAX_SAFE_INTEGER;
  return leftNext - rightNext
    || left.dueEarliestMs - right.dueEarliestMs
    || left.createdAtMs - right.createdAtMs
    || left.id.localeCompare(right.id);
}

function toCheckingTask(attemptId: string) {
  return (task: PendingTask): CheckingTask => {
    const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = task;
    return { ...base, status: "checking", activeAttemptId: attemptId, attemptCount: task.attemptCount + 1 };
  };
}

function visibleReservation(
  attempts: readonly FollowupTaskAttemptRecord[],
  task: FollowupTaskRecord,
  nowMs: number,
): { count: number; nextSlotMs?: number } {
  const cutoff = nowMs - ROLLING_DAY_MS;
  let count = 0;
  let nextSlotMs: number | undefined;
  for (const attempt of attempts) {
    if (
      attempt.tenantId !== task.origin.turnScope.conversation.tenantId
      || attempt.agentId !== task.agentId
      || attempt.conversationRef !== task.origin.conversationRef
    ) continue;
    let visibleAtMs: number | undefined;
    if (attempt.status === "checking" || attempt.status === "delivering") {
      count += 1;
      continue;
    }
    if (attempt.status === "delivered" || attempt.status === "delivery_partial") visibleAtMs = attempt.deliveredAtMs;
    else if (attempt.status === "delivery_unknown") visibleAtMs = attempt.deliveringAtMs;
    if (visibleAtMs === undefined || visibleAtMs < cutoff) continue;
    count += 1;
    const release = visibleAtMs + ROLLING_DAY_MS;
    nextSlotMs = nextSlotMs === undefined ? release : Math.min(nextSlotMs, release);
  }
  return { count, nextSlotMs };
}

function deferGroup(
  allTasks: readonly FollowupTaskRecord[],
  group: readonly FollowupTaskRecord[],
  nextSlotMs: number,
  nowMs: number,
): FollowupTaskRecord[] {
  const ids = new Set(group.map((task) => task.id));
  return allTasks.map((task): FollowupTaskRecord => {
    if (!ids.has(task.id) || task.status !== "pending") return task;
    if (nextSlotMs > task.dueLatestMs || nextSlotMs > task.expiresAtMs) {
      const { nextAttemptAtMs: _nextAttemptAtMs, ...base } = task;
      return { ...base, status: "expired", terminalAttemptId: null, terminalAtMs: nowMs };
    }
    return { ...task, nextAttemptAtMs: nextSlotMs };
  });
}
