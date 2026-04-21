// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tool providers step (step 08b).
 *
 * Verifies multiselect behavior, API key collection,
 * empty selection handling, and existing config preservation.
 */

import { describe, it, expect, vi } from "vitest";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { toolProvidersStep } from "./08b-tool-providers.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    multiselect?: string[][];
    password?: string[];
  } = {},
): WizardPrompter {
  const multiselectQueue = [...(responses.multiselect ?? [])];
  const passwordQueue = [...(responses.password ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async () => ""),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => multiselectQueue.shift() ?? []),
    password: vi.fn(async () => passwordQueue.shift() ?? ""),
    confirm: vi.fn(async () => false),
    spinner: vi.fn(() => mockSpinner),
    group: vi.fn(async (steps) => {
      const result: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) {
        result[key] = await (fn as () => Promise<unknown>)();
      }
      return result;
    }) as WizardPrompter["group"],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
}

function baseState(): WizardState {
  return { completedSteps: [] };
}

// ---------- Tests ----------

describe("toolProvidersStep", () => {
  it("has correct step id and label", () => {
    expect(toolProvidersStep.id).toBe("tool-providers");
    expect(toolProvidersStep.label).toBe("Tool Providers");
  });

  it("shows section separator", async () => {
    const prompter = createMockPrompter({ multiselect: [[]] });

    await toolProvidersStep.execute(baseState(), prompter);

    expect(prompter.note).toHaveBeenCalled();
  });

  it("returns unchanged state when none selected and no existing config", async () => {
    const prompter = createMockPrompter({ multiselect: [[]] });
    const state = baseState();

    const result = await toolProvidersStep.execute(state, prompter);

    expect(result.toolProviders).toBeUndefined();
    expect(prompter.log.info).toHaveBeenCalledWith(
      "No tool providers selected -- you can add them later.",
    );
  });

  it("shows keeping message when none selected but existing config exists", async () => {
    const prompter = createMockPrompter({ multiselect: [[]] });
    const state: WizardState = {
      completedSteps: [],
      toolProviders: [{ id: "brave", apiKey: "existing-key-12345" }],
    };

    const result = await toolProvidersStep.execute(state, prompter);

    expect(result.toolProviders).toEqual([{ id: "brave", apiKey: "existing-key-12345" }]);
    expect(prompter.log.info).toHaveBeenCalledWith(
      "Keeping existing tool provider configuration.",
    );
  });

  it("collects API key for a single selected provider", async () => {
    const prompter = createMockPrompter({
      multiselect: [["brave"]],
      password: ["brv-test-api-key-123"],
    });

    const result = await toolProvidersStep.execute(baseState(), prompter);

    expect(result.toolProviders).toEqual([
      { id: "brave", apiKey: "brv-test-api-key-123" },
    ]);
  });

  it("collects API keys for multiple selected providers", async () => {
    const prompter = createMockPrompter({
      multiselect: [["brave", "perplexity"]],
      password: ["brv-test-api-key-123", "pplx-test-api-key-456"],
    });

    const result = await toolProvidersStep.execute(baseState(), prompter);

    expect(result.toolProviders).toHaveLength(2);
    expect(result.toolProviders![0]).toEqual({ id: "brave", apiKey: "brv-test-api-key-123" });
    expect(result.toolProviders![1]).toEqual({ id: "perplexity", apiKey: "pplx-test-api-key-456" });
  });

  it("collects all three providers when all selected", async () => {
    const prompter = createMockPrompter({
      multiselect: [["brave", "elevenlabs", "perplexity"]],
      password: ["brv-key-1234567890", "el-key-1234567890", "pplx-key-1234567890"],
    });

    const result = await toolProvidersStep.execute(baseState(), prompter);

    expect(result.toolProviders).toHaveLength(3);
    expect(result.toolProviders!.map((tp) => tp.id)).toEqual(["brave", "elevenlabs", "perplexity"]);
  });

  it("password prompt includes provider label", async () => {
    const prompter = createMockPrompter({
      multiselect: [["elevenlabs"]],
      password: ["el-test-key-1234567"],
    });

    await toolProvidersStep.execute(baseState(), prompter);

    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ElevenLabs API key",
      }),
    );
  });

  it("password prompt validates minimum length", async () => {
    const prompter = createMockPrompter({
      multiselect: [["brave"]],
      password: ["brv-test-api-key-123"],
    });

    await toolProvidersStep.execute(baseState(), prompter);

    // Extract the validate function from the password call
    const passwordCall = vi.mocked(prompter.password).mock.calls[0][0];
    const validate = passwordCall.validate!;

    expect(validate("")).toBe("API key is required");
    expect(validate("short")).toBe("API key seems too short (minimum 10 characters)");
    expect(validate("a-valid-api-key-1234")).toBeUndefined();
  });

  it("multiselect shows all supported providers", async () => {
    const prompter = createMockPrompter({ multiselect: [[]] });

    await toolProvidersStep.execute(baseState(), prompter);

    expect(prompter.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "brave", label: "Brave Search" }),
          expect.objectContaining({ value: "elevenlabs", label: "ElevenLabs" }),
          expect.objectContaining({ value: "perplexity", label: "Perplexity" }),
        ]),
      }),
    );
  });
});
