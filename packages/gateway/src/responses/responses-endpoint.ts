/**
 * OpenResponses /v1/responses endpoint.
 *
 * Supports both streaming (SSE with semantic events) and non-streaming
 * (JSON ResponseObject) responses. The streaming format uses item-based
 * state machines with typed events and monotonic sequence numbers.
 *
 * @module
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { suppressError } from "@comis/shared";
import { createOpenAIError } from "../openai/openai-types.js";
import {
  ResponseRequestSchema,
  createSequenceCounter,
  type ResponseObject,
  type OutputItem,
  type ContentPart,
  type ResponseStreamEvent,
} from "./responses-types.js";

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/**
 * Dependencies for the OpenResponses route.
 *
 * Uses the same executeAgent pattern as OpenAI completions, with onDelta
 * callback for streaming content delivery.
 */
export interface ResponsesEndpointDeps {
  /** Execute an agent turn with optional streaming callback. */
  executeAgent: (params: {
    message: string;
    sessionKey: { userId: string; channelId: string; peerId: string };
    onDelta?: (delta: string) => void;
  }) => Promise<{
    response: string;
    tokensUsed: { input: number; output: number; total: number };
    finishReason: string;
  }>;

  /** Optional model alias resolution. Returns undefined if model not found. */
  resolveModel?: (
    modelId: string,
  ) => { provider: string; modelId: string } | undefined;

