// SPDX-License-Identifier: Apache-2.0
/**
 * OpenResponses /v1/responses endpoint.
 *
 * Supports both streaming (SSE with semantic events) and non-streaming
 * (JSON ResponseObject) responses. The streaming format uses item-based
 * state machines with typed events and monotonic sequence numbers.
 *
 * @module
 */

import { Hono, type Env } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import {
  formatSessionKey,
  systemNowMs,
  type TypedEventBus,
} from "@comis/core";
import { createOpenAIError } from "../openai/openai-types.js";
import { createSseDeliveryTracker } from "../openai/sse-delivery-tracker.js";
import { prepareApiConversation } from "../openai/api-conversation.js";

interface ResponsesEndpointEnv extends Env {
  Variables: { clientScopes: readonly string[] };
}
import {
  emitGatewayTurnDiagnostic,
  formatGatewayErrorForLog,
  type GatewayTurnResult,
} from "../openai/turn-diagnostic.js";
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
  /** Tenant used to construct exact failure diagnostics before execution returns. */
  tenantId: string;
  /** Default agent used when model resolution does not select one explicitly. */
  agentId: string;
  /** Execute an agent turn with optional streaming callback. */
  executeAgent: (params: {
    message: string;
    systemPrompt?: string;
    sessionKey: { userId: string; channelId: string; peerId: string };
    /** Scopes from the bearer token already verified by the parent route. */
    authenticatedScopes: readonly string[];
    onDelta?: (delta: string, kind?: "text" | "thinking") => void;
    traceId: string;
    agentId?: string;
    /** Cancels the executing turn when its inbound HTTP request disconnects. */
    signal: AbortSignal;
  }) => Promise<GatewayTurnResult & {
    response: string;
    tokensUsed: { input: number; output: number; total: number };
    stepsExecuted: number;
    llmCalls: number;
  }>;

  /** Optional model alias resolution. Returns undefined if model not found. */
  resolveModel?: (
    modelId: string,
  ) => { provider: string; modelId: string; agentId?: string } | undefined;

  /** Optional event bus receiving one full-lifecycle diagnostic per request. */
  eventBus?: Pick<TypedEventBus, "emitSafely">;

  /** Logger for request lifecycle events. */
  logger: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

type ResponseSessionKey = { userId: string; channelId: string; peerId: string };

function emitResponseDiagnostic(
  deps: ResponsesEndpointDeps,
  args: {
    result: GatewayTurnResult;
    sessionKey: ResponseSessionKey;
    responseId: string;
    traceId: string;
    agentId: string;
    receivedAt: number;
    executionCompletedAt: number;
    completedAt?: number;
  },
): void {
  emitGatewayTurnDiagnostic(deps, {
    messageId: args.responseId,
    channelId: "responses",
    channelType: "responses",
    fallbackAgentId: args.agentId,
    fallbackSessionKey: formatSessionKey({
      tenantId: deps.tenantId,
      agentId: args.agentId,
      userId: args.sessionKey.userId,
      channelId: args.sessionKey.channelId,
      peerId: args.sessionKey.peerId,
    }),
    fallbackTraceId: args.traceId,
    result: args.result,
    receivedAt: args.receivedAt,
    executionCompletedAt: args.executionCompletedAt,
    ...(args.completedAt !== undefined ? { completedAt: args.completedAt } : {}),
  });
}

function emitResponseExecutionFailure(
  deps: ResponsesEndpointDeps,
  args: Omit<Parameters<typeof emitResponseDiagnostic>[1], "result">,
): void {
  emitResponseDiagnostic(deps, {
    ...args,
    result: {
      tokensUsed: { total: 0 },
      finishReason: "error",
      stepsExecuted: null,
      llmCalls: null,
      status: "error",
      failureStage: "execution",
    },
  });
}

