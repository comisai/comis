// SPDX-License-Identifier: Apache-2.0
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
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { BackgroundTaskManager, NotifyFn } from "./background-task-manager.js";

/**
 * Tool definition interface matching pi-agent-core ToolDefinition.
 *
 * `execute` MUST return `AgentToolResult<unknown>` (`{ content, details }`). A
 * raw string or plain object silently becomes `{ content: undefined }` inside
 * the SDK's emitToolCallOutcome, producing an empty toolResult message that
 * breaks the tool_use/tool_result pairing and triggers the silent-LLM-failure
 * cascade.
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
  ): Promise<AgentToolResult<unknown>>;
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

      // Gate onUpdate: once the task is promoted to the background, the agent
      // advances and its run ends (activeRun cleared), but the subprocess can
      // keep emitting data. Calling the original onUpdate then lands in
      // Agent.processEvents with no active run -> unhandled rejection.
      let onUpdateActive = true;
      const gatedOnUpdate = onUpdate
        ? (text: string) => { if (onUpdateActive) onUpdate(text); }
        : undefined;

      // Start the real tool execution (uses snapshot, not tool.execute)
      const taskPromise = origExecute(toolCallId, params, ac.signal, gatedOnUpdate, ctx);

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

      // Promotion succeeded: sever onUpdate before the agent moves on.
      onUpdateActive = false;

      const taskId = promoteResult.value;

      // Wire completion/failure handlers (fire-and-forget)
      suppressError(
        taskPromise.then(
          (result) => manager.complete(taskId, result, notifyFn),
          (error) => manager.fail(taskId, error, notifyFn),
        ),
        "background task completion handler",
      );

      // Return a well-formed AgentToolResult so the SDK's emitToolCallOutcome
      // produces a non-empty toolResult message. Returning a string here
      // collapses to `content: undefined` and triggers the silent-LLM-failure
      // cascade (see AGENTS.md / auto-background-middleware.test.ts invariant).
      const placeholderText =
        `Tool "${tool.name}" is taking longer than expected and has been moved to the background. ` +
        `Task ID: ${taskId}. The user will be notified when it completes.`;
      return {
        content: [{ type: "text" as const, text: placeholderText }],
        details: {
          status: "backgrounded" as const,
          taskId,
          toolName: tool.name,
        },
      };
    },
  };
}
