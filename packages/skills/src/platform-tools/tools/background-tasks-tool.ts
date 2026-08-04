// SPDX-License-Identifier: Apache-2.0
/**
 * Background tasks management tool: multi-action tool for conversation-scoped task management.
 *
 * Supports 4 actions: list, get, cancel, read_output.
 * Each conversation can inspect only the background tasks it started.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { Result } from "@comis/shared";
import { readStringParam, readEnumParam, throwToolError } from "../tool-helpers.js";
import { createConversationRef, systemDateFrom, tryGetContext } from "@comis/core";

// ---------------------------------------------------------------------------
// Local interface for BackgroundTaskManager dependency injection.
// Skills package cannot import @comis/agent (circular dependency).
// This minimal interface matches the subset used by this tool.
// ---------------------------------------------------------------------------

/** Task status union matching BackgroundTaskStatus in @comis/agent. */
type TaskStatus = "running" | "completed" | "failed" | "cancelled";

/** Minimal task shape used by this tool. */
interface TaskInfo {
  id: string;
  toolName: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  origin: {
    turnScope: {
      conversation: { agentId: string };
    };
    conversationRef: string;
  };
}

/** Subset of BackgroundTaskManager consumed by this tool. */
export interface BackgroundTaskManagerLike {
  getTask(taskId: string): TaskInfo | undefined;
  waitForTask(
    taskId: string,
    onWaiting?: () => void,
    waitHeartbeatMs?: number,
  ): Promise<Result<TaskInfo, Error>>;
  getTasks(agentId: string): TaskInfo[];
  cancel(taskId: string): Result<void, Error>;
}

interface TaskAuthority {
  agentId: string;
  conversationRef: string;
}

function resolveTaskAuthority(expectedAgentId: string): TaskAuthority {
  const context = tryGetContext();
  if (!context?.turnScope || context.agentId !== expectedAgentId) {
    return throwToolError(
      "permission_denied",
      "Background tasks require an active matching conversation authority",
      { hint: "Retry the action from the conversation that started the task" },
    );
  }
  const conversationRef = createConversationRef(context.turnScope.conversation);
  if (!conversationRef.ok) {
    return throwToolError(
      "permission_denied",
      "The active conversation authority is invalid",
      { hint: "Retry after the session identity has been restored" },
    );
  }
  return { agentId: context.agentId, conversationRef: conversationRef.value };
}

function taskBelongsToAuthority(task: TaskInfo, authority: TaskAuthority): boolean {
  return task.origin.turnScope.conversation.agentId === authority.agentId
    && task.origin.conversationRef === authority.conversationRef;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const BackgroundTasksToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("get"),
      Type.Literal("cancel"),
      Type.Literal("read_output"),
    ],
    {
      description:
        "Task management action. list: show all tasks for this conversation. " +
        "get: get task details by ID. cancel: cancel a running task. " +
        "read_output: wait for a running task and read its completed output.",
    },
  ),
  taskId: Type.Optional(
    Type.String({
      description: "Task ID. Required for get, cancel, and read_output actions.",
    }),
  ),
});

type BackgroundTasksToolParamsType = Static<typeof BackgroundTasksToolParams>;

