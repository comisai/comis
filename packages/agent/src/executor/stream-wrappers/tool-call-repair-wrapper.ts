// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-call repair stream wrapper.
 *
 * Repairs both directions of the provider boundary:
 * - outgoing history containing raw JSON-string tool arguments is normalized
 *   before the next model request;
 * - incoming assistant events whose selected tool rejects an `action` that
 *   exactly one other visible tool owns are renamed before SDK validation.
 *
 * When repair fails ("irreparable"), the wrapper injects a synthetic
 * ToolResultMessage with a "Validation failed: ..." prefix into the outgoing
 * context so the MODEL sees a well-formed error and self-corrects by re-emitting
 * valid JSON on its next turn.
 *
 * This synthetic toolResult does NOT interact with ToolRetryBreaker.
 * The breaker's counters are driven exclusively by real tool-execution events
 * in pi-event-bridge.ts (ToolRetryBreaker.recordResult), not by messages a
 * StreamFn wrapper injects into context.messages. Moreover, unparseable args
 * fail BEFORE any tool executes, so no tool-execution event is emitted and the
 * breaker is never involved on this path at all. The "Validation failed" prefix
 * exists only to give the model a clean, recognizable self-correction nudge — it
 * is not a PARAMETER_VALIDATION_TAGS breaker carve-out (there is nothing to
 * carve out, because the breaker never sees this turn).
 *
 * INVARIANT: arguments are never invented or broadened. Shape repair preserves
 * values. Selection repair changes only the tool name and only on one unique,
 * fully validating action-schema match. The destination tool's existing trust,
 * approval, validation, and execution gates remain authoritative.
 *
 * Placement: BEFORE validationErrorFormatter in the stream wrapper chain
 * (executor-stream-setup.ts wrappers array). When repair succeeds, the
 * corrected message continues normally.
 *
 * @module
 */

import { parseStreamingJson, validateToolArguments } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Message,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolResultMessage,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { ComisLogger, ErrorKind } from "@comis/core";
import type { StreamFnWrapper } from "./types.js";
import type { ModelProfile } from "../model-profile.js";

interface DispatchTool {
  name: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
}

interface SelectionRepair {
  fromTool: string;
  toTool: string;
  action: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionSchemaAllows(schema: unknown, action: string): boolean {
  if (!isRecord(schema)) return false;
  if (schema.const === action) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(action)) return true;

  for (const branches of [schema.anyOf, schema.oneOf]) {
    if (
      Array.isArray(branches)
      && branches.some((branch) => actionSchemaAllows(branch, action))
    ) {
      return true;
    }
  }
  return false;
}

function explicitActionSchema(tool: DispatchTool): unknown {
  if (!isRecord(tool.parameters)) return undefined;
  const properties = tool.parameters.properties;
  if (!isRecord(properties)) return undefined;
  return properties.action;
}

function acceptsToolCall(tool: DispatchTool, toolCall: ToolCall): boolean {
  try {
    const preparedArguments = tool.prepareArguments
      ? tool.prepareArguments(toolCall.arguments)
      : toolCall.arguments;
    if (!isRecord(preparedArguments)) return false;
    validateToolArguments(
      tool as Parameters<typeof validateToolArguments>[0],
      { ...toolCall, name: tool.name, arguments: preparedArguments },
    );
    return true;
  } catch {
    // SDK validation is a throwing boundary; selection repair translates it
    // immediately into a boolean candidate verdict.
    return false;
  }
}

function findUniqueActionOwner(
  tools: DispatchTool[],
  toolCall: ToolCall,
): SelectionRepair | undefined {
  if (!isRecord(toolCall.arguments)) return undefined;
  const action = toolCall.arguments.action;
  if (typeof action !== "string") return undefined;

  const selected = tools.find((tool) => tool.name === toolCall.name);
  if (!selected) return undefined;
  const selectedActionSchema = explicitActionSchema(selected);
  if (
    selectedActionSchema === undefined
    || actionSchemaAllows(selectedActionSchema, action)
  ) {
    return undefined;
  }

  const candidates = tools.filter((tool) => {
    if (tool.name === selected.name) return false;
    const candidateActionSchema = explicitActionSchema(tool);
    return candidateActionSchema !== undefined
      && actionSchemaAllows(candidateActionSchema, action)
      && acceptsToolCall(tool, toolCall);
  });
  if (candidates.length !== 1) return undefined;

  return {
    fromTool: selected.name,
    toTool: candidates[0]!.name,
    action,
  };
}

