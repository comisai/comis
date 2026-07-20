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
import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundTaskOrigin } from "./background-task-types.js";

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
 * `originResolver` is called synchronously at promote-time (before the agent
 * yields) so the captured origin reflects the originating session, not the
 * background continuation context. Returns undefined when the wrap-site cannot
 * resolve a valid origin (e.g., during a non-session-bound subagent path) --
 * in that case the wrapper falls through to foreground execution (no promote).
 *
 * Explicit threading, NOT AsyncLocalStorage. Origin flows through factory
 * params end-to-end.
 *
 * If the tool is in `config.excludeTools`, returns unchanged.
 * If the tool completes before `config.autoBackgroundMs`, returns the result directly.
 * If the tool exceeds the timeout, promotes to background via manager.promote().
 * If promotion fails (concurrency limit), awaits the tool normally (foreground fallback).
 */
/**
 * Tools that must NEVER be auto-background-promoted, regardless of
 * `config.excludeTools` (structural exclusions, the `exec` class):
 *
 *   - `background_tasks` — the META tool that lists/reads/waits on background
 *     tasks. Its `read_output` on a pending task deliberately waits for the
 *     original promise, so promoting that observer would be structurally
 *     self-referential.
 *   - `sleep` — the WAIT tool. The model sleeps to await a backgrounded result;
 *     the sleep itself hits `autoBackgroundMs`, promotes, and its raw
 *     'Background task "sleep" completed.' notice leaked to the user (live
 *     incident, 2026-07-08). Backgrounding a wait is self-defeating: the stub
 *     returns instantly (defeating the wait) and the completion is pure noise.
 *   - `image_generate` / `video_generate` — self-delivering media tools. They
 *     deliver out-of-band via the media pipeline (`image.delivered` fires
 *     independent of the wrapper — verified live), so the "backgrounded"
 *     placeholder buys NO delivery and only tricks the model into polling for
 *     an already-in-flight result. Excluded so the turn awaits the tool inline
 *     and delivers once, cleanly.
 *
 * `exec` is excluded separately (below) for a DIFFERENT reason — it owns its
 * own escalation path, so the generic wrapper would double-promote.
 */
const NEVER_AUTO_BACKGROUND_TOOLS: ReadonlySet<string> = new Set([
  "background_tasks",
  "sleep",
  "image_generate",
  "video_generate",
]);

export function wrapToolForAutoBackground(
  tool: ToolDefinition,
  manager: BackgroundTaskManager,
  config: BackgroundTasksConfig,
  originResolver: () => BackgroundTaskOrigin | undefined,
): ToolDefinition {
  // `exec` opts out of the generic auto-background wrapper to enforce
  // single-owner backgrounding. The exec-tool's own internal escalation path
  // (packages/skills/src/builtin/exec-tool.ts:613-668) is the SOLE
  // backgrounding owner for `exec`; the generic timeout-based wrapper would
  // double-promote. Hardcoded literal — does NOT modify config.excludeTools
  // so operator-set exclusions remain unchanged.
  if (tool.name === "exec") {
    return tool;
  }
  // Structural never-background tools (the background-task meta tool + the
  // self-delivering media tools) — see NEVER_AUTO_BACKGROUND_TOOLS. Like exec,
  // this is independent of config.excludeTools (operator exclusions untouched).
  if (NEVER_AUTO_BACKGROUND_TOOLS.has(tool.name)) {
    return tool;
  }
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
        const timer = systemSetTimeout(() => resolve("timeout"), config.autoBackgroundMs);
        // Clean up timer if tool finishes first (prevents leak)
        taskPromise.then(
          () => systemClearTimeout(timer),
          () => systemClearTimeout(timer),
        );
      });

      const raceResult = await Promise.race([
        taskPromise.then((value) => ({ kind: "result" as const, value })),
        timeoutPromise.then(() => ({ kind: "timeout" as const })),
      ]);

      if (raceResult.kind === "result") {
        return raceResult.value;
      }

      // Timeout: resolve origin synchronously before yielding to the background.
      // Explicit threading, NOT AsyncLocalStorage.
      const origin = originResolver();
      if (!origin) {
        // No originating session context (e.g., wrap-site is a subagent without
        // a captured caller session). Treat like a concurrency-limit fallback:
        // run the tool in the foreground, no background promotion.
        return await taskPromise;
      }

      const promoteResult = manager.promote(tool.name, taskPromise, ac, origin);
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
          (result) => manager.complete(taskId, result),
          (error) => manager.fail(taskId, error),
        ),
        "background task completion handler",
      );

      // Return a well-formed AgentToolResult so the SDK's emitToolCallOutcome
      // produces a non-empty toolResult message. Returning a string here
      // collapses to `content: undefined` and triggers the silent-LLM-failure
      // cascade (see AGENTS.md / auto-background-middleware.test.ts invariant).
      const placeholderText =
        `Tool "${tool.name}" is taking longer than expected and has been moved to the background. ` +
        `Task ID: ${taskId}. Call background_tasks once with action "read_output" and taskId "${taskId}"; ` +
        `that call waits for the result. Do not call "${tool.name}" again or sleep. Use only the returned task ` +
        `output; do not finalize from or substitute unrelated earlier data.`;
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
