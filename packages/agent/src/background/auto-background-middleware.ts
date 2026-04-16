/**
 * Auto-background middleware: wraps tool execute() with Promise.race timeout.
 *
 * When a tool call exceeds `config.autoBackgroundMs`, it is promoted to a
 * background task via BackgroundTaskManager. The tool returns a JSON placeholder
 * with the task ID so the agent can inform the user.
 *
 * @module
 */
import { suppressError } from "@comis/shared";
import type { BackgroundTasksConfig } from "@comis/core";
import type { BackgroundTaskManager, NotifyFn } from "./background-task-manager.js";

/**
 * Tool definition interface matching pi-agent-core ToolDefinition.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((text: string) => void) | undefined,
    ctx: unknown,
  ): Promise<unknown>;
}

/**
 * Wrap a tool's execute() with auto-background promotion on timeout.
 *
 * If the tool is in `config.excludeTools`, returns unchanged.
 * If the tool completes before `config.autoBackgroundMs`, returns the result directly.
 * If the tool exceeds the timeout, promotes to background via manager.promote().
 * If promotion fails (concurrency limit), awaits the tool normally (foreground fallback).
 */
export function wrapToolForAutoBackground(
  tool: ToolDefinition,
  manager: BackgroundTaskManager,
  config: BackgroundTasksConfig,
  notifyFn: NotifyFn,
  agentId: string,
): ToolDefinition {
  if (config.excludeTools.includes(tool.name)) {
    return tool;
  }

  // Snapshot the original execute at wrap-time. pi-executor mutates tool.execute
  // in-place (line 1172) to point to the wrapper itself. Without this snapshot,
  // tool.execute(...) would call the wrapper recursively -> stack overflow.
  const origExecute = tool.execute.bind(tool);

  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Create child AbortController linked to parent signal
      const ac = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => ac.abort(), { once: true });
      }

      // Start the real tool execution (uses snapshot, not tool.execute)
      const taskPromise = origExecute(toolCallId, params, ac.signal, onUpdate, ctx);

      // Race: tool result vs. timeout
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), config.autoBackgroundMs);
        // Clean up timer if tool finishes first (prevents leak)
        taskPromise.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      });

      const raceResult = await Promise.race([
        taskPromise.then((value) => ({ kind: "result" as const, value })),
        timeoutPromise.then(() => ({ kind: "timeout" as const })),
      ]);

      if (raceResult.kind === "result") {
        return raceResult.value;
      }

      // Timeout: attempt background promotion
      const promoteResult = manager.promote(agentId, tool.name, taskPromise, ac);
      if (!promoteResult.ok) {
        // Concurrency limit hit: fall back to foreground (await normally)
        return await taskPromise;
      }

      const taskId = promoteResult.value;

      // Wire completion/failure handlers (fire-and-forget)
      suppressError(
        taskPromise.then(
          (result) => manager.complete(taskId, result, notifyFn),
          (error) => manager.fail(taskId, error, notifyFn),
        ),
        "background task completion handler",
      );

      // Return placeholder to agent
      return JSON.stringify({
        status: "backgrounded",
        taskId,
        toolName: tool.name,
        message: `Tool "${tool.name}" is taking longer than expected and has been moved to the background. Task ID: ${taskId}. The user will be notified when it completes.`,
      });
    },
  };
}
