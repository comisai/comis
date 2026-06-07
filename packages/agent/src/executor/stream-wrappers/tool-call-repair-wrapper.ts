// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-call repair stream wrapper.
 *
 * Intercepts AssistantMessage items in the context where ToolCall arguments
 * arrive as a raw JSON string (when the provider/SDK passes through unparsed
 * argument text) and attempts shape-only repair via repairToolCallJSON before
 * the message reaches the tool executor.
 *
 * Also intercepts ToolResultMessage items with isError===true that contain
 * an "irreparable tool-call JSON" error indicator and reformats them with a
 * "Validation failed" prefix so the PARAMETER_VALIDATION_TAGS carve-out in
 * tool-retry-breaker.ts prevents a breaker trip.
 *
 * S3 INVARIANT: repair is shape-only. Repaired args flow through the EXISTING
 * downstream exec-security gates (validateExecCommand for exec tools) — those
 * gates are the final authority on scope for ALL tool types.
 *
 * Placement: BEFORE validationErrorFormatter in the stream wrapper chain
 * (executor-stream-setup.ts wrappers array). When repair succeeds, the
 * corrected message continues normally. When repair fails ("irreparable"),
 * the wrapper converts the offending ToolCall to a synthetic toolResult error
 * with a "Validation failed: ..." prefix so the PARAMETER_VALIDATION_TAGS
 * carve-out prevents a breaker trip.
 *
 * @module
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message, AssistantMessage, ToolResultMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ComisLogger, ErrorKind } from "@comis/core";
import type { StreamFnWrapper } from "./types.js";
import type { ModelProfile } from "../model-profile.js";
import { repairToolCallJSON } from "../tool-call-repair.js";

/**
 * Create a stream wrapper that attempts shape-only repair of malformed tool-call
 * JSON arguments BEFORE the existing validationErrorFormatter sees the messages.
 *
 * When a ToolCall's arguments field arrives as a raw JSON string (runtime value
 * is a string despite being typed as Record<string, any>), this wrapper:
 * - Attempts structural repair via repairToolCallJSON
 * - On success: replaces the string with the parsed object (value-preserving)
 * - On failure: converts the ToolCall into a synthetic ToolResultMessage error
 *   with a "Validation failed" prefix → PARAMETER_VALIDATION_TAGS carve-out →
 *   no breaker trip
 *
 * @param modelProfile - ModelProfile for the current execution (supportsStructuredOutput flag)
 * @param logger - Logger for debug/warn output
 */
export function createToolCallRepairWrapper(
  modelProfile: ModelProfile,
  logger: ComisLogger,
): StreamFnWrapper {
  return function toolCallRepairWrapper(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const repairedMessages: Message[] = [];

      for (const msg of context.messages) {
        // Only inspect AssistantMessage items — ToolCall content lives here
        if (msg.role !== "assistant") {
          repairedMessages.push(msg);
          continue;
        }

        const assistantMsg = msg as AssistantMessage;
        let modified = false;
        const syntheticErrors: ToolResultMessage[] = [];

        const repairedContent: AssistantMessage["content"] = assistantMsg.content.map((block) => {
          // Only process ToolCall blocks
          if (block.type !== "toolCall") return block;

          const toolCall = block as ToolCall;
          const rawArgs = toolCall.arguments;

          // If arguments is already a parsed object (the normal case), pass through unchanged
          if (typeof rawArgs !== "string") return block;

          // Arguments arrived as a raw JSON string — attempt shape-only repair
          const repairResult = repairToolCallJSON(rawArgs, modelProfile);

          if (repairResult.ok) {
            logger.debug(
              {
                submodule: "tool-call-repair-wrapper",
                toolName: toolCall.name,
              },
              "Tool-call JSON shape repaired",
            );
            modified = true;
            // Return the ToolCall with repaired (parsed) args; value-preserving
            return { ...toolCall, arguments: repairResult.value as Record<string, unknown> };
          }

          // Irreparable — produce a synthetic ToolResultMessage error so the
          // validationErrorFormatter and breaker carve-out see a well-formed error.
          // "Validation failed" prefix → extractErrorTag → "validation_failed"
          // → PARAMETER_VALIDATION_TAGS carve-out → no breaker increment.
          logger.warn(
            {
              submodule: "tool-call-repair-wrapper",
              toolName: toolCall.name,
              errorKind: "tool_error" as ErrorKind,
              hint: "Model emitted irreparable tool-call JSON; returning validation_failed",
            },
            "Irreparable tool-call JSON — shape repair failed",
          );

          modified = true;
          // Synthesize a toolResult error for this tool call
          const syntheticError: ToolResultMessage = {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            isError: true,
            content: [
              {
                type: "text",
                text: "Validation failed: tool arguments are not valid JSON and could not be repaired. Please emit valid JSON.",
              },
            ],
            // Synthetic error message — timestamp is a sentinel; the message is transient
            // and not persisted to the session store. Using the parent message timestamp
            // ensures causal ordering without requiring a clock port injection.
            timestamp: assistantMsg.timestamp ?? 0,
          };
          syntheticErrors.push(syntheticError);

          // Return the original block unchanged (the synthetic error is added separately)
          return block;
        });

        if (modified) {
          repairedMessages.push({ ...assistantMsg, content: repairedContent });
          // Append synthetic error results after the assistant message
          for (const synthErr of syntheticErrors) {
            repairedMessages.push(synthErr);
          }
        } else {
          repairedMessages.push(msg);
        }
      }

      return next(model, { ...context, messages: repairedMessages }, options);
    };
  };
}
