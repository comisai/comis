// SPDX-License-Identifier: Apache-2.0
/**
 * Memory Store Tool: Explicitly store a memory entry.
 *
 * Delegates to the daemon-side memory.store RPC method to persist
 * facts, preferences, or other information the agent should remember.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { jsonResult, readStringParam } from "../tool-helpers.js";

import type { RpcCall } from "./memory-search-tool.js";

// Activity label spec. Descriptor name == emitted name.
registerActivityLabelSpec("memory_store", {
  semanticPhase: "memory",
  label: "storing memory",
});

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

        // Secret check now handled by validateMemoryWrite in @comis/core.
        // The daemon-side validator (memory-write-validator.ts) calls scrubSecretsFromText
        // as the FIRST check before any persistence — no redundant pattern match needed here.

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
