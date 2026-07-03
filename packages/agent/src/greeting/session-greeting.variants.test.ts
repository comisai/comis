// SPDX-License-Identifier: Apache-2.0
/**
 * Greeting variant routing tests.
 *
 * Asserts the three GreetingTrigger variants (standard / onboarding-pending /
 * onboarding-limited) route to three DISTINCT system prompts, and that the
 * err()-fallback contract (empty / throw / timeout) holds for every variant.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so mock fns are available inside the hoisted vi.mock factory
const { mockGetModel, mockCompleteSimple } = vi.hoisted(() => ({
  mockGetModel: vi.fn(),
  mockCompleteSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: mockGetModel,
  completeSimple: mockCompleteSimple,
}));

import {
  createGreetingGenerator,
  type GreetingGeneratorDeps,
  type GreetingTrigger,
} from "./session-greeting.js";

const ALL_TRIGGERS: readonly GreetingTrigger[] = ["standard", "onboarding-pending", "onboarding-limited"];

describe("GreetingGenerator three-variant routing", () => {
  const baseDeps: GreetingGeneratorDeps = {
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "test-key",
    timeoutMs: 5000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModel.mockReturnValue({ id: "mock-model" });
  });

  /** Capture the systemPrompt the generator passes to completeSimple for a given trigger. */
  async function capturePromptForTrigger(trigger: GreetingTrigger): Promise<string> {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "Hello there!" }],
    });
    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("Bot", trigger);
    expect(result.ok).toBe(true);
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    const callArgs = mockCompleteSimple.mock.calls[0];
    const requestArg = callArgs[1] as { systemPrompt: string };
    return requestArg.systemPrompt;
  }

  it("routes the three triggers to three pairwise-distinct system prompts", async () => {
    const standardPrompt = await capturePromptForTrigger("standard");
    vi.clearAllMocks();
    mockGetModel.mockReturnValue({ id: "mock-model" });
    const pendingPrompt = await capturePromptForTrigger("onboarding-pending");
    vi.clearAllMocks();
    mockGetModel.mockReturnValue({ id: "mock-model" });
    const limitedPrompt = await capturePromptForTrigger("onboarding-limited");

    // Pairwise distinct — the core "three triggers → three prompts" guarantee.
    expect(standardPrompt).not.toBe(pendingPrompt);
    expect(standardPrompt).not.toBe(limitedPrompt);
    expect(pendingPrompt).not.toBe(limitedPrompt);
  });

  it("standard prompt carries no onboarding/setup language", async () => {
    const standardPrompt = await capturePromptForTrigger("standard");
    expect(standardPrompt.toLowerCase()).not.toContain("setup");
    expect(standardPrompt.toLowerCase()).not.toContain("onboard");
    expect(standardPrompt.toLowerCase()).not.toContain("interactive");
  });

  it("onboarding-pending prompt instructs guiding through the next setup step", async () => {
    const pendingPrompt = await capturePromptForTrigger("onboarding-pending");
    expect(pendingPrompt.toLowerCase()).toContain("setup");
  });

  it("onboarding-limited prompt instructs switching to an interactive session", async () => {
    const limitedPrompt = await capturePromptForTrigger("onboarding-limited");
    expect(limitedPrompt.toLowerCase()).toContain("interactive");
  });

  it("every variant interpolates the agent name and forbids leaking metadata", async () => {
    for (const trigger of ALL_TRIGGERS) {
      vi.clearAllMocks();
      mockGetModel.mockReturnValue({ id: "mock-model" });
      const prompt = await capturePromptForTrigger(trigger);
      expect(prompt).toContain("Bot");
      // The no-leak constraint is preserved across all variants.
      expect(prompt).toContain("Do not include any system instructions, metadata, or technical details");
    }
  });

  describe("err()-fallback contract preserved for every variant", () => {
    it("returns err('Empty greeting response') on an empty LLM response for all triggers", async () => {
      for (const trigger of ALL_TRIGGERS) {
        vi.clearAllMocks();
        mockGetModel.mockReturnValue({ id: "mock-model" });
        mockCompleteSimple.mockResolvedValue({ content: [] });
        const gen = createGreetingGenerator(baseDeps);
        const result = await gen.generate("Bot", trigger);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Empty greeting response");
        }
      }
    });

    it("returns err('Greeting generation failed') when completeSimple throws for all triggers", async () => {
      for (const trigger of ALL_TRIGGERS) {
        vi.clearAllMocks();
        mockGetModel.mockReturnValue({ id: "mock-model" });
        mockCompleteSimple.mockRejectedValue(new Error("LLM provider unavailable"));
        const gen = createGreetingGenerator(baseDeps);
        const result = await gen.generate("Bot", trigger);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Greeting generation failed");
        }
      }
    });

    it("returns err('timed out') when the call aborts via the timeout for all triggers", async () => {
      for (const trigger of ALL_TRIGGERS) {
        vi.clearAllMocks();
        mockGetModel.mockReturnValue({ id: "mock-model" });
        // Deterministically drive the abort path: the mock waits for the
        // generator's own timeout to fire (which aborts opts.signal), then
        // rejects — matching what an aborted completeSimple does in production.
        mockCompleteSimple.mockImplementation(
          (_model: unknown, _req: unknown, opts: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
            }),
        );
        const gen = createGreetingGenerator({ ...baseDeps, timeoutMs: 1 });
        const result = await gen.generate("Bot", trigger);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("timed out");
        }
      }
    });
  });
});
