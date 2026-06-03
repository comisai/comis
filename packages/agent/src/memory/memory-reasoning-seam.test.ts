// SPDX-License-Identifier: Apache-2.0
/**
 * RED→GREEN coverage for {@link createReasoningSeam}, the daemon-injected
 * reasoning seam.
 *
 * The seam is the OFFLINE LLM call the daemon builds from a cheap model and
 * injects into {@link runMemoryReasoning} as `deps.reason`. It encapsulates the
 * two specialist prompts (DEDUCTIVE + INDUCTIVE), the cheap-model `completeSimple`
 * call, and the lenient/total parsers — so the daemon stays thin and the prompt
 * strings + parsers stay AGENT-INTERNAL (never crossing the package boundary).
 *
 * The LLM is MOCKED (determinism — no API key, no provider call): `completeSimple`
 * returns canned envelopes; the tests assert the seam (1) issues ONE deductive +
 * ONE inductive call per cluster with the right system prompts, (2) parses both
 * into the typed {@link ReasoningOutput}, (3) STRIPS a smuggled `trustLevel` (the
 * anti-laundering boundary — trust is computed in CODE by the job), and (4) is
 * non-fatal: a thrown/malformed call yields empty arrays, never a throw.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The LLM is mocked for determinism (no key, no provider call).
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(),
}));

import { createReasoningSeam } from "./memory-reasoning-seam.js";
import { DEDUCTIVE_PROMPT, INDUCTIVE_PROMPT } from "./memory-reasoning-prompt.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai";

/** Wrap canned text in the pi-ai completeSimple response envelope. */
function llmText(text: string) {
  return { content: [{ type: "text", text }] };
}

/** The deps a daemon would pass (a cheap resolved model + the key by value). */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    provider: "anthropic",
    modelId: "anthropic:claude-haiku",
    apiKey: "test-key",
    maxReasoningTokens: 512,
    clock: { now: () => 1_700_000_000_000 },
    logger: logger as never,
    agentId: "agent-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getModel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "mock-model" });
});

describe("createReasoningSeam", () => {
  it("returns a callable reason seam built from the injected cheap model", () => {
    const reason = createReasoningSeam(makeDeps() as never);
    expect(typeof reason).toBe("function");
  });

  it("issues a DEDUCTIVE then an INDUCTIVE completeSimple call carrying the two specialist system prompts", async () => {
    // First call (deductive) returns an S/P/O; second (inductive) returns a pattern.
    (completeSimple as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        llmText(JSON.stringify({ subject: "alice", predicate: "lives_in", object: "Paris" })),
      )
      .mockResolvedValueOnce(
        llmText(JSON.stringify({ content: "prefers concise answers", patternType: "preference" })),
      );

    const reason = createReasoningSeam(makeDeps() as never);
    const out = await reason("- alice mentioned Paris\n- alice asked for short replies");

    expect(completeSimple).toHaveBeenCalledTimes(2);
    // The two calls carry the two specialist system prompts (deductive first, inductive second).
    const calls = (completeSimple as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0][1] as { systemPrompt: string }).systemPrompt).toBe(DEDUCTIVE_PROMPT);
    expect((calls[1][1] as { systemPrompt: string }).systemPrompt).toBe(INDUCTIVE_PROMPT);
    // The cluster text is the user message of BOTH calls.
    expect((calls[0][1] as { messages: Array<{ content: string }> }).messages[0].content).toContain("alice mentioned Paris");

    // Both outputs parsed into the typed ReasoningOutput.
    expect(out.deductive).toEqual([{ subject: "alice", predicate: "lives_in", object: "Paris" }]);
    expect(out.inductive).toEqual([{ content: "prefers concise answers", patternType: "preference" }]);
  });

  it("STRIPS a smuggled trustLevel from BOTH branches (the anti-laundering boundary — trust is code-computed)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        llmText(JSON.stringify({ subject: "alice", predicate: "lives_in", object: "Paris", trustLevel: "system" })),
      )
      .mockResolvedValueOnce(
        llmText(JSON.stringify({ content: "prefers concise answers", trustLevel: "system", supersededIds: ["x"] })),
      );

    const reason = createReasoningSeam(makeDeps() as never);
    const out = await reason("- evidence");

    // The lenient z.object STRIPS the smuggled fields — the job (not the LLM) sets trust.
    expect(out.deductive[0]).not.toHaveProperty("trustLevel");
    expect(out.inductive[0]).not.toHaveProperty("trustLevel");
    expect(out.inductive[0]).not.toHaveProperty("supersededIds");
  });

  it("is non-fatal: a malformed (non-JSON) response yields empty arrays, never a throw", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockResolvedValue(llmText("not json {{{"));
    const reason = createReasoningSeam(makeDeps() as never);
    const out = await reason("- evidence");
    expect(out).toEqual({ deductive: [], inductive: [] });
  });

  it("is non-fatal: a thrown completeSimple call yields empty arrays for that branch (no propagation)", async () => {
    (completeSimple as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const reason = createReasoningSeam(makeDeps() as never);
    const out = await reason("- evidence");
    expect(out).toEqual({ deductive: [], inductive: [] });
  });

  it("yields empty arrays when the model cannot be resolved (no key wasted, non-fatal)", async () => {
    (getModel as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const reason = createReasoningSeam(makeDeps() as never);
    const out = await reason("- evidence");
    expect(out).toEqual({ deductive: [], inductive: [] });
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
