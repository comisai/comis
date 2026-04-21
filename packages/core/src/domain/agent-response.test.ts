// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseAgentResponse } from "./agent-response.js";

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "main-agent",
    content: "Here is my response.",
    ...overrides,
  };
}

describe("AgentResponse", () => {
  describe("valid data", () => {
    it("parses a minimal valid response", () => {
      const result = parseAgentResponse(validResponse());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agentId).toBe("main-agent");
        expect(result.value.content).toBe("Here is my response.");
      }
    });

    it("applies default values for toolCalls, finishReason, metadata", () => {
      const result = parseAgentResponse(validResponse());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toolCalls).toEqual([]);
        expect(result.value.finishReason).toBe("stop");
        expect(result.value.metadata).toEqual({});
      }
    });

    it("accepts empty content (agent may return only tool calls)", () => {
      const result = parseAgentResponse(validResponse({ content: "" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("");
      }
    });

    it("accepts all finish reasons", () => {
      const reasons = ["stop", "max_tokens", "tool_use", "error", "budget_exceeded"] as const;
      for (const finishReason of reasons) {
        const result = parseAgentResponse(validResponse({ finishReason }));
        expect(result.ok).toBe(true);
      }
    });

    it("accepts tool calls array", () => {
      const result = parseAgentResponse(
        validResponse({
          toolCalls: [
            { id: "tc-1", name: "search", input: { query: "test" } },
            { id: "tc-2", name: "read_file", input: { path: "/tmp/a.txt" } },
          ],
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toolCalls).toHaveLength(2);
        expect(result.value.toolCalls[0].name).toBe("search");
      }
    });

    it("accepts tokensUsed when provided", () => {
      const result = parseAgentResponse(
        validResponse({
          tokensUsed: {
            prompt: 100,
            completion: 50,
            provider: "anthropic",
            model: "claude-opus-4-20250514",
          },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tokensUsed?.prompt).toBe(100);
        expect(result.value.tokensUsed?.provider).toBe("anthropic");
      }
    });

    it("allows omitting optional tokensUsed", () => {
      const result = parseAgentResponse(validResponse());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tokensUsed).toBeUndefined();
      }
    });

    it("accepts metadata with arbitrary values", () => {
      const result = parseAgentResponse(
        validResponse({
          metadata: { latencyMs: 234, cached: false },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata).toEqual({
          latencyMs: 234,
          cached: false,
        });
      }
    });
  });

  describe("invalid data", () => {
    it("rejects missing required fields", () => {
      const result = parseAgentResponse({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("agentId");
        expect(paths).toContain("content");
      }
    });

    it("rejects empty agentId", () => {
      const result = parseAgentResponse(validResponse({ agentId: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects invalid finishReason", () => {
      const result = parseAgentResponse(validResponse({ finishReason: "cancelled" }));
      expect(result.ok).toBe(false);
    });

    it("rejects invalid tool call shape", () => {
      const result = parseAgentResponse(validResponse({ toolCalls: [{ bad: "shape" }] }));
      expect(result.ok).toBe(false);
    });

    it("rejects tool call with empty id", () => {
      const result = parseAgentResponse(
        validResponse({
          toolCalls: [{ id: "", name: "search", input: {} }],
        }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects tool call with empty name", () => {
      const result = parseAgentResponse(
        validResponse({
          toolCalls: [{ id: "tc-1", name: "", input: {} }],
        }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects invalid tokensUsed shape", () => {
      const result = parseAgentResponse(validResponse({ tokensUsed: { prompt: "not a number" } }));
      expect(result.ok).toBe(false);
    });

    it("rejects negative token counts", () => {
      const result = parseAgentResponse(
        validResponse({
          tokensUsed: {
            prompt: -1,
            completion: 50,
            provider: "openai",
            model: "gpt-4",
          },
        }),
      );
      expect(result.ok).toBe(false);
    });

    it("strips extra/unknown fields", () => {
      const result = parseAgentResponse(validResponse({ unknownField: "surprise" }));
      expect(result.ok).toBe(false);
    });

    it("rejects non-object input", () => {
      const result = parseAgentResponse(42);
      expect(result.ok).toBe(false);
    });

    it("returns descriptive ZodError issues", () => {
      const result = parseAgentResponse({ agentId: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        for (const issue of result.error.issues) {
          expect(issue.message).toBeTruthy();
        }
      }
    });
  });
});