function wrapSelectionRepairStream(
  stream: AssistantMessageEventStream,
  tools: DispatchTool[],
  logger: ComisLogger,
): AssistantMessageEventStream {
  const repairs = new Map<string, SelectionRepair>();

  const repairToolCall = (toolCall: ToolCall): ToolCall => {
    const prior = repairs.get(toolCall.id);
    if (prior) {
      return toolCall.name === prior.toTool
        ? toolCall
        : { ...toolCall, name: prior.toTool };
    }

    const repair = findUniqueActionOwner(tools, toolCall);
    if (!repair) return toolCall;
    repairs.set(toolCall.id, repair);
    logger.info(
      {
        step: "tool-selection-repair",
        submodule: "tool-call-repair-wrapper",
        fromTool: repair.fromTool,
        toTool: repair.toTool,
        action: repair.action,
      },
      "Repaired tool selection from unique action schema match",
    );
    return { ...toolCall, name: repair.toTool };
  };

  const repairMessage = (message: AssistantMessage): AssistantMessage => {
    let modified = false;
    const content = message.content.map((block) => {
      if (block.type !== "toolCall") return block;
      const repaired = repairToolCall(block);
      if (repaired !== block) modified = true;
      return repaired;
    });
    return modified ? { ...message, content } : message;
  };

  const repairEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
    switch (event.type) {
      case "toolcall_end": {
        const toolCall = repairToolCall(event.toolCall);
        const partial = repairMessage(event.partial);
        return toolCall === event.toolCall && partial === event.partial
          ? event
          : { ...event, toolCall, partial };
      }
      case "done":
        return { ...event, message: repairMessage(event.message) };
      case "error":
        return { ...event, error: repairMessage(event.error) };
      default:
        return event;
    }
  };

  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        yield repairEvent(event);
      }
    },
    async result() {
      return repairMessage(await stream.result());
    },
  } as unknown as AssistantMessageEventStream;
}

/**
 * Create a stream wrapper that repairs malformed history arguments and
 * uniquely identifiable incoming action/tool mismatches.
 *
 * When a ToolCall's arguments field arrives as a raw JSON string (runtime value
 * is a string despite being typed as Record<string, any>), this wrapper:
 * - Attempts structural repair via the SDK's parseStreamingJson (a strict
 *   superset of trailing-comma-only repair; also handles truncated JSON
 *   and control characters; same function the provider layer uses)
 * - On success: replaces the string with the parsed object (value-preserving)
 * - On failure: injects a synthetic ToolResultMessage error with a "Validation
 *   failed" prefix so the model self-corrects on its next turn. (This
 *   does NOT touch ToolRetryBreaker — the breaker is driven by real
 *   tool-execution events in pi-event-bridge.ts, and unparseable args never
 *   reach tool execution, so the breaker is uninvolved on this path.)
 *
 * @param _modelProfile - Reserved: ModelProfile for the current execution.
 *   Previously passed to repairToolCallJSON for supportsStructuredOutput gating;
 *   now reserved for future constrained-decode integration. API surface kept
 *   stable (still passed from executor-stream-setup.ts:343).
 * @param logger - Logger for debug/warn output
 */