const VALID_ACTIONS = ["list", "get", "cancel", "read_output"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a background tasks management tool with 4 actions.
 *
 * Actions:
 * - **list** -- List all background tasks for the current conversation
 * - **get** -- Get details of a specific task by ID
 * - **cancel** -- Cancel a running background task
 * - **read_output** -- Wait for a running task and read its completed output
 *
 * @param deps - Dependencies: BackgroundTaskManager and agentId
 * @returns AgentTool implementing the background tasks management interface
 */
/**
 * A pending approval in the current conversation, as reported by the approval gate.
 *
 * Structural so this package need not reach into the gate's types (skills cannot import
 * `@comis/agent`).
 */
export interface PendingApprovalLike {
  /** The short id a user quotes to approve or deny. */
  readonly shortId: string;
  /** The tool call awaiting authorization. */
  readonly toolName: string;
}

/**
 * Describe pending approvals so a caller is not told that gate-blocked work is in flight.
 *
 * A task whose tool call is sitting at an approval gate is genuinely `running` — its thread is
 * alive, awaiting the gate's promise — so status alone cannot distinguish "working" from "waiting
 * for a human". The two need opposite actions from the user, and reporting only the first is how a
 * gated pipeline was described as "already running in parallel" and then expired unapproved.
 *
 * Derived at read time rather than persisted as a new task status: the gate already holds this
 * durably (and restores it across restart), so a derived answer cannot go stale and needs no enum
 * migration. Scoped to the conversation, not to a specific task — `TaskInfo` carries no trace id,
 * so an exact task-to-approval link does not exist here, and manufacturing one from tool names
 * would replace one over-claim with another.
 */
function describePendingApprovals(pending: readonly PendingApprovalLike[]): string {
  const ids = pending.map((a) => `${a.shortId} (${a.toolName})`).join(", ");
  return (
    `${pending.length} approval(s) are pending in this conversation: ${ids}. `
    + "Work shown as running may be waiting on one of them and will make no progress until it is "
    + "approved or denied, then fail when the approval times out. Tell the user an approval is "
    + "waiting and what it authorizes; do not describe gated work as already in progress."
  );
}

/**
 * Read the approval gate's pending requests for one conversation.
 *
 * Structural and defensive: the registry holds the gate as an opaque value, and this must never be
 * the reason a status query fails. Any shape it does not recognize yields an empty list, which
 * leaves reporting exactly as it was.
 *
 * Filtered on `conversationRef` — the gate stamps it on every request, and it is already this
 * tool's own authority unit, so the match is exact rather than heuristic.
 */
export function readPendingApprovals(
  gate: unknown,
  conversationRef: string,
): readonly PendingApprovalLike[] {
  const pendingFn = (gate as { pending?: unknown } | undefined)?.pending;
  if (typeof pendingFn !== "function") return [];
  try {
    const raw = (pendingFn as () => unknown).call(gate);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): PendingApprovalLike[] => {
      const r = entry as { shortId?: unknown; toolName?: unknown; conversationRef?: unknown };
      if (r.conversationRef !== conversationRef) return [];
      if (typeof r.shortId !== "string" || typeof r.toolName !== "string") return [];
      return [{ shortId: r.shortId, toolName: r.toolName }];
    });
  } catch {
    // A gate mid-teardown must not turn a status query into a tool failure.
    return [];
  }
}

