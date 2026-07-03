// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible type definitions for /v1/chat/completions.
 *
 * Provides Zod schemas for request validation and TypeScript interfaces
 * for response construction. Used by openai-completions.ts.
 *
 * @module
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Request validation (Zod schemas)
// ---------------------------------------------------------------------------

/**
 * A single block in the OpenAI multimodal `content` array. Standard OpenAI
 * shape: a `text` block or an `image_url` block. Accepting the array form lets
 * a standard multimodal request PARSE (instead of the confusing "expected
 * string, received array" schema 400); the handler flattens text blocks and
 * returns a NAMED unsupported-vision error for image_url blocks (vision input
 * is not yet wired through /v1).
 */
export const ContentBlockSchema = z.union([
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }),
  }),
]);

/** Schema for a single message in the chat completions request. `content` is a
 *  plain string OR the OpenAI multimodal content-block array. */
export const ChatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

/** Human-named error for vision input via /v1 (V1-NO-VISION) — replaces the
 *  opaque "messages.0.content: expected string, received array" schema 400. */
export const VISION_UNSUPPORTED_MESSAGE =
  "Vision input (image_url) is not yet supported via the /v1 chat completions endpoint. " +
  "Send images through a chat channel (Telegram, Discord, etc.) instead.";

/**
 * Flatten an OpenAI message `content` (string OR content-block array) into the
 * plain text the agent executor consumes, and report whether it carried an
 * `image_url` block (vision input — not yet wired through /v1). A string content
 * is returned verbatim with `hasImage:false`.
 */
export function flattenMessageContent(
  content: z.infer<typeof ChatMessageSchema>["content"],
): { text: string; hasImage: boolean } {
  if (typeof content === "string") return { text: content, hasImage: false };
  let hasImage = false;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image_url") hasImage = true;
  }
  return { text: parts.join("\n"), hasImage };
}

/** Schema for stream_options in the chat completions request. */
export const StreamOptionsSchema = z.strictObject({
  include_usage: z.boolean().optional(),
});

/**
 * Zod schema for POST /v1/chat/completions request body.
 *
 * Validates the OpenAI-compatible request format. Uses z.strictObject()
 * per Zod v4 convention to reject unknown fields.
 */
export const ChatCompletionRequestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream_options: StreamOptionsSchema.optional(),
});

/** Inferred type from the request schema. */
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// ---------------------------------------------------------------------------
// Response interfaces (TypeScript only -- responses are built, not validated)
// ---------------------------------------------------------------------------

/** Non-streaming chat completion response. */
export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Streaming chat completion chunk. */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Error types and helpers
// ---------------------------------------------------------------------------

/** OpenAI-format error response. */
export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** Map of HTTP status codes to OpenAI error types. */
const STATUS_TO_ERROR_TYPE: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "server_error",
};

/**
 * Create an OpenAI-format error response.
 *
 * Maps HTTP status codes to OpenAI error types. Unknown status codes
 * fall back to "server_error".
 */
export function createOpenAIError(
  status: number,
  message: string,
  param?: string,
): OpenAIErrorResponse {
  return {
    error: {
      message,
      type: STATUS_TO_ERROR_TYPE[status] ?? "server_error",
      param: param ?? null,
      code: null,
    },
  };
}

/** Map of Comis finish reasons to OpenAI finish reasons. */
const FINISH_REASON_MAP: Record<string, "stop" | "length"> = {
  stop: "stop",
  max_steps: "length",
  budget_exceeded: "stop",
  circuit_open: "stop",
  context_loop: "stop",
  error: "stop",
};

/**
 * Map Comis finish reasons to OpenAI finish reasons.
 *
 * - "stop" -> "stop"
 * - "max_steps" -> "length"
 * - "budget_exceeded" -> "stop"
 * - "circuit_open" -> "stop"
 * - "error" -> "stop"
 * - Unknown -> "stop"
 */
export function mapFinishReason(reason: string): "stop" | "length" {
  return FINISH_REASON_MAP[reason] ?? "stop";
}
