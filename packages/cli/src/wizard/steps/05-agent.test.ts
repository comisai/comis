/**
 * Unit tests for agent identity step (step 05).
 *
 * Verifies agent name collection with validation, quickstart auto-model
 * selection, advanced flow catalog display, empty catalog fallback,
 * and custom provider model skip.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState, ProviderConfig } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

// Mock @comis/agent for createModelCatalog
vi.mock("@comis/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/agent")>();
  return {
    ...actual,
    createModelCatalog: vi.fn(() => ({
      loadStatic: vi.fn(),
      getByProvider: vi.fn(() => []),
    })),
  };
});

import { agentStep } from "./05-agent.js";
import { createModelCatalog } from "@comis/agent";

// ---------- Mock Prompter Factory ----------

function createMockPrompter(
  overrides: Partial<Record<string, unknown>> = {},
): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn().mockResolvedValue(overrides.select),
    multiselect: vi.fn().mockResolvedValue(overrides.multiselect ?? []),
    text: vi.fn().mockResolvedValue(overrides.text ?? ""),
    password: vi.fn().mockResolvedValue(overrides.password ?? ""),
    confirm: vi.fn().mockResolvedValue(overrides.confirm ?? true),
    spinner: vi.fn(
      (): Spinner => ({
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn(),
      }),
    ),
    group: vi.fn(
      async (steps: Record<string, () => Promise<unknown>>) => {
        const results: Record<string, unknown> = {};
        for (const [key, fn] of Object.entries(steps)) {
          results[key] = await fn();
        }
        return results;
      },
    ),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
}

// ---------- Tests ----------

describe("agentStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the correct step id and label", () => {
    expect(agentStep.id).toBe("agent");
    expect(agentStep.label).toBe("Agent Identity");
  });

  it("collects agent name via text prompt", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.text).mockResolvedValueOnce("my-cool-agent");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "quickstart",
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await agentStep.execute(state, prompter);

    expect(result.agentName).toBe("my-cool-agent");
    expect(prompter.text).toHaveBeenCalled();

    // Check the text prompt has validate function
    const textCall = (prompter.text as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { validate?: (v: string) => string | undefined };
    expect(textCall.validate).toBeDefined();
  });

  it("auto-selects default model for quickstart flow", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.text).mockResolvedValueOnce("test-agent");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "quickstart",
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await agentStep.execute(state, prompter);

    expect(result.model).toBe("default");
    // In quickstart, no select() should be called for model
    expect(prompter.select).not.toHaveBeenCalled();
    // Info log should show the auto-selected model
    expect(prompter.log.info).toHaveBeenCalled();
  });

  it("shows model catalog select for advanced flow", async () => {
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic: vi.fn(),
      getByProvider: vi.fn(() => [
        {
          modelId: "claude-sonnet-4-5-20250929",
          displayName: "Claude Sonnet 4.5",
          contextWindow: 200000,
          reasoning: false,
        },
        {
          modelId: "claude-opus-4-20250514",
          displayName: "Claude Opus 4",
          contextWindow: 200000,
          reasoning: true,
        },
      ]),
    } as any);

    const prompter = createMockPrompter();
    vi.mocked(prompter.text).mockResolvedValueOnce("my-agent");
    vi.mocked(prompter.select).mockResolvedValueOnce("claude-opus-4-20250514");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await agentStep.execute(state, prompter);

    expect(result.model).toBe("claude-opus-4-20250514");
    expect(prompter.select).toHaveBeenCalledOnce();

    // Verify options include catalog models + __custom__
    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      options: Array<{ value: string; label: string }>;
    };
    const values = selectCall.options.map(
      (o: { value: string }) => o.value,
    );
    expect(values).toContain("claude-sonnet-4-5-20250929");
    expect(values).toContain("claude-opus-4-20250514");
    expect(values).toContain("__custom__");
  });

  it("falls back to text prompt for model ID when catalog is empty", async () => {
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic: vi.fn(),
      getByProvider: vi.fn(() => []),
    } as any);

    const prompter = createMockPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("my-agent") // agent name
      .mockResolvedValueOnce("custom-model-v1"); // model ID

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "anthropic" } as ProviderConfig,
    };

    const result = await agentStep.execute(state, prompter);

    expect(result.model).toBe("custom-model-v1");
    // No select called (empty catalog -> straight to text input)
    expect(prompter.select).not.toHaveBeenCalled();
    // text() called twice: once for name, once for model
    expect(prompter.text).toHaveBeenCalledTimes(2);
  });

  it("skips model selection entirely for custom provider", async () => {
    const prompter = createMockPrompter();
    vi.mocked(prompter.text).mockResolvedValueOnce("custom-agent");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "custom" } as ProviderConfig,
      model: "already-set-model",
    };

    const result = await agentStep.execute(state, prompter);

    expect(result.agentName).toBe("custom-agent");
    // No select() or second text() called for model
    expect(prompter.select).not.toHaveBeenCalled();
    // text() called only once (for agent name)
    expect(prompter.text).toHaveBeenCalledTimes(1);
  });

  it("handles custom model ID via __custom__ select option", async () => {
    vi.mocked(createModelCatalog).mockReturnValue({
      loadStatic: vi.fn(),
      getByProvider: vi.fn(() => [
        {
          modelId: "gpt-4o",
          displayName: "GPT-4o",
          contextWindow: 128000,
          reasoning: false,
        },
      ]),
    } as any);

    const prompter = createMockPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("my-agent") // agent name
      .mockResolvedValueOnce("gpt-4o-mini"); // custom model ID
    vi.mocked(prompter.select).mockResolvedValueOnce("__custom__");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "openai" } as ProviderConfig,
    };

    const result = await agentStep.execute(state, prompter);

    expect(result.model).toBe("gpt-4o-mini");
    expect(prompter.text).toHaveBeenCalledTimes(2);
  });

  it("handles catalog loading failure gracefully", async () => {
    vi.mocked(createModelCatalog).mockImplementation(() => {
      throw new Error("Catalog unavailable");
    });

    const prompter = createMockPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce("my-agent")
      .mockResolvedValueOnce("fallback-model");

    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "anthropic" } as ProviderConfig,
    };

    // Should not throw, should fall back to text input
    const result = await agentStep.execute(state, prompter);

    expect(result.model).toBe("fallback-model");
    expect(result.agentName).toBe("my-agent");
  });
});
