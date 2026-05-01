// SPDX-License-Identifier: Apache-2.0
/**
 * Tool audit wrapper: Wraps any AgentTool to emit timing and success/failure
 * events via the TypedEventBus.
 *
 * Every tool invocation emits a `tool:executed` event with toolName, durationMs,
 * and success boolean. Duration is measured inside execute() (not at wrap time)
 * to accurately reflect actual execution time.
 *
 * @module
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TypedEventBus } from "@comis/core";
import { tryGetContext } from "@comis/core";

/**
 * Wrap an AgentTool with audit event emission.
 *
 * The returned tool behaves identically to the original, but emits a
 * `tool:executed` event on the provided eventBus after every execution
 * (whether successful or failed).
 *
 * @param tool - The AgentTool to wrap
 * @param eventBus - The TypedEventBus to emit events on
 * @param agentId - Optional agent ID to include in audit events
 * @returns A new AgentTool with audit instrumentation
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
export function wrapWithAudit(tool: AgentTool<any>, eventBus: TypedEventBus, agentId?: string): AgentTool<any> {
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult generic per pi-agent-core API
    ): Promise<AgentToolResult<any>> {
      const startMs = performance.now();
      let success = true;
      let errorMessage: string | undefined;
      let errorKind: string | undefined;

      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);

        // Detect non-zero exit codes from tools that never throw (e.g., exec tool).
        // These tools return { details: { exitCode: number } } via jsonResult().
        const details = result?.details as Record<string, unknown> | undefined;
        if (
          details &&
          typeof details.exitCode === "number" &&
          details.exitCode !== 0
        ) {
          success = false;
          errorKind = "nonzero-exit";
        }

        return result;
      } catch (error: unknown) {
        success = false;
        errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
        // Read errorKind from error property if present (e.g., validation errors from enforcement wrapper)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- errorKind propagation from enforcement wrapper
        if (error instanceof Error && typeof (error as any).errorKind === "string") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- errorKind propagation
          errorKind = (error as any).errorKind;
        }
        errorKind ??= signal?.aborted ? "timeout" : "internal";
        throw error;
      } finally {
        const durationMs = performance.now() - startMs;
        const ctx = tryGetContext();

        eventBus.emit("tool:executed", {
          toolName: tool.name,
          durationMs,
          success,
          timestamp: Date.now(),
          userId: ctx?.userId,
          traceId: ctx?.traceId,
          agentId,
          sessionKey: ctx?.sessionKey,
          params: params as Record<string, unknown> | undefined,
          ...(errorMessage !== undefined && { errorMessage }),
          ...(errorKind !== undefined && { errorKind }),
        });
      }
    },
  };
}
