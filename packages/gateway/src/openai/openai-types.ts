// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible type definitions for /v1/chat/completions.
 *
 * Provides Zod schemas for request validation and TypeScript interfaces
 * for response construction. Used by openai-completions.ts and consumed
 * by plans 68-02 and 68-05.
 *
 * @module
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Request validation (Zod schemas)
// ---------------------------------------------------------------------------

/** Schema for a single message in the chat completions request. */
export const ChatMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

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
