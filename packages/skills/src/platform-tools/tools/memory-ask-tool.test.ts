// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link createMemoryAskTool} (Phase 109 — DIAL-01/02): the thin
 * `memory_ask` AgentTool that dispatches a grounded question to the daemon
 * `memory.ask` RPC and wraps the cited answer. RED-first: the factory module
 * does not exist until the GREEN patch.
 *
 * The contract these tests pin:
 *   - the tool is named `memory_ask` and declares a required string `question`
 *     (+ optional numeric `limit`);
 *   - `.execute` dispatches `rpcCall("memory.ask", { question, limit? })` and
 *     returns whatever `jsonResult` wraps around the RPC result
 *     (`{ answer, citations, abstained }`);
 *   - a missing `question` throws (via `readStringParam`) and the RPC is NOT
 *     called with an empty question;
 *   - the tool source holds NO model — it never imports `@earendil-works/pi-ai`
 *     and never resolves a model. The synthesis LLM lives in the daemon seam
 *     (Plan 03), NOT in the skills tool (the `@comis/skills` tier discipline,
 *     T-109-03 — RESEARCH "Tier-misassignment to avoid").
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryAskTool } from "./memory-ask-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "memory.ask") {
      return { answer: "UTC", citations: ["id1"], abstained: false };
    }
    return { stub: true, method, params };
  });
}

describe("memory_ask tool", () => {
  it("is named memory_ask and declares a required string question + optional numeric limit", () => {
    const tool = createMemoryAskTool(createMockRpcCall());
    expect(tool.name).toBe("memory_ask");
    // The parameter schema requires `question` and leaves `limit` optional.
    const props = tool.parameters.properties as Record<string, { type?: string }>;
    expect(props.question?.type).toBe("string");
    expect(props.limit?.type).toBe("number");
    const required = (tool.parameters as { required?: string[] }).required ?? [];
    expect(required).toContain("question");
    expect(required).not.toContain("limit");
  });

  it("dispatches the question to memory.ask and returns the jsonResult-wrapped answer", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemoryAskTool(rpcCall);

    const result = await tool.execute("call-1", { question: "what is my timezone?" });

    expect(rpcCall).toHaveBeenCalledWith(
      "memory.ask",
      expect.objectContaining({ question: "what is my timezone?" }),
    );
    // jsonResult wraps the rpc result on `details` (and JSON text in content).
    expect(result.details).toEqual({ answer: "UTC", citations: ["id1"], abstained: false });
  });

  it("forwards an optional numeric limit when provided (omitted otherwise)", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemoryAskTool(rpcCall);

    await tool.execute("call-2", { question: "q", limit: 5 });
    expect(rpcCall).toHaveBeenCalledWith("memory.ask", { question: "q", limit: 5 });

    rpcCall.mockClear();
    await tool.execute("call-3", { question: "q" });
    expect(rpcCall).toHaveBeenCalledWith("memory.ask", { question: "q" });
  });

  it("throws when question is missing and never calls the RPC with an empty question", async () => {
    const rpcCall = createMockRpcCall();
    const tool = createMemoryAskTool(rpcCall);

    await expect(tool.execute("call-4", {})).rejects.toThrow("Missing required parameter: question");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rethrows an rpcCall error", async () => {
    const rpcCall = vi.fn(async () => {
      throw new Error("Memory service unavailable");
    });
    const tool = createMemoryAskTool(rpcCall);
    await expect(tool.execute("call-5", { question: "q" })).rejects.toThrow(
      "Memory service unavailable",
    );
  });

  it("the tool source NEVER imports a model (no @earendil-works/pi-ai, no getModel)", () => {
    // The synthesis LLM lives in the daemon seam (Plan 03), not the skills tool.
    // T-109-03: the tool holds no model/DB and cannot widen scope — it only
    // dispatches via rpcCall. Assert by source-grep (the AC's `grep -c pi-ai === 0`).
    const src = readFileSync(fileURLToPath(new URL("./memory-ask-tool.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/pi-ai/);
    expect(src).not.toMatch(/getModel|completeSimple/);
  });
});
