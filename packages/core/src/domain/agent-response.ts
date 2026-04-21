// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * A single tool invocation requested by the agent.
 */
export const ToolCallSchema = z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
  });

export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * Token usage breakdown for observability and budget tracking.
 */
export const TokenUsageSchema = z.strictObject({
    prompt: z.number().int().nonnegative(),
    completion: z.number().int().nonnegative(),
    provider: z.string().min(1),
    model: z.string().min(1),
  });

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * AgentResponse: The structured output from an AI agent invocation.
 *
 * Captures content, tool calls, token usage (for budget guards), and
 * finish reason to drive orchestration decisions.
 */
export const AgentResponseSchema = z.strictObject({
    agentId: z.string().min(1),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema).default([]),
    tokensUsed: TokenUsageSchema.optional(),
    finishReason: z
      .enum(["stop", "max_tokens", "tool_use", "error", "budget_exceeded"])
      .default("stop"),
    metadata: z.record(z.string(), z.unknown()).default({}),
  });

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/**
 * Parse unknown input into an AgentResponse, returning Result<T, ZodError>.
 */
export function parseAgentResponse(raw: unknown): Result<AgentResponse, z.ZodError> {
  const result = AgentResponseSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}
