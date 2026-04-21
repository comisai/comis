// SPDX-License-Identifier: Apache-2.0
/**
 * Memory Store Tool: Explicitly store a memory entry.
 *
 * Delegates to the daemon-side memory.store RPC method to persist
 * facts, preferences, or other information the agent should remember.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";

import type { RpcCall } from "./memory-search-tool.js";

// ── Secret detection ────────────────────────────────────────────────

/** Patterns that suggest content contains an API key or secret. */
const SECRET_PATTERNS = [
  /\bAIza[A-Za-z0-9_-]{30,}\b/,      // Google / Gemini
  /\bsk-[A-Za-z0-9]{20,}\b/,          // OpenAI / Anthropic
  /\bgsk_[A-Za-z0-9]{20,}\b/,         // Groq
  /\bghp_[A-Za-z0-9]{36,}\b/,         // GitHub PAT
  /\btvly-[A-Za-z0-9]{20,}\b/,        // Tavily
  /\bxai-[A-Za-z0-9]{20,}\b/,         // xAI
];

function contentLooksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// ── Parameter Schema ────────────────────────────────────────────────

const MemoryStoreParams = Type.Object({
  content: Type.String({ description: "The text content to store in memory" }),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Optional tags for categorisation (e.g. ['preference', 'fact'])" }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a memory store tool that persists information for future recall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing memory_store
 */
export function createMemoryStoreTool(rpcCall: RpcCall): AgentTool<typeof MemoryStoreParams> {
  return {
    name: "memory_store",
    label: "Memory Store",
    description:
      "Store information in long-term memory for future recall. Use this to save facts, preferences, or important context that should persist across conversations.",
    parameters: MemoryStoreParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const content = readStringParam(params, "content");
        const tags = Array.isArray(params.tags)
          ? (params.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];

        const result = await rpcCall("memory.store", { content, tags });

        // Warn if content appears to contain an API key or secret
        if (content && contentLooksLikeSecret(content)) {
          return jsonResult({
            ...((typeof result === "object" && result !== null) ? result : { stored: true }),
            warning: "This content appears to contain an API key or secret. Consider using environment variables ($HOME/.env or config.yaml SecretRef) instead of storing secrets in memory — they may leak into session logs when retrieved.",
          });
        }

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
