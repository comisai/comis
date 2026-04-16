import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so mock fns are available inside the hoisted vi.mock factory
const { mockGetModel, mockCompleteSimple } = vi.hoisted(() => ({
  mockGetModel: vi.fn(),
  mockCompleteSimple: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: mockGetModel,
  completeSimple: mockCompleteSimple,
}));

import { createGreetingGenerator, type GreetingGeneratorDeps } from "./session-greeting.js";

describe("createGreetingGenerator", () => {
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

  it("returns greeting text on successful LLM response", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "Hello! How can I help you today?" }],
    });

    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("TestBot");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello! How can I help you today?");
    }
  });

  it("returns err on empty response", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [],
    });

    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("TestBot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Empty greeting response");
    }
  });

  it("returns err when completeSimple throws", async () => {
    mockCompleteSimple.mockRejectedValue(new Error("LLM provider unavailable"));

    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("TestBot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Greeting generation failed");
      expect(result.error.message).toContain("LLM provider unavailable");
    }
  });

  it("returns err when getModel throws", async () => {
    mockGetModel.mockImplementation(() => {
      throw new Error("Unknown provider");
    });

    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("TestBot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to resolve model");
      expect(result.error.message).toContain("Unknown provider");
    }
  });

  it("returns err when getModel returns undefined", async () => {
    mockGetModel.mockReturnValue(undefined);

    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("TestBot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Model not found");
    }
  });

  it("uses provided agentName in system prompt", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "Hi there!" }],
    });

    const gen = createGreetingGenerator(baseDeps);
    await gen.generate("SuperAgent");

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    const callArgs = mockCompleteSimple.mock.calls[0];
    const messageArg = callArgs[1];
    expect(messageArg.systemPrompt).toContain("SuperAgent");
  });

  it("handles whitespace-only response as empty", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "   \n  " }],
    });

    const gen = createGreetingGenerator(baseDeps);
    const result = await gen.generate("TestBot");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Empty greeting response");
    }
  });

  it("logs debug message when logger is provided", async () => {
    const mockLogger = { debug: vi.fn() };
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
    });

    const gen = createGreetingGenerator({ ...baseDeps, logger: mockLogger });
    await gen.generate("LogBot");

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "LogBot" }),
      expect.stringContaining("Generating session greeting"),
    );
  });
});
