// SPDX-License-Identifier: Apache-2.0
/**
 * Background tasks management tool: multi-action tool for agent-scoped task management.
 *
 * Supports 4 actions: list, get, cancel, read_output.
 * Any user can check their own background tasks (not admin-gated).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { Result } from "@comis/shared";
import { readStringParam, readEnumParam, throwToolError } from "../tool-helpers.js";
import { systemDateFrom } from "@comis/core";

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

function taskAgentId(task: TaskInfo): string {
  return task.origin.turnScope.conversation.agentId;
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
        "Task management action. list: show all tasks for this agent. " +
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
 * - **list** -- List all background tasks for the current agent
 * - **get** -- Get details of a specific task by ID
 * - **cancel** -- Cancel a running background task
 * - **read_output** -- Wait for a running task and read its completed output
 *
 * @param deps - Dependencies: BackgroundTaskManager and agentId
 * @returns AgentTool implementing the background tasks management interface
 */
export function createBackgroundTasksTool(deps: {
  manager: BackgroundTaskManagerLike;
  agentId: string;
  /** Derived from the owning agent's prompt stall budget. */
  waitHeartbeatMs?: number;
}): AgentTool<typeof BackgroundTasksToolParams> {
  return {
    name: "background_tasks",
    label: "Background Tasks",
    description:
      "Manage background tasks. Long-running tool executions are automatically promoted " +
      "to background. Use read_output once to wait for and consume a promoted task result; use the other actions to check status or cancel tasks.",
    parameters: BackgroundTasksToolParams,

    async execute(
      _toolCallId: string,
      params: BackgroundTasksToolParamsType,
      _signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    ): Promise<AgentToolResult<unknown>> {
      const p = params as unknown as Record<string, unknown>;
      const action = readEnumParam(p, "action", VALID_ACTIONS);

      switch (action) {
        case "list": {
          const tasks = deps.manager.getTasks(deps.agentId).map((t: TaskInfo) => ({
            id: t.id,
            toolName: t.toolName,
            status: t.status,
            startedAt: systemDateFrom(t.startedAt).toISOString(),
            completedAt: t.completedAt
              ? systemDateFrom(t.completedAt).toISOString()
              : undefined,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(tasks) }],
            details: tasks,
          };
        }

        case "get": {
          const taskId = readStringParam(p, "taskId");
          const task = deps.manager.getTask(taskId!);
          if (!task || taskAgentId(task) !== deps.agentId) {
            throwToolError("not_found", `Background task not found: ${taskId}`, {
              hint: "Call background_tasks with action=list to obtain a task ID owned by this agent",
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
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
          };
        }

        case "cancel": {
          const taskId = readStringParam(p, "taskId");
          const task = deps.manager.getTask(taskId!);
          if (!task || taskAgentId(task) !== deps.agentId) {
            throwToolError("not_found", `Background task not found: ${taskId}`, {
              hint: "Call background_tasks with action=list to obtain a task ID owned by this agent",
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
          if (!task || taskAgentId(task) !== deps.agentId) {
            throwToolError("not_found", `Background task not found: ${taskId}`, {
              hint: "Call background_tasks with action=list to obtain a task ID owned by this agent",
            });
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