function emitResponseDeliveryFailure(
  deps: ResponsesEndpointDeps,
  args: Omit<Parameters<typeof emitResponseDiagnostic>[1], "result"> & {
    result?: GatewayTurnResult;
    completedAt: number;
  },
): void {
  emitResponseDiagnostic(deps, {
    ...args,
    result: {
      ...(args.result ?? {
        tokensUsed: { total: 0 },
        finishReason: "error",
        stepsExecuted: null,
        llmCalls: null,
      }),
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
    },
  });
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
  systemPrompt: string | undefined;
  responseId: string;
  messageId: string;
  sessionKey: ResponseSessionKey;
  traceId: string;
  agentId: string;
  authenticatedScopes: readonly string[];
  receivedAt: number;
  requestSignal: AbortSignal;
}): Promise<void> {
  const {
    stream,
    deps,
    body,
    userMessage,
    systemPrompt,
    responseId,
    messageId,
    sessionKey,
    traceId,
    agentId,
    authenticatedScopes,
    receivedAt,
    requestSignal,
  } = params;
  const counter = createSequenceCounter();
  const delivery = createSseDeliveryTracker(stream, requestSignal);
  let accumulatedText = "";
  try {

  const recordDeliveryFailure = (
    executionCompletedAt: number,
    result?: GatewayTurnResult,
    preserveExecutionFailure = true,
  ): void => {
    const completedAt = delivery.failedAt ?? systemNowMs();
    deps.logger.error(
      {
        ...(delivery.error !== undefined
          ? { err: formatGatewayErrorForLog(delivery.error) }
          : {}),
        responseId,
        hint: "Check client connectivity and gateway stream delivery",
        errorKind: "platform" as const,
      },
      "OpenResponses streaming delivery failed",
    );
    if (
      preserveExecutionFailure &&
      result !== undefined &&
      result.status !== "success"
    ) {
      emitResponseDiagnostic(deps, {
        result,
        sessionKey,
        responseId,
        traceId,
        agentId,
        receivedAt,
        executionCompletedAt,
        completedAt,
      });
    } else {
      emitResponseDeliveryFailure(deps, {
        ...(result !== undefined ? { result } : {}),
        sessionKey,
        responseId,
        traceId,
        agentId,
        receivedAt,
        executionCompletedAt,
        completedAt,
      });
    }
  };

  const logDeliveryFailure = (): void => {
    deps.logger.error(
      {
        ...(delivery.error !== undefined
          ? { err: formatGatewayErrorForLog(delivery.error) }
          : {}),
        responseId,
        hint: "Check client connectivity and gateway stream delivery",
        errorKind: "platform" as const,
      },
      "OpenResponses streaming delivery failed after execution error",
    );
  };

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
  if (!await delivery.write(JSON.stringify(inProgressEvent))) {
    recordDeliveryFailure(receivedAt);
    return;
  }

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
  if (!await delivery.write(JSON.stringify(itemAddedEvent))) {
    recordDeliveryFailure(receivedAt);
    return;
  }

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
  if (!await delivery.write(JSON.stringify(partAddedEvent))) {
    recordDeliveryFailure(receivedAt);
    return;
  }

  // Execute agent with onDelta for streaming deltas
  let result: Awaited<ReturnType<typeof deps.executeAgent>>;
  try {
    result = await deps.executeAgent({
      message: userMessage,
      systemPrompt,
      sessionKey,
      onDelta: (delta: string, kind?: "text" | "thinking") => {
        if (kind === "thinking" || delivery.signal.aborted) return;

        // 4. response.output_text.delta (for each chunk)
        const deltaEvent: ResponseStreamEvent = {
          type: "response.output_text.delta",
          sequence_number: counter.next(),
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        };
        if (delivery.enqueue(JSON.stringify(deltaEvent))) {
          accumulatedText += delta;
        }
      },
      traceId,
      agentId,
      authenticatedScopes,
      signal: delivery.signal,
    });
  } catch (err) {
    const executionCompletedAt = systemNowMs();
    delivery.sealQueue();
    await delivery.drain();
    if (delivery.failedAt !== undefined) {
      recordDeliveryFailure(executionCompletedAt);
      return;
    }
    deps.logger.error(
      {
        err: formatGatewayErrorForLog(err),
        responseId,
        hint: "Inspect agent execution logs for the originating boundary",
        errorKind: "internal" as const,
      },
      "Agent execution failed during streaming",
    );

    emitResponseExecutionFailure(deps, {
      sessionKey,
      responseId,
      traceId,
      agentId,
      receivedAt,
      executionCompletedAt,
    });

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
    await delivery.write(JSON.stringify(failedEvent));
    await delivery.write("[DONE]");
    if (delivery.failedAt !== undefined) logDeliveryFailure();
    return;
  }
  const executionCompletedAt = systemNowMs();
  const failedBeforeExecutionSettled = delivery.failedAt !== undefined;
  delivery.sealQueue();
  await delivery.drain();
  if (delivery.failedAt !== undefined) {
    recordDeliveryFailure(
      executionCompletedAt,
      result,
      !failedBeforeExecutionSettled,
    );
    return;
  }

  if (result.status !== "success") {
    const failedResponse: ResponseObject = {
      id: responseId,
      object: "response",
      status: "failed",
      output: [],
      model: body.model,
      usage: {
        input_tokens: result.tokensUsed.input,
        output_tokens: result.tokensUsed.output,
        total_tokens: result.tokensUsed.total,
      },
    };
    const failedEvent: ResponseStreamEvent = {
      type: "response.failed",
      sequence_number: counter.next(),
      response: failedResponse,
    };
    await delivery.write(JSON.stringify(failedEvent));
    await delivery.write("[DONE]");
    if (delivery.failedAt !== undefined) {
      recordDeliveryFailure(executionCompletedAt, result);
      return;
    }
    emitResponseDiagnostic(deps, {
      result,
      sessionKey,
      responseId,
      traceId,
      agentId,
      receivedAt,
      executionCompletedAt,
    });
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
  await delivery.write(JSON.stringify(textDoneEvent));

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
  await delivery.write(JSON.stringify(partDoneEvent));

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
  await delivery.write(JSON.stringify(itemDoneEvent));

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
  await delivery.write(JSON.stringify(completedEvent));

  // Terminal marker
  await delivery.write("[DONE]");
  if (delivery.failedAt !== undefined) {
    recordDeliveryFailure(executionCompletedAt, result);
    return;
  }
  emitResponseDiagnostic(deps, {
    result,
    sessionKey,
    responseId,
    traceId,
    agentId,
    receivedAt,
    executionCompletedAt,
  });
  } finally {
    delivery.dispose();
  }
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
export function createResponsesRoute(
  deps: ResponsesEndpointDeps,
): Hono<ResponsesEndpointEnv> {
  const app = new Hono<ResponsesEndpointEnv>();

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
      const authenticatedScopes = c.get("clientScopes") ?? [];
      const receivedAt = systemNowMs();

      const conversation = prepareApiConversation(
        typeof body.input === "string"
          ? [{ role: "user", content: body.input }]
          : body.input,
      );
      if (!conversation) {
        return c.json(
          createOpenAIError(400, "No user message found in input"),
          400,
        );
      }
      const userMessage = conversation.message;
      const systemPrompt = conversation.systemPrompt;

      let resolvedModel: ReturnType<NonNullable<ResponsesEndpointDeps["resolveModel"]>> = undefined;
      if (deps.resolveModel) {
        resolvedModel = deps.resolveModel(body.model);
        if (!resolvedModel) {
          return c.json(
            createOpenAIError(404, `Model not found: ${body.model}`),
            404,
          );
        }
      }

      // Generate identifiers
      const responseId = `resp_${crypto.randomUUID()}`;
      const messageId = `msg_${crypto.randomUUID()}`;
      const traceId = crypto.randomUUID();
      const agentId = resolvedModel?.agentId ?? deps.agentId;

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
            systemPrompt,
            responseId,
            messageId,
            sessionKey,
            traceId,
            agentId,
            authenticatedScopes,
            receivedAt,
            requestSignal: c.req.raw.signal,
          });
        });
      }

      // -----------------------------------------------------------------
      // Non-streaming path
      // -----------------------------------------------------------------
      let result: Awaited<ReturnType<typeof deps.executeAgent>>;
      try {
        result = await deps.executeAgent({
          message: userMessage,
          systemPrompt,
          sessionKey,
          traceId,
          agentId,
          authenticatedScopes,
          signal: c.req.raw.signal,
        });
      } catch (err) {
        const executionCompletedAt = systemNowMs();
        if (c.req.raw.signal.aborted) {
          deps.logger.error(
            {
              responseId,
              hint: "Check client connectivity and gateway request cancellation",
              errorKind: "platform" as const,
            },
            "OpenResponses non-streaming request disconnected during execution",
          );
          emitResponseDeliveryFailure(deps, {
            sessionKey,
            responseId,
            traceId,
            agentId,
            receivedAt,
            executionCompletedAt,
            completedAt: executionCompletedAt,
          });
          return c.json(createOpenAIError(500, "Request delivery cancelled"), 500);
        }
        deps.logger.error(
          {
            err: formatGatewayErrorForLog(err),
            responseId,
            hint: "Inspect agent execution logs for the originating boundary",
            errorKind: "internal" as const,
          },
          "OpenResponses agent execution failed",
        );
        emitResponseExecutionFailure(deps, {
          sessionKey,
          responseId,
          traceId,
          agentId,
          receivedAt,
          executionCompletedAt,
        });
        return c.json(createOpenAIError(500, "Internal server error"), 500);
      }
      const executionCompletedAt = systemNowMs();
      if (c.req.raw.signal.aborted) {
        deps.logger.error(
          {
            responseId,
            hint: "Check client connectivity and gateway request cancellation",
            errorKind: "platform" as const,
          },
          "OpenResponses non-streaming request disconnected before response delivery",
        );
        emitResponseDeliveryFailure(deps, {
          result,
          sessionKey,
          responseId,
          traceId,
          agentId,
          receivedAt,
          executionCompletedAt,
          completedAt: executionCompletedAt,
        });
        return c.json(createOpenAIError(500, "Request delivery cancelled"), 500);
      }

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
        status: result.status === "success" ? "completed" : "failed",
        output: result.status === "success" ? [completedItem] : [],
        model: body.model,
        usage: {
          input_tokens: result.tokensUsed.input,
          output_tokens: result.tokensUsed.output,
          total_tokens: result.tokensUsed.total,
        },
      };

      emitResponseDiagnostic(deps, {
        result,
        sessionKey,
        responseId,
        traceId,
        agentId,
        receivedAt,
        executionCompletedAt,
      });

      return c.json(responseObject);
    } catch (err) {
      deps.logger.error(
        {
          err: formatGatewayErrorForLog(err),
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
