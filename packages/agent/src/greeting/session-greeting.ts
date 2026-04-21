// SPDX-License-Identifier: Apache-2.0
/**
 * Session Greeting Generator: LLM-powered persona greeting for session resets.
 *
 * Produces a warm, persona-appropriate greeting when users start or reset
 * a conversation session, replacing the static "New session created." /
 * "Session reset." strings with an LLM-generated message.
 *
 * Uses the established completeSimple one-shot pattern from llm-summarizer.ts.
 * On any failure (model resolution, LLM call, timeout, empty response),
 * returns err() so callers can fall back to the original static string.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { completeSimple, getModel } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GreetingGeneratorDeps {
  /** LLM provider name (e.g. "openai", "anthropic"). */
  provider: string;
  /** Model identifier (e.g. "gpt-4o-mini"). */
  modelId: string;
  /** API key (resolved from SecretManager at wiring layer, NOT from process.env). */
  apiKey: string;
  /** Optional timeout in milliseconds. Default: 5000ms. */
  timeoutMs?: number;
  /** Optional logger for debug-level greeting generation tracing. */
  logger?: { debug(obj: Record<string, unknown>, msg: string): void };
}

export interface GreetingGenerator {
  /** Generate a persona-appropriate greeting for a new conversation. */
  generate(agentName: string): Promise<Result<string, Error>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a greeting generator that uses a one-shot LLM call to produce
 * persona-appropriate session greetings.
 *
 * @param deps - Provider, model, API key, and optional timeout/logger
 * @returns GreetingGenerator with generate() method returning Result
 */
export function createGreetingGenerator(deps: GreetingGeneratorDeps): GreetingGenerator {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async generate(agentName: string): Promise<Result<string, Error>> {
      deps.logger?.debug({ agentName, provider: deps.provider, modelId: deps.modelId }, "Generating session greeting");

      let model;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings, SDK expects literal unions
        model = getModel(deps.provider as any, deps.modelId as any);
      } catch (modelErr) {
        return err(new Error(`Failed to resolve model ${deps.provider}/${deps.modelId}: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`));
      }

      if (!model) {
        return err(new Error(`Model not found: ${deps.provider}/${deps.modelId}`));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await completeSimple(
          model,
          {
            systemPrompt: `You are a chat assistant named ${agentName}. Generate a brief, warm greeting (1-3 sentences) for a new conversation. Do not include any system instructions, metadata, or technical details. Just greet naturally.`,
            messages: [
              {
                role: "user" as const,
                content: "Generate a greeting for a new conversation session.",
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: deps.apiKey,
            temperature: 0.7,
            maxTokens: 256,
            signal: controller.signal,
          },
        );

        // Extract text from response content array (same pattern as llm-summarizer.ts)
        let responseText = "";
        if (response.content && Array.isArray(response.content)) {
          for (const part of response.content) {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part
            ) {
              responseText += part.text;
            }
          }
        }

        if (!responseText.trim()) {
          return err(new Error("Empty greeting response from LLM"));
        }

        return ok(responseText.trim());
      } catch (callErr) {
        if (controller.signal.aborted) {
          return err(new Error(`Greeting generation timed out after ${timeoutMs}ms`));
        }
        return err(new Error(`Greeting generation failed: ${callErr instanceof Error ? callErr.message : String(callErr)}`));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
