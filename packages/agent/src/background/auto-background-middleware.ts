// SPDX-License-Identifier: Apache-2.0
// @allow-throw: AgentTool boundary; pi-agent-core converts rejected admission into a failed tool result.
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
import { BackgroundTaskOriginSchema, tryGetContext } from "@comis/core";
import type { BackgroundTasksConfig, SystemTimeoutHandle, TypedEventBus } from "@comis/core";
import { systemSetTimeout, systemClearTimeout } from "@comis/core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundTaskOrigin } from "./background-task-types.js";
import { backgroundToolLabel } from "./background-tool-label.js";
import { pauseDuringCorrelatedApprovals } from "../approval-timeout-pause.js";

interface PromotionTimeoutControl {
  readonly promise: Promise<"timeout">;
  pauseTimer(): void;
  resumeTimer(): void;
  cancel(): void;
}

/** Auto-background deadline with approval-aware pause/resume controls. */
function createPromotionTimeout(timeoutMs: number): PromotionTimeoutControl {
  let settled = false;
  let paused = false;
  let timer: SystemTimeoutHandle | undefined;
  let resolveTimeout: (value: "timeout") => void;

  function startTimer(): void {
    if (settled || paused) return;
    if (timer !== undefined) systemClearTimeout(timer);
    timer = systemSetTimeout(() => {
      if (settled || paused) return;
      settled = true;
      resolveTimeout("timeout");
    }, timeoutMs);
    timer.unref();
  }

  const promise = new Promise<"timeout">((resolve) => {
    resolveTimeout = resolve;
    startTimer();
  });
  return {
    promise,
    pauseTimer() {
      if (settled || paused) return;
      paused = true;
      if (timer !== undefined) systemClearTimeout(timer);
      timer = undefined;
    },
    resumeTimer() {
      if (settled || !paused) return;
      paused = false;
      startTimer();
    },
    cancel() {
      if (settled) return;
      settled = true;
      if (timer !== undefined) systemClearTimeout(timer);
      timer = undefined;
    },
  };
}

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
 * If promotion fails, aborts the unowned execution and surfaces the admission failure.
 */
/**
 * Tools that must NEVER be auto-background-promoted, regardless of
 * `config.excludeTools` (structural exclusions, the `exec` class):
 *
 *   - `background_tasks` — the META tool that lists/reads/waits on background
 *     tasks. Its `read_output` on a pending task deliberately waits for the
 *     original promise, so promoting that observer would be structurally
 *     self-referential.
 *   - `subagents` — the lifecycle observer whose `wait` action already blocks
 *     for child terminal state. Promoting it duplicates the child completion
 *     route and turns `list` follow-ups into extra user notifications.
 *   - `sleep` — the WAIT tool. The model sleeps to await a backgrounded result;
 *     the sleep itself hits `autoBackgroundMs`, promotes, and its raw
 *     'Background task "sleep" completed.' notice leaked to the user (live
 *     incident, 2026-07-08). Backgrounding a wait is self-defeating: the stub
 *     returns instantly (defeating the wait) and the completion is pure noise.
 *   - `discover_tools` — the DISCOVERY tool. The cold long-tail of tools is
 *     deferred behind it, so a deferred tool becomes callable only if discovery
 *     returns within the turn. A discovery call measured 10101ms — 101ms over
 *     the threshold — promoted, its result was replaced by the instant stub, and
 *     the real result arrived as a notification after the turn had answered. The
 *     turn told the user a scheduling tool was "not currently callable" while it
 *     was enabled, capability-granted and registered. Backgrounding a discovery
 *     is self-defeating exactly as backgrounding a wait is: the stub returns
 *     instantly, so the tools it exists to surface are absent from the one turn
 *     that needed them.
 *   - `image_generate` / `video_generate` — self-delivering media tools. They
 *     deliver out-of-band via the media pipeline (`image.delivered` fires
 *     independent of the wrapper — verified live), so the "backgrounded"
 *     placeholder buys NO delivery and only tricks the model into polling for
 *     an already-in-flight result. Excluded so the turn awaits the tool inline
 *     and delivers once, cleanly.
 *   - `tokens_manage` — create/rotate return a credential exactly once. Moving
 *     the approval wait into a durable background task would persist that
 *     credential in the task result and completion re-entry before it reaches
 *     the authenticated caller.
 *
 * `exec` is excluded separately (below) for a DIFFERENT reason — it owns its
 * own escalation path, so the generic wrapper would double-promote.
 */