  /** Logger for request lifecycle events. */
  logger: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

// ---------------------------------------------------------------------------
// Streaming helper
// ---------------------------------------------------------------------------

/**
 * Handle the streaming SSE response sequence for the OpenResponses endpoint.
 *
 * Encapsulates the entire streaming protocol: in_progress -> output_item.added
 * -> content_part.added -> delta events -> text.done -> content_part.done
 * -> output_item.done -> response.completed -> [DONE].
 */
async function handleStreamingResponse(params: {
  stream: SSEStreamingApi;
  deps: ResponsesEndpointDeps;
  body: { model: string };
  userMessage: string;
  responseId: string;
  messageId: string;
  sessionKey: { userId: string; channelId: string; peerId: string };
}): Promise<void> {
  const { stream, deps, body, userMessage, responseId, messageId, sessionKey } =
    params;
  const counter = createSequenceCounter();
  let accumulatedText = "";

  // Build initial response shell (in_progress, empty output)
  const inProgressResponse: ResponseObject = {
    id: responseId,
    object: "response",
    status: "in_progress",
    output: [],
    model: body.model,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  // 1. response.in_progress
  const inProgressEvent: ResponseStreamEvent = {
    type: "response.in_progress",
    sequence_number: counter.next(),
    response: inProgressResponse,
  };
  await stream.writeSSE({ data: JSON.stringify(inProgressEvent) });

  // Build in-progress message item
  const inProgressItem: OutputItem = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "in_progress",
    content: [],
  };

  // 2. response.output_item.added
  const itemAddedEvent: ResponseStreamEvent = {
    type: "response.output_item.added",
    sequence_number: counter.next(),
    output_index: 0,
    item: inProgressItem,
  };
  await stream.writeSSE({ data: JSON.stringify(itemAddedEvent) });

  // 3. response.content_part.added
  const emptyPart: ContentPart = { type: "output_text", text: "" };
  const partAddedEvent: ResponseStreamEvent = {
    type: "response.content_part.added",
    sequence_number: counter.next(),
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: emptyPart,
  };
  await stream.writeSSE({ data: JSON.stringify(partAddedEvent) });

  // Execute agent with onDelta for streaming deltas
  let result: Awaited<ReturnType<typeof deps.executeAgent>>;
  try {
    result = await deps.executeAgent({
      message: userMessage,
      sessionKey,
      onDelta: (delta: string) => {
        accumulatedText += delta;

        // 4. response.output_text.delta (for each chunk)
        const deltaEvent: ResponseStreamEvent = {
          type: "response.output_text.delta",
          sequence_number: counter.next(),
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        };
        suppressError(
          stream.writeSSE({ data: JSON.stringify(deltaEvent) }),
          "Stream may have been closed by client",
        );
      },
    });
  } catch (err) {
    deps.logger.error(
      {
        err,
        responseId,
        hint: "Check agent executor logs or LLM provider connectivity",
        errorKind: "dependency" as const,
      },
      "Agent execution failed during streaming",
    );

    // Emit response.failed event
    const failedResponse: ResponseObject = {
      id: responseId,
      object: "response",
      status: "failed",
      output: [],
      model: body.model,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
    const failedEvent: ResponseStreamEvent = {
      type: "response.failed",
      sequence_number: counter.next(),
      response: failedResponse,
    };
    await stream.writeSSE({ data: JSON.stringify(failedEvent) });
    await stream.writeSSE({ data: "[DONE]" });
    return;
  }

  // 5. response.output_text.done
  const textDoneEvent: ResponseStreamEvent = {
    type: "response.output_text.done",
    sequence_number: counter.next(),
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    text: accumulatedText,
  };
  await stream.writeSSE({ data: JSON.stringify(textDoneEvent) });

  // Build completed content part and item
  const completedPart: ContentPart = {
    type: "output_text",
    text: accumulatedText,
  };

  // 6. response.content_part.done
  const partDoneEvent: ResponseStreamEvent = {
    type: "response.content_part.done",
    sequence_number: counter.next(),
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: completedPart,
  };
  await stream.writeSSE({ data: JSON.stringify(partDoneEvent) });

  // Build completed output item
  const completedItem: OutputItem = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [completedPart],
  };

  // 7. response.output_item.done
  const itemDoneEvent: ResponseStreamEvent = {
    type: "response.output_item.done",
    sequence_number: counter.next(),
    output_index: 0,
    item: completedItem,
  };
  await stream.writeSSE({ data: JSON.stringify(itemDoneEvent) });

  // 8. response.completed
  const completedResponse: ResponseObject = {
    id: responseId,
    object: "response",
    status: "completed",
    output: [completedItem],
    model: body.model,
    usage: {
      input_tokens: result.tokensUsed.input,
      output_tokens: result.tokensUsed.output,
      total_tokens: result.tokensUsed.total,
    },
  };
  const completedEvent: ResponseStreamEvent = {
    type: "response.completed",
    sequence_number: counter.next(),
    response: completedResponse,
  };
  await stream.writeSSE({ data: JSON.stringify(completedEvent) });

  // Terminal marker
  await stream.writeSSE({ data: "[DONE]" });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an OpenResponses /v1/responses route handler.
 *
 * Returns a Hono app with a single POST / handler. Mount at
 * `/v1/responses` in the parent router.
 *
 * Supports:
 * - Non-streaming: returns a complete ResponseObject JSON
 * - Streaming: emits semantic SSE events with monotonic sequence numbers
 */
export function createResponsesRoute(deps: ResponsesEndpointDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    try {
      // Parse and validate request body
      const rawBody = await c.req.json();
      const parseResult = ResponseRequestSchema.safeParse(rawBody);

      if (!parseResult.success) {
        const issues = parseResult.error.issues;
        const firstParam =
          issues.length > 0 && issues[0].path.length > 0
            ? String(issues[0].path[0])
            : undefined;
        const message =
          "Invalid request: " +
          issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

        return c.json(createOpenAIError(400, message, firstParam), 400);
      }

      const body = parseResult.data;

      // Extract message: string input used directly, array input joins user messages
      let userMessage: string;
      if (typeof body.input === "string") {
        userMessage = body.input;
      } else {
        userMessage = body.input
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n");
      }

      if (!userMessage) {
        return c.json(
          createOpenAIError(400, "No user message found in input"),
          400,
        );
      }

      // Generate identifiers
      const responseId = `resp_${crypto.randomUUID()}`;
      const messageId = `msg_${crypto.randomUUID()}`;

      // Session key for responses API requests
      const sessionKey = {
        userId: "responses-api",
        channelId: "responses",
        peerId: responseId,
      };

      // -----------------------------------------------------------------
      // Streaming path
      // -----------------------------------------------------------------
      if (body.stream) {
        return streamSSE(c, async (stream) => {
          await handleStreamingResponse({
            stream,
            deps,
            body,
            userMessage,
            responseId,
            messageId,
            sessionKey,
          });
        });
      }

      // -----------------------------------------------------------------
      // Non-streaming path
      // -----------------------------------------------------------------
      const result = await deps.executeAgent({
        message: userMessage,
        sessionKey,
      });

      const completedPart: ContentPart = {
        type: "output_text",
        text: result.response,
      };

      const completedItem: OutputItem = {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [completedPart],
      };

      const responseObject: ResponseObject = {
        id: responseId,
        object: "response",
        status: "completed",
        output: [completedItem],
        model: body.model,
        usage: {
          input_tokens: result.tokensUsed.input,
          output_tokens: result.tokensUsed.output,
          total_tokens: result.tokensUsed.total,
        },
      };

      return c.json(responseObject);
    } catch (err) {
      deps.logger.error(
        {
          err,
          hint: "Inspect the request body and agent configuration",
          errorKind: "internal" as const,
        },
        "OpenResponses endpoint error",
      );
      return c.json(createOpenAIError(500, "Internal server error"), 500);
    }
  });

  return app;
}
