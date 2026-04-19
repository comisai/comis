/**
 * Validation error formatter stream wrapper.
 *
 * Reformats AJV validation errors in toolResult messages before the LLM
 * sees them on the next turn, providing concise, actionable messages.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./types.js";
import { formatValidationError } from "../../safety/validation-error-formatter.js";

/**
 * Create a wrapper that reformats AJV validation errors in toolResult messages
 * before the LLM sees them on the next turn.
 *
 * pi-ai's validateToolArguments() produces verbose error text containing
 * AJV's generic messages plus a full JSON dump of the received arguments.
 * This wrapper intercepts those tool results and rewrites them into concise,
 * actionable messages that help the LLM self-correct.
 *
 * Only modifies toolResult messages where `isError === true` and the text
 * matches the pi-ai validation error pattern. All other messages pass through
 * unchanged.
 *
 * @param logger - Logger for debug output when a validation error is reformatted
 * @returns A named StreamFnWrapper ("validationErrorFormatter")
 */
export function createValidationErrorFormatter(
  logger: ComisLogger,
): StreamFnWrapper {
  return function validationErrorFormatter(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const mappedMessages: Message[] = context.messages.map((msg) => {
        if (msg.role !== "toolResult" || !msg.isError) {
          return msg;
        }

        // Find first text content block
        const textBlock = (msg.content as Array<{ type: string; text?: string }>).find(
          (block) => block.type === "text",
        );
        if (!textBlock || typeof textBlock.text !== "string") {
          return msg;
        }

        const formatted = formatValidationError(textBlock.text);
        if (formatted === null) {
          return msg;
        }

        logger.debug(
          { toolName: msg.toolName },
          "Validation error reformatted",
        );

        // Replace text in the matching content block
        const updatedContent = (msg.content as Array<{ type: string; text?: string }>).map(
          (block) => block === textBlock ? { ...block, text: formatted } : block,
        );

        return { ...msg, content: updatedContent as typeof msg.content };
      });

      return next(model, { ...context, messages: mappedMessages }, options);
    };
  };
}
