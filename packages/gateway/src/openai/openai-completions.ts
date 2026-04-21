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

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { suppressError } from "@comis/shared";
import {
  ChatCompletionRequestSchema,
  createOpenAIError,
  mapFinishReason,
  type ChatCompletion,
  type ChatCompletionChunk,
} from "./openai-types.js";

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
  /** Execute an agent turn with optional streaming callback. */
  executeAgent: (params: {
    message: string;
    systemPrompt?: string;
    sessionKey?: { userId: string; channelId: string; peerId: string };
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
  sessionKey: { userId: string; channelId: string; peerId: string };
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
  } = params;

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
  await stream.writeSSE({ data: JSON.stringify(roleChunk) });

  // Execute agent with onDelta callback for content streaming
  const onDelta = (delta: string): void => {
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
    suppressError(
      stream.writeSSE({ data: JSON.stringify(contentChunk) }),
      "Stream may have been closed by client -- ignore write errors",
    );
  };

  let result: Awaited<ReturnType<typeof deps.executeAgent>>;
  try {
    result = await deps.executeAgent({
      message: userMessage,
      systemPrompt,
      sessionKey,
      onDelta,
    });
  } catch (err) {
    deps.logger.error(
      {
        err,
        completionId,
        hint: "Check agent executor logs or LLM provider connectivity",
        errorKind: "dependency" as const,
      },
      "Agent execution failed during streaming",
    );
    // Write error as a data event before closing
    await stream.writeSSE({
      data: JSON.stringify(
        createOpenAIError(500, "Internal server error"),
      ),
    });
    await stream.writeSSE({ data: "[DONE]" });
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
  await stream.writeSSE({ data: JSON.stringify(finishChunk) });

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
  await stream.writeSSE({ data: JSON.stringify(usageChunk) });

  // Terminal marker
  await stream.writeSSE({ data: "[DONE]" });
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
): Hono {
  const app = new Hono();

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

      // Extract system messages (concatenate all system role messages in order)
      const systemParts: string[] = [];
      for (const m of body.messages) {
        if (m.role === "system") {
          systemParts.push(m.content);
        }
      }
      const systemPrompt = systemParts.length > 0 ? systemParts.join("\n") : undefined;

      // Extract the last user message as agent input
      let userMessage = "";
      for (let i = body.messages.length - 1; i >= 0; i--) {
        if (body.messages[i].role === "user") {
          userMessage = body.messages[i].content;
          break;
        }
      }

      if (!userMessage) {
        return c.json(
          createOpenAIError(400, "No user message found in messages array"),
          400,
        );
      }

      // Optional model alias resolution
      if (deps.resolveModel) {
        const resolved = deps.resolveModel(body.model);
        if (!resolved) {
          return c.json(
            createOpenAIError(404, `Model not found: ${body.model}`),
            404,
          );
        }
      }

      // Generate completion identifiers
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

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
          });
        });
      }

      // -----------------------------------------------------------------
      // Non-streaming path
      // -----------------------------------------------------------------
      const result = await deps.executeAgent({
        message: userMessage,
        systemPrompt,
        sessionKey,
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
          err,
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
