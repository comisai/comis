// SPDX-License-Identifier: Apache-2.0
/**
 * API payload trace writer stream wrapper.
 *
 * Writes pre-call and post-call JSONL trace lines per LLM call with
 * request payload details and token usage.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";
import { suppressError } from "@comis/shared";

import type { StreamFnWrapper } from "./types.js";
import { appendJsonlLine } from "./cache-trace-writer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the API payload trace JSONL writer wrapper.
 */
export interface ApiPayloadTraceConfig {
  /** Absolute path to the JSONL trace output file */
  filePath: string;
  /** Agent ID for trace attribution */
  agentId?: string;
  /** Session ID for trace correlation */
  sessionId?: string;
  /** Max file size before rotation (k/m/g suffix). Undefined = no rotation. */
  maxSize?: string;
  /** Number of rotated files to keep. Undefined = no rotation. */
  maxFiles?: number;
}

/**
 * Create a wrapper that writes pre-call and post-call JSONL trace lines
 * per LLM call with request payload details and token usage.
 *
 * Pre-call line: model, provider, message count, stream options.
 * Post-call line: token usage (input/output/cacheRead/cacheWrite) captured
 * asynchronously via fire-and-forget on the stream result promise.
 *
 * Purpose: Per-call observability for cost analysis.
 *
 * @param config - API payload trace configuration (file path, optional agent ID)
 * @param logger - Logger for debug output
 * @returns A named StreamFnWrapper ("apiPayloadTraceWriter")
 */
export function createApiPayloadTraceWriter(
  config: ApiPayloadTraceConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function apiPayloadTraceWriter(next: StreamFn): StreamFn {
    return (model, context, options) => {
      // Extract relevant option keys for the pre-call trace
      const traceOptions: Record<string, unknown> = {};
      if (options) {
        const opts = options as Record<string, unknown>;
        for (const key of ["maxTokens", "temperature", "cacheRetention"]) {
          if (opts[key] !== undefined) {
            traceOptions[key] = opts[key];
          }
        }
      }

      // Pre-call trace line
      appendJsonlLine(
        config.filePath,
        {
          ts: new Date().toISOString(),
          type: "api_payload",
          agentId: config.agentId,
          sessionId: config.sessionId,
          modelId: model.id,
          provider: model.provider,
          messageCount: context.messages.length,
          options: traceOptions,
        },
        logger,
        config.maxSize,
        config.maxFiles,
      );

      // TTFT measurement -- record start time before stream call
      const streamStartMs = Date.now();

      const stream = next(model, context, options);

      // Post-call usage capture + TTFT (fire-and-forget)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK stream result() is untyped
      const resultPromise = (stream as any)?.result?.();
      if (resultPromise && typeof resultPromise.then === "function") {
        const usageCapture = resultPromise.then((msg: unknown) => {
          // Capture TTFT when stream result resolves (first available timing point)
          const ttftMs = Date.now() - streamStartMs;
          logger.debug(
            {
              ttftMs,
              modelId: model.id,
              provider: model.provider,
              agentId: config.agentId,
              sessionId: config.sessionId,
            },
            "TTFT (time-to-first-token proxy)",
          );

          const usage = (msg as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
          if (usage) {
            appendJsonlLine(
              config.filePath,
              {
                ts: new Date().toISOString(),
                type: "api_usage",
                agentId: config.agentId,
                sessionId: config.sessionId,
                modelId: model.id,
                provider: model.provider,
                usage: {
                  input: usage.input,
                  output: usage.output,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  totalTokens: usage.totalTokens,
                },
              },
              logger,
              config.maxSize,
              config.maxFiles,
            );
          }
        });
        suppressError(usageCapture, "trace usage capture");
      }

      return stream;
    };
  };
}
