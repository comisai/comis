// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
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

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TypedEventBus, ErrorKind } from "@comis/core";
import { systemNowMs, tryGetContext, redactValue } from "@comis/core";

/** The closed ErrorKind union (log-fields.ts) as a runtime Set for narrowing
 *  the loosely-typed errorKind propagated off thrown error objects. */
const ERROR_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "config",
  "network",
  "auth",
  "validation",
  "precondition",
  "timeout",
  "resource",
  "dependency",
  "internal",
  "platform",
]);

function asErrorKind(value: unknown): ErrorKind | undefined {
  return typeof value === "string" && ERROR_KINDS.has(value as ErrorKind)
    ? (value as ErrorKind)
    : undefined;
}

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
 * @param homeDir - Optional operator `$HOME` for `$HOME`→`~` path
 *   compaction of the redacted params. When supplied, absolute home
 *   paths in `tool:executed.params` compact to `~` for all bus consumers; when
 *   omitted, secret/PII/absolute-path masking still applies (only home-prefix
 *   compaction is skipped).
 * @returns A new AgentTool with audit instrumentation
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
export function wrapWithAudit(tool: AgentTool<any>, eventBus: TypedEventBus, agentId?: string, homeDir?: string): AgentTool<any> {
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
      let errorKind: ErrorKind | undefined;

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
          // A non-zero exit code is NOT a member of the closed ErrorKind union.
          // Map it to "dependency" so downstream closed-union
          // switches + activity classification stay exhaustive. Matches the
          // pi-event-bridge.ts exitCode branch.
          errorKind = "dependency";
        }

        // Detect RPC FAILURE ENVELOPES from tools that never throw (the media/
        // messaging RPC-dispatch tools): a failed call returns
        // jsonResult({ success:false, error }) — the envelope rides
        // result.details. Without this branch the audit logged
        // "Tool audit: image_generate succeeded (120023ms)" for a timed-out
        // generation — a false success on the obs lens (live incident). The
        // envelope's errorKind (when a closed-union member) and error string ride
        // the event; a success:true envelope stays the success path.
        if (details && details.success === false) {
          success = false;
          errorKind ??= asErrorKind(details.errorKind);
          if (errorMessage === undefined && typeof details.error === "string" && details.error.length > 0) {
            errorMessage = details.error.slice(0, 1500);
          }
        }

        return result;
      } catch (error: unknown) {
        success = false;
        errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
        // Read errorKind from error property if present (e.g., validation errors
        // from enforcement wrapper), narrowed to the closed ErrorKind union so
        // the tool:executed payload only ever carries a valid member.
        if (error instanceof Error) {
          errorKind = asErrorKind((error as { errorKind?: unknown }).errorKind);
        }
        errorKind ??= signal?.aborted ? "timeout" : "internal";
        throw error;
      } finally {
        const durationMs = performance.now() - startMs;
        const ctx = tryGetContext();

        // Redact params BEFORE the emit
        // crosses the bus. This closes the documented leak where raw tool
        // params (secrets, message bodies, absolute paths) were forwarded
        // verbatim. `redactValue` is the only sanctioned path. When the caller
        // threads `homeDir`, $HOME paths also compact to `~` for all
        // consumers; otherwise secret/PII/absolute-path masking still applies.
        const redactedParams = redactValue(params, { homeDir }).value as
          | Record<string, unknown>
          | undefined;

        eventBus.emit("tool:executed", {
          toolName: tool.name,
          toolCallId,
          durationMs,
          success,
          timestamp: systemNowMs(),
          userId: ctx?.userId,
          traceId: ctx?.traceId,
          agentId,
          sessionKey: ctx?.sessionKey,
          params: redactedParams,
          ...(errorMessage !== undefined && { errorMessage }),
          ...(errorKind !== undefined && { errorKind }),
        });
      }
    },
  };
}