export function createBackgroundTasksTool(deps: {
  manager: BackgroundTaskManagerLike;
  agentId: string;
  /** Derived from the owning agent's prompt stall budget. */
  waitHeartbeatMs?: number;
  /**
   * Pending approvals for the current conversation. Omitted (or empty) leaves every status report
   * exactly as it was — a deployment with approvals disabled has none by construction.
   */
  pendingApprovals?: (conversationRef: string) => readonly PendingApprovalLike[];
}): AgentTool<typeof BackgroundTasksToolParams> {
  return {
    name: "background_tasks",
    label: "Background Tasks",
    description:
      "Manage background tasks. Long-running tool executions are automatically promoted " +
      "to background and resume the originating conversation automatically when complete. " +
      "Use list, get, or cancel to check status or cancel work. Use read_output only when the user explicitly wants to wait in the current turn.",
    parameters: BackgroundTasksToolParams,

    async execute(
      _toolCallId: string,
      params: BackgroundTasksToolParamsType,
      _signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    ): Promise<AgentToolResult<unknown>> {
      const p = params as unknown as Record<string, unknown>;
      const action = readEnumParam(p, "action", VALID_ACTIONS);
      const authority = resolveTaskAuthority(deps.agentId);
      const pendingApprovals = deps.pendingApprovals?.(authority.conversationRef) ?? [];
      const approvalNotice = pendingApprovals.length > 0
        ? describePendingApprovals(pendingApprovals)
        : undefined;

      switch (action) {
        case "list": {
          const tasks = deps.manager.getTasks(deps.agentId)
            .filter((task: TaskInfo) => taskBelongsToAuthority(task, authority))
            .map((t: TaskInfo) => ({
              id: t.id,
              toolName: t.toolName,
              status: t.status,
              startedAt: systemDateFrom(t.startedAt).toISOString(),
              completedAt: t.completedAt
                ? systemDateFrom(t.completedAt).toISOString()
                : undefined,
            }));
          return {
            content: [{
              type: "text",
              text: approvalNotice === undefined
                ? JSON.stringify(tasks)
                : `${JSON.stringify(tasks)}\n\n${approvalNotice}`,
            }],
            details: approvalNotice === undefined ? tasks : { tasks, pendingApprovals },
          };
        }

        case "get": {
          const taskId = readStringParam(p, "taskId");
          const task = deps.manager.getTask(taskId!);
          if (!task || !taskBelongsToAuthority(task, authority)) {
            throwToolError("not_found", `Background task not found: ${taskId}`, {
              hint: "Call background_tasks with action=list to obtain a task ID owned by this conversation",
            });
          }
          const details = {
            id: task.id,
            toolName: task.toolName,
            status: task.status,
            startedAt: systemDateFrom(task.startedAt).toISOString(),
            completedAt: task.completedAt
              ? systemDateFrom(task.completedAt).toISOString()
              : undefined,
            error: task.error,
          };
          return {
            content: [{
              type: "text",
              text: approvalNotice === undefined
                ? JSON.stringify(details)
                : `${JSON.stringify(details)}\n\n${approvalNotice}`,
            }],
            details: approvalNotice === undefined ? details : { ...details, pendingApprovals },
          };
        }

        case "cancel": {
          const taskId = readStringParam(p, "taskId");
          const task = deps.manager.getTask(taskId!);
          if (!task || !taskBelongsToAuthority(task, authority)) {
            throwToolError("not_found", `Background task not found: ${taskId}`, {
              hint: "Call background_tasks with action=list to obtain a task ID owned by this conversation",
            });
          }
          const cancelResult = deps.manager.cancel(taskId!);
          if (!cancelResult.ok) {
            throwToolError("conflict", cancelResult.error.message);
          }
          return {
            content: [{ type: "text", text: `Task ${taskId} cancelled successfully.` }],
            details: { taskId, cancelled: true },
          };
        }

        case "read_output": {
          const taskId = readStringParam(p, "taskId");
          let task = deps.manager.getTask(taskId!);
          if (!task || !taskBelongsToAuthority(task, authority)) {
            throwToolError("not_found", `Background task not found: ${taskId}`, {
              hint: "Call background_tasks with action=list to obtain a task ID owned by this conversation",
            });
          }
          // Waiting here would burn the turn's budget on work that cannot progress until a human
          // acts, and would then report "still running" when the heartbeat gave up.
          if (task.status === "running" && approvalNotice !== undefined) {
            return {
              content: [{ type: "text", text: approvalNotice }],
              details: { taskId, status: task.status, pendingApprovals },
            };
          }
          if (task.status === "running") {
            const waited = await deps.manager.waitForTask(
              taskId!,
              onUpdate
                ? () => onUpdate({
                    content: [{ type: "text", text: "Background task is still running." }],
                    details: { taskId, status: "running" },
                  })
                : undefined,
              deps.waitHeartbeatMs ?? 60_000,
            );
            if (!waited.ok) {
              return throwToolError("conflict", waited.error.message, {
                hint: "Inspect the task details before retrying the underlying operation",
              });
            }
            task = waited.value;
          }
          switch (task.status) {
            case "running":
              return {
                content: [{ type: "text", text: `Task ${taskId} is still running. Check back later.` }],
                details: { taskId, status: "running" },
              };
            case "completed":
              return {
                content: [{ type: "text", text: task.result ?? "No output available." }],
                details: { taskId, status: "completed", result: task.result },
              };
            case "failed":
              return throwToolError("conflict", `Background task failed: ${task.error ?? "unknown error"}`, {
                hint: "Inspect the task details and retry the underlying operation when appropriate",
              });
            case "cancelled":
              return {
                content: [{ type: "text", text: "Task was cancelled." }],
                details: { taskId, status: "cancelled" },
              };
            default:
              return {
                content: [{ type: "text", text: `Task has unexpected status: ${task.status}` }],
                details: { taskId, status: task.status },
              };
          }
        }
      }
    },
  };
}
