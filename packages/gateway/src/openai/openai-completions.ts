// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Supports both streaming (SSE) and non-streaming (JSON) responses.
 * Maps Comis's AgentExecutor.execute() to OpenAI's ChatCompletion
 * and ChatCompletionChunk formats.
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
import {
  ChatCompletionRequestSchema,
  createOpenAIError,
  flattenMessageContent,
  mapFinishReason,
  VISION_UNSUPPORTED_MESSAGE,
  type ChatCompletion,
  type ChatCompletionChunk,
} from "./openai-types.js";
import { createSseDeliveryTracker } from "./sse-delivery-tracker.js";
import {
  emitGatewayTurnDiagnostic,
  formatGatewayErrorForLog,
  type GatewayTurnResult,
} from "./turn-diagnostic.js";
import { prepareApiConversation } from "./api-conversation.js";

interface OpenaiCompletionsEnv extends Env {
  Variables: { clientScopes: readonly string[] };
}

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/**
 * Dependencies for the OpenAI completions route.
 *
 * The `executeAgent` interface extends the RPC adapter pattern with an
 * `onDelta` callback for streaming. The gateway's hono-server or daemon
 * must wire this to AgentExecutor.execute() with onDelta forwarded.
 */
export interface OpenaiCompletionsDeps {
  /** Tenant used to construct exact failure diagnostics before execution returns. */
  tenantId?: string;
  /** Default agent used when model resolution does not select one explicitly. */
  agentId?: string;
  /** Execute an agent turn with optional streaming callback. */
  executeAgent: (params: {
    message: string;
    systemPrompt?: string;
    sessionKey?: { userId: string; channelId: string; peerId: string };
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
    /** Exact tool executions reported by the agent turn. */
    stepsExecuted: number;
    /** Exact model calls reported by the agent turn. */
    llmCalls: number;
  }>;

  /** Optional model alias resolution. Returns undefined if model not found. */
  resolveModel?: (
    modelId: string,
  ) => { provider: string; modelId: string; agentId?: string } | undefined;

  /**
   * Optional event bus. When present, the route emits one
   * `diagnostic:message_processed` per completed turn (streaming AND non-streaming) —
   * the OpenAI-compat chat API is a turn-completion path that bypasses the channel
   * `execution-pipeline` (which emits the event for channel turns) and never fires
   * `graph:completed` (DAG-only). Without this emit a single-agent chat-API turn's
   * outcome is observed but NEVER resolved (no RANK reward / FORGET accrual / SURFACE
   * promote-demote) and the turn is invisible to obs (`comis explain` / delivery tracer).
   */
  eventBus?: Pick<TypedEventBus, "emitSafely">;

  /** Logger for request lifecycle events. */
  logger: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

type GatewaySessionKey = { userId: string; channelId: string; peerId: string };

function fallbackSessionKey(
  deps: OpenaiCompletionsDeps,
  sessionKey: GatewaySessionKey,
): string {
  return formatSessionKey({
    tenantId: deps.tenantId ?? "default",
    userId: sessionKey.userId,
    channelId: sessionKey.channelId,
    peerId: sessionKey.peerId,
  });
}

function emitCompletionDiagnostic(
  deps: OpenaiCompletionsDeps,
  args: {
    result: GatewayTurnResult;
    sessionKey: GatewaySessionKey;
    completionId: string;
    traceId: string;
    agentId: string;
    receivedAt: number;
    executionCompletedAt: number;
    completedAt?: number;
  },
): void {
  emitGatewayTurnDiagnostic(deps, {
    messageId: args.completionId,
    channelId: "openai",
    channelType: "openai",
    fallbackAgentId: args.agentId,
    fallbackSessionKey: fallbackSessionKey(deps, args.sessionKey),
    fallbackTraceId: args.traceId,
    result: args.result,
    receivedAt: args.receivedAt,
    executionCompletedAt: args.executionCompletedAt,
    ...(args.completedAt !== undefined ? { completedAt: args.completedAt } : {}),
  });
}

/** Record an executor rejection before the route returns or closes its stream. */
function emitExecutionFailureDiagnostic(
  deps: OpenaiCompletionsDeps,
  args: {
    sessionKey: GatewaySessionKey;
    completionId: string;
    traceId: string;
    agentId: string;
    receivedAt: number;
    executionCompletedAt: number;
  },
): void {
  emitCompletionDiagnostic(deps, {
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

function emitDeliveryFailureDiagnostic(
  deps: OpenaiCompletionsDeps,
  args: {
    result?: GatewayTurnResult;
    sessionKey: GatewaySessionKey;
    completionId: string;
    traceId: string;
    agentId: string;
    receivedAt: number;
    executionCompletedAt: number;
    completedAt: number;
    preserveExecutionFailure?: boolean;
  },
): void {
  if (
    args.preserveExecutionFailure === true &&
    args.result !== undefined &&
    args.result.status !== "success"
  ) {
    emitCompletionDiagnostic(deps, {
      ...args,
      result: args.result,
    });
    return;
  }
  emitCompletionDiagnostic(deps, {
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
 * Handle the streaming SSE completion sequence for the OpenAI-compatible
 * endpoint.
 *
 * Encapsulates the entire streaming protocol: role chunk -> content deltas
 * -> finish chunk -> usage chunk -> [DONE].
 */
async function handleStreamingCompletion(params: {
  stream: SSEStreamingApi;
  deps: OpenaiCompletionsDeps;
  body: { model: string };
  userMessage: string;
  systemPrompt: string | undefined;
  completionId: string;
  created: number;
  sessionKey: GatewaySessionKey;
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
    completionId,
    created,
    sessionKey,
    traceId,
    agentId,
    authenticatedScopes,
    receivedAt,
    requestSignal,
  } = params;
  const delivery = createSseDeliveryTracker(stream, requestSignal);
  try {

  // First chunk: role announcement
  const roleChunk: ChatCompletionChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: body.model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  };
  if (!await delivery.write(JSON.stringify(roleChunk))) {
    const completedAt = delivery.failedAt ?? systemNowMs();
    deps.logger.error(
      {
        ...(delivery.error !== undefined
          ? { err: formatGatewayErrorForLog(delivery.error) }
          : {}),
        completionId,
        hint: "Check client connectivity and gateway stream delivery",
        errorKind: "platform" as const,
      },
      "OpenAI streaming delivery failed before execution",
    );
    emitDeliveryFailureDiagnostic(deps, {
      sessionKey,
      completionId,
      traceId,
      agentId,
      receivedAt,
      executionCompletedAt: receivedAt,
      completedAt,
    });
    return;
  }

  // Execute agent with onDelta callback for content streaming. The executor threads a
  // delta kind (text vs thinking). Skip thinking deltas so the stream never
  // exposes raw reasoning and stays consistent with the non-streaming result.
  // An absent optional kind is treated as visible text.
  const onDelta = (delta: string, kind?: "text" | "thinking"): void => {
    if (kind === "thinking" || delivery.signal.aborted) return;
    const contentChunk: ChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null,
        },
      ],
    };
    delivery.enqueue(JSON.stringify(contentChunk));
  };

  let result: Awaited<ReturnType<typeof deps.executeAgent>>;
  try {
    result = await deps.executeAgent({
      message: userMessage,
      systemPrompt,
      sessionKey,
      onDelta,
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
      deps.logger.error(
        {
          ...(delivery.error !== undefined
            ? { err: formatGatewayErrorForLog(delivery.error) }
            : {}),
          completionId,
          hint: "Check client connectivity and gateway stream delivery",
          errorKind: "platform" as const,
        },
        "OpenAI streaming delivery failed while execution was cancelling",
      );
      emitDeliveryFailureDiagnostic(deps, {
        sessionKey,
        completionId,
        traceId,
        agentId,
        receivedAt,
        executionCompletedAt,
        completedAt: delivery.failedAt,
      });
      return;
    }
    deps.logger.error(
      {
        err: formatGatewayErrorForLog(err),
        completionId,
        hint: "Inspect agent execution logs for the originating boundary",
        errorKind: "internal" as const,
      },
      "Agent execution failed during streaming",
    );
    emitExecutionFailureDiagnostic(deps, {
      sessionKey,
      completionId,
      traceId,
      agentId,
      receivedAt,
      executionCompletedAt,
    });
    // Write error as a data event before closing
    await delivery.write(JSON.stringify(createOpenAIError(500, "Internal server error")));
    await delivery.write("[DONE]");
    if (delivery.failedAt !== undefined) {
      deps.logger.error(
        {
          ...(delivery.error !== undefined
            ? { err: formatGatewayErrorForLog(delivery.error) }
            : {}),
          completionId,
          hint: "Check client connectivity and gateway stream delivery",
          errorKind: "platform" as const,
        },
        "OpenAI streaming delivery failed after execution error",
      );
    }
    return;
  }
  const executionCompletedAt = systemNowMs();
  const failedBeforeExecutionSettled = delivery.failedAt !== undefined;
  delivery.sealQueue();
  await delivery.drain();
  if (delivery.failedAt !== undefined) {
    deps.logger.error(
      {
        ...(delivery.error !== undefined
          ? { err: formatGatewayErrorForLog(delivery.error) }
          : {}),
        completionId,
        hint: "Check client connectivity and gateway stream delivery",
        errorKind: "platform" as const,
      },
      "OpenAI streaming content delivery failed",
    );
    emitDeliveryFailureDiagnostic(deps, {
      result,
      sessionKey,
      completionId,
      traceId,
      agentId,
      receivedAt,
      executionCompletedAt,
      completedAt: delivery.failedAt,
      preserveExecutionFailure: !failedBeforeExecutionSettled,
    });
    return;
  }

  // Final chunk with finish_reason
  const finishChunk: ChatCompletionChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: body.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: mapFinishReason(result.finishReason),
      },
    ],
  };
  if (await delivery.write(JSON.stringify(finishChunk))) {

    // Usage chunk (always send -- harmless, and most clients expect it)
    const usageChunk: ChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [],
      usage: {
        prompt_tokens: result.tokensUsed.input,
        completion_tokens: result.tokensUsed.output,
        total_tokens: result.tokensUsed.total,
      },
    };
    await delivery.write(JSON.stringify(usageChunk));

    // Terminal marker
    await delivery.write("[DONE]");
  }
  if (delivery.failedAt !== undefined) {
    deps.logger.error(
      {
        ...(delivery.error !== undefined
          ? { err: formatGatewayErrorForLog(delivery.error) }
          : {}),
        completionId,
        hint: "Check client connectivity and gateway stream delivery",
        errorKind: "platform" as const,
      },
      "OpenAI streaming delivery failed",
    );
    emitDeliveryFailureDiagnostic(deps, {
      result,
      sessionKey,
      completionId,
      traceId,
      agentId,
      receivedAt,
      executionCompletedAt,
      completedAt: delivery.failedAt,
      preserveExecutionFailure: true,
    });
    return;
  }

  // A stream is successful only after its terminal protocol writes resolve.
  emitCompletionDiagnostic(deps, {
    result,
    sessionKey,
    completionId,
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
 * Create an OpenAI-compatible /v1/chat/completions route handler.
 *
 * Returns a Hono app with a single POST / handler. Mount at
 * `/v1/chat/completions` in the parent router.
 *
 * Supports:
 * - Non-streaming: returns ChatCompletion JSON
 * - Streaming: returns SSE chunks with role delta, content deltas,
 *   finish_reason, optional usage, and [DONE] marker
 */
export function createOpenaiCompletionsRoute(
  deps: OpenaiCompletionsDeps,
): Hono<OpenaiCompletionsEnv> {
  const app = new Hono<OpenaiCompletionsEnv>();

  app.post("/", async (c) => {
    try {
      // Parse and validate request body
      const rawBody = await c.req.json();
      const parseResult = ChatCompletionRequestSchema.safeParse(rawBody);

      if (!parseResult.success) {
        // Extract first failing parameter name from Zod issues
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
      // Turn-lifecycle clock for the diagnostic:message_processed emit (resolve + obs).
      const receivedAt = systemNowMs();

      // Multimodal input parses at the wire boundary, but vision execution is
      // not supported here. Reject image blocks instead of dropping them.
      if (body.messages.some((m) => flattenMessageContent(m.content).hasImage)) {
        return c.json(createOpenAIError(400, VISION_UNSUPPORTED_MESSAGE, "messages"), 400);
      }

      const conversation = prepareApiConversation(body.messages.map((entry) => ({
        role: entry.role,
        content: flattenMessageContent(entry.content).text,
      })));
      if (!conversation) {
        return c.json(
          createOpenAIError(400, "No user message found in messages array"),
          400,
        );
      }
      const userMessage = conversation.message;
      const systemPrompt = conversation.systemPrompt;

      // Optional model alias resolution
      let resolvedModel: ReturnType<NonNullable<OpenaiCompletionsDeps["resolveModel"]>> = undefined;
      if (deps.resolveModel) {
        resolvedModel = deps.resolveModel(body.model);
        if (!resolvedModel) {
          return c.json(
            createOpenAIError(404, `Model not found: ${body.model}`),
            404,
          );
        }
      }

      // Generate completion identifiers
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(systemNowMs() / 1000);
      const traceId = crypto.randomUUID();
      const agentId = resolvedModel?.agentId ?? deps.agentId ?? "default";

      // Build session key for OpenAI compat requests
      const sessionKey = {
        userId: "openai-api",
        channelId: "openai",
        peerId: completionId,
      };

      // -----------------------------------------------------------------
      // Streaming path
      // -----------------------------------------------------------------
      if (body.stream) {
        return streamSSE(c, async (stream) => {
          await handleStreamingCompletion({
            stream,
            deps,
            body,
            userMessage,
            systemPrompt,
            completionId,
            created,
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
              completionId,
              hint: "Check client connectivity and gateway request cancellation",
              errorKind: "platform" as const,
            },
            "OpenAI non-streaming request disconnected during execution",
          );
          emitDeliveryFailureDiagnostic(deps, {
            sessionKey,
            completionId,
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
            completionId,
            hint: "Inspect agent execution logs for the originating boundary",
            errorKind: "internal" as const,
          },
          "Agent execution failed",
        );
        emitExecutionFailureDiagnostic(deps, {
          sessionKey,
          completionId,
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
            completionId,
            hint: "Check client connectivity and gateway request cancellation",
            errorKind: "platform" as const,
          },
          "OpenAI non-streaming request disconnected before response delivery",
        );
        emitDeliveryFailureDiagnostic(deps, {
          result,
          sessionKey,
          completionId,
          traceId,
          agentId,
          receivedAt,
          executionCompletedAt,
          completedAt: executionCompletedAt,
        });
        return c.json(createOpenAIError(500, "Request delivery cancelled"), 500);
      }
      // Turn completed — emit the per-turn diagnostic (resolve + obs). Non-streaming path.
      emitCompletionDiagnostic(deps, {
        result,
        sessionKey,
        completionId,
        traceId,
        agentId,
        receivedAt,
        executionCompletedAt,
      });

      const completion: ChatCompletion = {
        id: completionId,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.response },
            finish_reason: mapFinishReason(result.finishReason),
          },
        ],
        usage: {
          prompt_tokens: result.tokensUsed.input,
          completion_tokens: result.tokensUsed.output,
          total_tokens: result.tokensUsed.total,
        },
      };

      return c.json(completion);
    } catch (err) {
      deps.logger.error(
        {
          err: formatGatewayErrorForLog(err),
          hint: "Inspect the request body and agent configuration",
          errorKind: "internal" as const,
        },
        "OpenAI completions endpoint error",
      );
      return c.json(createOpenAIError(500, "Internal server error"), 500);
    }
  });

  return app;
}
