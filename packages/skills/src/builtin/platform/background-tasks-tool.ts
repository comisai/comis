/**
 * Background tasks management tool: multi-action tool for agent-scoped task management.
 *
 * Supports 4 actions: list, get, cancel, read_output.
 * Any user can check their own background tasks (not admin-gated).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { Result } from "@comis/shared";
import { readStringParam, readEnumParam } from "./tool-helpers.js";

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
  agentId: string;
  toolName: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

/** Subset of BackgroundTaskManager consumed by this tool. */
export interface BackgroundTaskManagerLike {
  getTask(taskId: string): TaskInfo | undefined;
  getTasks(agentId: string): TaskInfo[];
  cancel(taskId: string): Result<void, Error>;
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
        "read_output: read the output of a completed task.",
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
 * - **read_output** -- Read the output of a completed background task
 *
 * @param deps - Dependencies: BackgroundTaskManager and agentId
 * @returns AgentTool implementing the background tasks management interface
 */
export function createBackgroundTasksTool(deps: {
  manager: BackgroundTaskManagerLike;
  agentId: string;
}): AgentTool<typeof BackgroundTasksToolParams> {
  return {
    name: "background_tasks",
    label: "Background Tasks",
    description:
      "Manage background tasks. Long-running tool executions are automatically promoted " +
      "to background. Use this tool to check status, read output, or cancel tasks.",
    parameters: BackgroundTasksToolParams,

    async execute(
      _toolCallId: string,
      params: BackgroundTasksToolParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const p = params as unknown as Record<string, unknown>;
      const action = readEnumParam(p, "action", VALID_ACTIONS);

      switch (action) {
        case "list": {
          const tasks = deps.manager.getTasks(deps.agentId).map((t: TaskInfo) => ({
            id: t.id,
            toolName: t.toolName,
            status: t.status,
            startedAt: new Date(t.startedAt).toISOString(),
            completedAt: t.completedAt
              ? new Date(t.completedAt).toISOString()
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
          if (!task || task.agentId !== deps.agentId) {
            return {
              content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
              details: null,
            };
          }
          const details = {
            id: task.id,
            toolName: task.toolName,
            status: task.status,
            startedAt: new Date(task.startedAt).toISOString(),
            completedAt: task.completedAt
              ? new Date(task.completedAt).toISOString()
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
          if (!task || task.agentId !== deps.agentId) {
            return {
              content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
              details: null,
            };
          }
          const cancelResult = deps.manager.cancel(taskId!);
          if (!cancelResult.ok) {
            return {
              content: [{ type: "text", text: `Error: ${cancelResult.error.message}` }],
              details: null,
            };
          }
          return {
            content: [{ type: "text", text: `Task ${taskId} cancelled successfully.` }],
            details: { taskId, cancelled: true },
          };
        }

        case "read_output": {
          const taskId = readStringParam(p, "taskId");
          const task = deps.manager.getTask(taskId!);
          if (!task || task.agentId !== deps.agentId) {
            return {
              content: [{ type: "text", text: `Error: Task not found: ${taskId}` }],
              details: null,
            };
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
              return {
                content: [{ type: "text", text: `Task failed: ${task.error}` }],
                details: { taskId, status: "failed", error: task.error },
              };
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
