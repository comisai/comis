// SPDX-License-Identifier: Apache-2.0
/**
 * OpenResponses type definitions for /v1/responses.
 *
 * Provides Zod schemas for request validation and TypeScript interfaces
 * for response/streaming event construction. The OpenResponses standard
 * offers a richer streaming format than chat completions with item-based
 * state machines and typed semantic events.
 *
 * @module
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Request validation (Zod schemas)
// ---------------------------------------------------------------------------

/** Schema for a structured message in the responses request. */
export const ResponseMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

/**
 * Zod schema for POST /v1/responses request body.
 *
 * Accepts either a single string prompt or an array of structured messages.
 * Uses z.strictObject() per Zod v4 convention to reject unknown fields.
 */
export const ResponseRequestSchema = z.strictObject({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(ResponseMessageSchema)]),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

/** Inferred type from the request schema. */
export type ResponseRequest = z.infer<typeof ResponseRequestSchema>;

// ---------------------------------------------------------------------------
// Response interfaces (TypeScript only -- responses are built, not validated)
// ---------------------------------------------------------------------------

/** A text content part within an output item. */
export interface ContentPart {
  type: "output_text";
  text: string;
}

/** A message output item containing content parts. */
export interface OutputItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "in_progress";
  content: ContentPart[];
}

/** The top-level response object returned by /v1/responses. */
export interface ResponseObject {
  id: string;
  object: "response";
  status: "completed" | "failed" | "in_progress";
  output: OutputItem[];
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Streaming event types (semantic SSE events)
// ---------------------------------------------------------------------------

/** Response state transition to in_progress. */
export interface ResponseInProgressEvent {
  type: "response.in_progress";
  sequence_number: number;
  response: ResponseObject;
}

/** A new output item was added to the response. */
export interface OutputItemAddedEvent {
  type: "response.output_item.added";
  sequence_number: number;
  output_index: number;
  item: OutputItem;
}

/** A new content part was added to an output item. */
export interface ContentPartAddedEvent {
  type: "response.content_part.added";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

/** A text delta for streaming output. */
export interface OutputTextDeltaEvent {
  type: "response.output_text.delta";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

/** Text output is complete for a content part. */
export interface OutputTextDoneEvent {
  type: "response.output_text.done";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

/** A content part is complete. */
export interface ContentPartDoneEvent {
  type: "response.content_part.done";
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

/** An output item is complete. */
export interface OutputItemDoneEvent {
  type: "response.output_item.done";
  sequence_number: number;
  output_index: number;
  item: OutputItem;
}

/** The response has completed successfully. */
export interface ResponseCompletedEvent {
  type: "response.completed";
  sequence_number: number;
  response: ResponseObject;
}

/** The response has failed. */
export interface ResponseFailedEvent {
  type: "response.failed";
  sequence_number: number;
  response: ResponseObject;
}

/** Union of all streaming event types. */
export type ResponseStreamEvent =
  | ResponseInProgressEvent
  | OutputItemAddedEvent
  | ContentPartAddedEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | ContentPartDoneEvent
  | OutputItemDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a monotonically increasing sequence counter.
 *
 * Each call to `next()` returns the next integer starting from 0.
 * Used to assign sequence_number to streaming events
 * (must be monotonically increasing).
 */
export function createSequenceCounter(): { next: () => number } {
  let counter = 0;
  return {
    next(): number {
      return counter++;
    },
  };
}
