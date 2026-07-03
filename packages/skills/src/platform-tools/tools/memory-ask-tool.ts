// SPDX-License-Identifier: Apache-2.0
/**
 * Memory Ask Tool: the dialectic's grounded Q&A.
 *
 * Delegates to the daemon-side `memory.ask` RPC, which runs the LLM-free recall
 * pipeline for the question and synthesizes a cited answer over the
 * trust-filtered + redacted recall output (the ONE allowed query-time LLM call,
 * daemon-side). The tool returns `{ answer, citations, abstained }` — the
 * citations are recalled memory ids, and `abstained` is the explicit
 * mandatory-abstention signal (insufficient grounding ⇒ no fabricated answer).
 *
 * This tool is a THIN rpcCall dispatcher: it holds NO model and NO DB handle
 * (the `@comis/skills` tier discipline). It MUST NOT import the LLM-call package
 * (`@earendil-works/pi`-agent's ai module) or resolve a model — the synthesis
 * seam lives in the daemon. Registration and the opt-in
 * `dialectic.enabled` gate live in the registry/setup-tools layer (this file
 * only defines the factory).
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { registerActivityLabelSpec } from "@comis/core";
import { jsonResult, readStringParam, readNumberParam } from "../tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec. Descriptor name == emitted name.
registerActivityLabelSpec("memory_ask", {
  semanticPhase: "memory",
  label: "asking memory",
});

// -- Parameter Schema --------------------------------------------------------

const MemoryAskParams = Type.Object({
  question: Type.String({
    description: "The question to answer from the agent's memory",
  }),
  limit: Type.Optional(
    Type.Number({ description: "Max memories to ground the answer over" }),
  ),
});

// -- Factory -----------------------------------------------------------------

/**
 * Create the `memory_ask` tool — a grounded, cited Q&A over the agent's memory.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing memory_ask
 */
export function createMemoryAskTool(rpcCall: RpcCall): AgentTool<typeof MemoryAskParams> {
  return {
    name: "memory_ask",
    label: "Ask Memory",
    description:
      "Ask a grounded question over the agent's memory. Returns a cited answer built " +
      "ONLY from recalled memories (citations are memory ids), or abstains when memory " +
      "does not contain the answer.",
    parameters: MemoryAskParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const question = readStringParam(params, "question");
      const limit = readNumberParam(params, "limit", false);

      // rpcCall + readStringParam/readNumberParam errors propagate as-is (the dispatcher
      // converts them to the tool-error result). The prior try/catch was a no-op —
      // both branches rethrew `err`, the only effect being a non-Error normalization that the
      // single fallthrough already covered. Dropped; nothing here can throw a non-Error.
      const result = await rpcCall("memory.ask", {
        question,
        ...(limit !== undefined && { limit }),
      });
      return jsonResult(result);
    },
  };
}
