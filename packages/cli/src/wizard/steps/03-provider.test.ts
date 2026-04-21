// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for provider selection step (step 03).
 *
 * Verifies provider selection (anthropic, ollama, custom) results in
 * correct state updates, and that select options match SUPPORTED_PROVIDERS.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState } from "../types.js";
import { INITIAL_STATE, SUPPORTED_PROVIDERS } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

import { providerStep } from "./03-provider.js";

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

describe("providerStep", () => {
  it("has the correct step id and label", () => {
    expect(providerStep.id).toBe("provider");
    expect(providerStep.label).toBe("LLM Provider");
  });

  it("sets provider.id to 'anthropic' when user selects anthropic", async () => {
    const prompter = createMockPrompter({ select: "anthropic" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await providerStep.execute(state, prompter);

    expect(result.provider?.id).toBe("anthropic");
  });

  it("sets provider.id to 'ollama' when user selects ollama", async () => {
    const prompter = createMockPrompter({ select: "ollama" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await providerStep.execute(state, prompter);

    expect(result.provider?.id).toBe("ollama");
  });

  it("sets provider.id to 'custom' when user selects custom", async () => {
    const prompter = createMockPrompter({ select: "custom" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await providerStep.execute(state, prompter);

    expect(result.provider?.id).toBe("custom");
  });

  it("calls select() with options matching SUPPORTED_PROVIDERS", async () => {
    const prompter = createMockPrompter({ select: "anthropic" });
    const state: WizardState = { ...INITIAL_STATE };

    await providerStep.execute(state, prompter);

    expect(prompter.select).toHaveBeenCalledOnce();

    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { options: Array<{ value: string; label: string }> };

    // Options should match SUPPORTED_PROVIDERS count
    expect(selectCall.options).toHaveLength(SUPPORTED_PROVIDERS.length);

    // Verify all provider IDs are present
    const optionValues = selectCall.options.map(
      (o: { value: string }) => o.value,
    );
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(optionValues).toContain(provider.id);
    }
  });

  it("shows category overview note before selection", async () => {
    const prompter = createMockPrompter({ select: "anthropic" });
    const state: WizardState = { ...INITIAL_STATE };

    await providerStep.execute(state, prompter);

    // note() should be called at least twice: section separator + category overview
    expect((prompter.note as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);

    // One note should have the "Available Providers" title
    const noteWithTitle = (prompter.note as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[1] === "Available Providers",
    );
    expect(noteWithTitle).toBeDefined();
  });

  it("preserves existing state fields", async () => {
    const prompter = createMockPrompter({ select: "openai" });
    const state: WizardState = {
      ...INITIAL_STATE,
      riskAccepted: true,
      flow: "advanced",
    };

    const result = await providerStep.execute(state, prompter);

    expect(result.provider?.id).toBe("openai");
    expect(result.riskAccepted).toBe(true);
    expect(result.flow).toBe("advanced");
  });
});
