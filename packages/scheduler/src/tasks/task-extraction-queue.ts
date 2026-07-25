// SPDX-License-Identifier: Apache-2.0
import {
  BackgroundTaskOriginSchema,
  ResponseLocalePolicySchema,
  WorkspacePolicySnapshotSchema,
  verifyWorkspacePolicySnapshot,
  type TaskExtractionPort,
  type TaskExtractionTurn,
  type TimerHandle,
  type TimerPort,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

const MAX_QUEUE_ITEMS = 64;
const MAX_QUEUE_BYTES = 16 * 1_024 * 1_024;
const MAX_ITEM_BYTES = 8 * 1_024 * 1_024;
const MAX_TEXT_BYTES = 64 * 1_024;
const MAX_BATCH_SOURCE_BYTES = 128 * 1_024;

export interface TaskExtractionItem extends TaskExtractionTurn {
  readonly itemId: string;
  readonly minimumDueAtMs: number;
}

export interface TaskExtractionQueueConfig {
  readonly debounceMs: number;
  readonly batchMax: number;
  readonly heartbeatIntervalMs: number;
}

export interface TaskExtractionBatchError {
  readonly code: string;
  readonly errorKind: "config" | "network" | "auth" | "validation" | "precondition" | "timeout" | "resource" | "dependency" | "internal" | "platform";
}

export interface TaskExtractionQueue extends TaskExtractionPort {
  activate(): Result<void, { readonly code: "closed"; readonly errorKind: "precondition" }>;
  close(): { readonly droppedCount: number };
  getStatus(): {
    readonly accepting: boolean;
    readonly itemCount: number;
    readonly encodedBytes: number;
    readonly droppedCount: number;
    readonly batchFailureCount: number;
  };
}

export function createTaskExtractionQueue(deps: {
  readonly timers: TimerPort;
  readonly idFactory: () => string;
  readonly getConfig: (agentId: string) => TaskExtractionQueueConfig;
  readonly onBatch: (
    agentId: string,
    items: readonly TaskExtractionItem[],
  ) => Result<void, TaskExtractionBatchError>;
  readonly onBatchFailed: (
    agentId: string,
    error: TaskExtractionBatchError,
    items: readonly TaskExtractionItem[],
  ) => void;
}): TaskExtractionQueue {
  let state: "inactive" | "active" | "closed" = "inactive";
  let queuedBytes = 0;
  let droppedCount = 0;
  let batchFailureCount = 0;
  const queued: Array<{ item: TaskExtractionItem; encodedBytes: number; sourceBytes: number }> = [];
  const timers = new Map<string, TimerHandle>();

  function schedule(agentId: string): void {
    if (state !== "active" || timers.has(agentId) || !queued.some((entry) => agentIdOf(entry.item) === agentId)) {
      return;
    }
    const config = deps.getConfig(agentId);
    const handle = deps.timers.setTimeout(() => {
      timers.delete(agentId);
      drain(agentId, config);
    }, config.debounceMs);
    handle.unref();
    timers.set(agentId, handle);
  }

  function drain(agentId: string, config: TaskExtractionQueueConfig): void {
    if (state !== "active") return;
    const selectedIndexes: number[] = [];
    let sourceBytes = 0;
    let workspacePolicyHash: string | undefined;
    for (let index = 0; index < queued.length && selectedIndexes.length < config.batchMax; index++) {
      const entry = queued[index]!;
      if (agentIdOf(entry.item) !== agentId) continue;
      workspacePolicyHash ??= entry.item.workspacePolicySnapshot.combinedHash;
      if (entry.item.workspacePolicySnapshot.combinedHash !== workspacePolicyHash) continue;
      if (selectedIndexes.length > 0 && sourceBytes + entry.sourceBytes > MAX_BATCH_SOURCE_BYTES) break;
      selectedIndexes.push(index);
      sourceBytes += entry.sourceBytes;
    }
    const items = selectedIndexes.map((index) => queued[index]!.item);
    for (const index of selectedIndexes.reverse()) {
      queuedBytes -= queued[index]!.encodedBytes;
      queued.splice(index, 1);
    }
    if (items.length > 0) {
      const transferred = deps.onBatch(agentId, items);
      if (!transferred.ok) {
        batchFailureCount += 1;
        deps.onBatchFailed(agentId, transferred.error, items);
      }
    }
    schedule(agentId);
  }

  function cancelOrphanedTimer(agentId: string): void {
    if (queued.some((entry) => agentIdOf(entry.item) === agentId)) return;
    timers.get(agentId)?.cancel();
    timers.delete(agentId);
  }

  return {
    activate() {
      if (state === "closed") return err({ code: "closed", errorKind: "precondition" });
      state = "active";
      for (const entry of queued) schedule(agentIdOf(entry.item));
      return ok(undefined);
    },
    enqueue(turn) {
      if (state !== "active") return err({ code: "not_accepting", errorKind: "precondition" });
      const built = buildItem(turn, deps.idFactory, deps.getConfig);
      if (!built.ok) return built;
      let dropped = false;
      while (queued.length >= MAX_QUEUE_ITEMS || queuedBytes + built.value.encodedBytes > MAX_QUEUE_BYTES) {
        const oldest = queued.shift();
        if (oldest === undefined) return err({ code: "invalid_turn", errorKind: "validation" });
        queuedBytes -= oldest.encodedBytes;
        droppedCount += 1;
        dropped = true;
        cancelOrphanedTimer(agentIdOf(oldest.item));
      }
      queued.push(built.value);
      queuedBytes += built.value.encodedBytes;
      schedule(agentIdOf(built.value.item));
      return ok(dropped ? "oldest_dropped" : "enqueued");
    },
    close() {
      state = "closed";
      for (const handle of timers.values()) handle.cancel();
      timers.clear();
      const pending = queued.length;
      queued.length = 0;
      queuedBytes = 0;
      droppedCount += pending;
      return { droppedCount: pending };
    },
    getStatus() {
      return {
        accepting: state === "active",
        itemCount: queued.length,
        encodedBytes: queuedBytes,
        droppedCount,
        batchFailureCount,
      };
    },
  };
}

function agentIdOf(item: TaskExtractionItem): string {
  return item.origin.turnScope.conversation.agentId;
}

function buildItem(
  turn: TaskExtractionTurn,
  idFactory: () => string,
  getConfig: (agentId: string) => TaskExtractionQueueConfig,
): Result<{
  item: TaskExtractionItem;
  encodedBytes: number;
  sourceBytes: number;
}, { readonly code: "invalid_turn"; readonly errorKind: "validation" }> {
  const origin = BackgroundTaskOriginSchema.safeParse(turn.origin);
  const snapshot = WorkspacePolicySnapshotSchema.safeParse(turn.workspacePolicySnapshot);
  const locale = ResponseLocalePolicySchema.safeParse(turn.responseLocalePolicy);
  const userBytes = Buffer.byteLength(turn.userText, "utf8");
  const assistantBytes = Buffer.byteLength(turn.deliveredAssistantText, "utf8");
  if (
    !origin.success
    || !snapshot.success
    || !locale.success
    || !Number.isSafeInteger(turn.capturedAtMs)
    || turn.capturedAtMs < 0
    || turn.sourceExecutionId.length === 0
    || userBytes === 0
    || assistantBytes === 0
    || userBytes > MAX_TEXT_BYTES
    || assistantBytes > MAX_TEXT_BYTES
  ) {
    return err({ code: "invalid_turn", errorKind: "validation" });
  }
  const verified = verifyWorkspacePolicySnapshot(snapshot.data);
  const agentId = origin.data.turnScope.conversation.agentId;
  if (!verified.ok || snapshot.data.agentId !== agentId) {
    return err({ code: "invalid_turn", errorKind: "validation" });
  }
  const config = getConfig(agentId);
  const minimumDueAtMs = turn.capturedAtMs + config.heartbeatIntervalMs;
  const itemId = idFactory();
  if (
    itemId.length === 0
    || !Number.isSafeInteger(minimumDueAtMs)
    || config.debounceMs < 1
    || config.batchMax < 1
    || config.heartbeatIntervalMs < 1
  ) {
    return err({ code: "invalid_turn", errorKind: "validation" });
  }
  const item: TaskExtractionItem = Object.freeze({
    sourceExecutionId: turn.sourceExecutionId,
    origin: origin.data,
    workspacePolicySnapshot: snapshot.data,
    responseLocalePolicy: locale.data,
    capturedAtMs: turn.capturedAtMs,
    userText: turn.userText,
    deliveredAssistantText: turn.deliveredAssistantText,
    itemId,
    minimumDueAtMs,
  });
  const encodedBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
  return encodedBytes > MAX_ITEM_BYTES
    ? err({ code: "invalid_turn", errorKind: "validation" })
    : ok({ item, encodedBytes, sourceBytes: userBytes + assistantBytes });
}