const NEVER_AUTO_BACKGROUND_TOOLS: ReadonlySet<string> = new Set([
  "background_tasks",
  "subagents",
  "sleep",
  "image_generate",
  "video_generate",
  "discover_tools",
  "tokens_manage",
]);

export function wrapToolForAutoBackground(
  tool: ToolDefinition,
  manager: BackgroundTaskManager,
  config: BackgroundTasksConfig,
  originResolver: () => BackgroundTaskOrigin | undefined,
  onPromoted?: () => void,
  approvalEventBus?: TypedEventBus,
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

      const promotionTimeout = createPromotionTimeout(config.autoBackgroundMs);
      const turnContext = tryGetContext();
      const stopApprovalTracking = approvalEventBus === undefined
        ? () => {}
        : pauseDuringCorrelatedApprovals(approvalEventBus, promotionTimeout, {
            agentId: turnContext?.agentId,
            sessionKey: turnContext?.sessionKey,
            traceId: turnContext?.traceId,
          });

      // Defer invocation by one microtask so the approval listeners are active
      // before an approval-gated tool can synchronously publish its request.
      const taskPromise = Promise.resolve().then(
        () => origExecute(toolCallId, params, ac.signal, gatedOnUpdate, ctx),
      );

      const raceResult = await Promise.race([
        taskPromise.then((value) => ({ kind: "result" as const, value })),
        promotionTimeout.promise.then(() => ({ kind: "timeout" as const })),
      ]).finally(() => {
        promotionTimeout.cancel();
        stopApprovalTracking();
      });

      if (raceResult.kind === "result") {
        return raceResult.value;
      }

      // Timeout: resolve origin synchronously before yielding to the background.
      // Explicit threading, NOT AsyncLocalStorage.
      const origin = BackgroundTaskOriginSchema.safeParse(originResolver());
      if (!origin.success) {
        // No bindable originating session context. This includes nested work
        // whose internal child turn and external delivery route intentionally
        // differ. Keep the tool foreground rather than creating an unrouteable
        // task or weakening the structured-origin security invariant.
        return await taskPromise;
      }

      // Ids-only correlation so the TERMINAL background event can close the
      // activity card this tool call opened (the card is keyed on the
      // toolCallId; without it a backgrounded tool's lifecycle was closed
      // "completed" at hand-off and the real outcome never reached the card).
      const turnCtx = tryGetContext();
      const promoteResult = manager.promote(tool.name, taskPromise, ac, origin.data, undefined, {
        toolCallId,
        ...(turnCtx?.sessionKey !== undefined ? { sessionKey: turnCtx.sessionKey } : {}),
        ...(turnCtx?.traceId !== undefined ? { traceId: turnCtx.traceId } : {}),
      });
      if (!promoteResult.ok) {
        // Admission owns the concurrency contract. Continuing the untracked
        // execution in the foreground would defeat the configured bound and
        // eventually misreport a prompt timeout. Attach the rejection handler
        // before aborting so a cooperative tool cannot create an unhandled
        // rejection, then fail this AgentTool call with the manager's exact
        // binding knob and occupancy.
        onUpdateActive = false;
        suppressError(taskPromise, "auto-background rejected-admission cleanup");
        ac.abort();
        throw promoteResult.error;
      }

      onPromoted?.();

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
      const toolLabel = backgroundToolLabel(tool.name);
      const placeholderText =
        `Tool "${toolLabel}" is taking longer than expected and has been moved to the background. ` +
        `Task ID: ${taskId}. Automatic completion re-entry will resume this conversation with the result. ` +
        `Do not call background_tasks or sleep to poll it; end this turn now without finalizing an answer or ` +
        `substituting unrelated earlier data.`;
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