export function createToolCallRepairWrapper(
  _modelProfile: ModelProfile,
  logger: ComisLogger,
): StreamFnWrapper {
  return function toolCallRepairWrapper(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const repairedMessages: Message[] = [];

      // Idempotency: the wrapper runs on the OUTGOING context on every
      // stream call. Collect the toolCallIds that already have a toolResult so a
      // second pass over the same history does NOT inject a duplicate synthetic
      // validation-failed result for a tool call that was already answered.
      const existingToolResultIds = new Set<string>();
      for (const msg of context.messages) {
        if (msg.role === "toolResult") {
          const id = (msg as ToolResultMessage).toolCallId;
          if (id !== undefined) existingToolResultIds.add(id);
        }
      }

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

          // If arguments is already a parsed object (the normal case), pass through unchanged.
          // (Per-field stringified-JSON coercion for object args happens at the tool's
          // prepareArguments hook — applyProviderNormalization — which runs at the actual
          // tool-dispatch point; this wrapper only sees the model-call input context.)
          if (typeof rawArgs !== "string") return block;

          // Arguments arrived as a raw JSON string — attempt shape-only repair via the SDK's
          // parseStreamingJson (same fn the provider layer uses; a strict superset of
          // trailing-comma-only repair: handles trailing commas + truncated + control chars).
          // parseStreamingJson NEVER throws — returns {} or partial object for garbage input.
          // Cast: rawArgs is narrowed to never by TS (ToolCall.arguments: Record<string,any>)
          // but we confirmed it is a string above; the cast is safe and intentional.
          const rawArgsStr = rawArgs as unknown as string;
          const repaired = parseStreamingJson<Record<string, unknown>>(rawArgsStr);

          // Usability check: determine whether the result is a genuine parse failure.
          // Irreparable = the input was non-trivial (non-empty, not literally "{}") yet the
          // SDK produced an empty object AND strict JSON.parse also fails. This distinguishes
          // a real garbage string from a legitimately empty-args call (rawArgs="{}" or rawArgs="").
          // False-negative guard: garbage input MUST NOT slip through as {} and call a tool.
          // False-positive guard: a legit "{}" MUST NOT be flagged as irreparable.
          const trimmed = rawArgsStr.trim();
          const isLegitEmptyArgs = trimmed === "" || trimmed === "{}";
          let strictParseFailed = false;
          if (!isLegitEmptyArgs) {
            try {
              JSON.parse(rawArgsStr);
            } catch {
              strictParseFailed = true;
            }
          }
          const isIrreparable =
            !isLegitEmptyArgs &&
            strictParseFailed &&
            Object.keys(repaired).length === 0;

          if (!isIrreparable) {
            logger.debug(
              {
                submodule: "tool-call-repair-wrapper",
                toolName: toolCall.name,
              },
              "Tool-call JSON shape repaired",
            );
            modified = true;
            // Return the ToolCall with repaired (parsed) args; value-preserving
            return { ...toolCall, arguments: repaired };
          }

          // Irreparable — inject a synthetic ToolResultMessage error so the model
          // sees a well-formed validation error and self-corrects on its next
          // turn. This message is context for the MODEL only; it does not
          // reach ToolRetryBreaker (counters come from real tool-execution events
          // in pi-event-bridge.ts), and unparseable args never trigger a tool
          // execution, so the breaker is not involved on this path.
          logger.warn(
            {
              submodule: "tool-call-repair-wrapper",
              toolName: toolCall.name,
              errorKind: "validation" as ErrorKind,
              hint: "Model emitted irreparable tool-call JSON; returning validation_failed",
            },
            "Irreparable tool-call JSON — shape repair failed",
          );

          modified = true;

          // Well-formed assistant block: replace the raw string args with
          // a safe empty object so the outgoing assistant message carries
          // arguments as the object the SDK/provider serializer expects (a string
          // may be rejected or silently mishandled). Replacing it also means a
          // second pass over this history sees a parsed object (not a string) and
          // will not re-detect / re-fail this same tool call.
          const sanitizedBlock: ToolCall = { ...toolCall, arguments: {} };

          // De-dup: only inject a synthetic toolResult if this tool call
          // does not already have one in the history. Prevents duplicating the
          // validation-failed message (and growing context) on every turn.
          if (!existingToolResultIds.has(toolCall.id)) {
            existingToolResultIds.add(toolCall.id);
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
          }

          // Return the sanitized block (string args replaced with {}); any
          // synthetic error is appended after the assistant message below.
          return sanitizedBlock;
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

      const stream = next(
        model,
        { ...context, messages: repairedMessages },
        options,
      );
      const tools = (context.tools ?? []) as DispatchTool[];
      return stream instanceof Promise
        ? stream.then((resolved) =>
            wrapSelectionRepairStream(resolved, tools, logger))
        : wrapSelectionRepairStream(stream, tools, logger);
    };
  };
}
