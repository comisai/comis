// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for image providers step (step 08d).
 *
 * Verifies the single-select of all supported image-generation providers
 * (auto / fal / openai / openai-codex / google / openrouter), the
 * credential-collection branches (auto + reuse-main + openai-codex OAuth =
 * no prompt; fal + cross-provider = prompt), and the imageProvider state.
 */

import { describe, it, expect, vi } from "vitest";
import { ImageGenerationConfigSchema } from "@comis/core";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { SUPPORTED_IMAGE_PROVIDERS } from "../index.js";
import { imageProvidersStep } from "./08d-image-providers.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    select?: string[];
    password?: string[];
  } = {},
): WizardPrompter {
  const selectQueue = [...(responses.select ?? [])];
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
    select: vi.fn(async (opts) => selectQueue.shift() ?? opts.initialValue ?? ""),
    multiselect: vi.fn(async () => []),
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

describe("imageProvidersStep", () => {
  it("has correct step id and label", () => {
    expect(imageProvidersStep.id).toBe("image-providers");
    expect(imageProvidersStep.label).toBe("Image Generation");
  });

  it("shows section separator", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });
    await imageProvidersStep.execute(baseState(), prompter);
    expect(prompter.note).toHaveBeenCalled();
  });

  it("select offers every supported image provider", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });
    await imageProvidersStep.execute(baseState(), prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "auto" }),
          expect.objectContaining({ value: "fal" }),
          expect.objectContaining({ value: "openai" }),
          expect.objectContaining({ value: "openai-codex" }),
          expect.objectContaining({ value: "google" }),
          expect.objectContaining({ value: "openrouter" }),
        ]),
      }),
    );
  });

  it("auto: records provider without collecting any credential", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });
    const result = await imageProvidersStep.execute(baseState(), prompter);
    expect(result.imageProvider).toEqual({ provider: "auto" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("openai-codex: records provider without a password prompt (OAuth, not a static key)", async () => {
    const prompter = createMockPrompter({ select: ["openai-codex"] });
    const result = await imageProvidersStep.execute(baseState(), prompter);
    expect(result.imageProvider).toEqual({ provider: "openai-codex" });
    expect(prompter.password).not.toHaveBeenCalled();
    // Surfaces the OAuth-login hint rather than asking for a key.
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("comis auth login"),
    );
  });

  it("fal: prompts for a FAL_KEY and records it on the imageProvider", async () => {
    const prompter = createMockPrompter({
      select: ["fal"],
      password: ["fal-secret-key-123456"],
    });
    const result = await imageProvidersStep.execute(baseState(), prompter);
    expect(result.imageProvider).toEqual({
      provider: "fal",
      apiKey: "fal-secret-key-123456",
    });
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("FAL_KEY") }),
    );
  });

  it("openai: reuses the main provider key when the main provider is openai", async () => {
    const prompter = createMockPrompter({ select: ["openai"] });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "openai", apiKey: "sk-openai-main-123456" },
    };
    const result = await imageProvidersStep.execute(state, prompter);
    expect(result.imageProvider).toEqual({ provider: "openai" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("openrouter: collects OPENROUTER_API_KEY when the main provider is not openrouter", async () => {
    const prompter = createMockPrompter({
      select: ["openrouter"],
      password: ["sk-or-video-key-7890"],
    });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "anthropic", apiKey: "sk-ant-main-123456" },
    };
    const result = await imageProvidersStep.execute(state, prompter);
    expect(result.imageProvider).toEqual({
      provider: "openrouter",
      apiKey: "sk-or-video-key-7890",
    });
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("OPENROUTER_API_KEY"),
      }),
    );
  });

  it("google: reuses the main provider key when the main provider is google", async () => {
    const prompter = createMockPrompter({ select: ["google"] });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "google", apiKey: "AIza-main-key-123456" },
    };
    const result = await imageProvidersStep.execute(state, prompter);
    expect(result.imageProvider).toEqual({ provider: "google" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("password validates minimum length", async () => {
    const prompter = createMockPrompter({
      select: ["fal"],
      password: ["fal-secret-key-123456"],
    });
    await imageProvidersStep.execute(baseState(), prompter);
    const passwordCall = vi.mocked(prompter.password).mock.calls[0][0];
    const validate = passwordCall.validate!;
    expect(validate("")).toBeDefined();
    expect(validate("short")).toBeDefined();
    expect(validate("a-valid-api-key-1234")).toBeUndefined();
  });

  it("every offered provider id is accepted by the daemon's ImageGenerationConfigSchema (drift guard)", () => {
    for (const ip of SUPPORTED_IMAGE_PROVIDERS) {
      const parsed = ImageGenerationConfigSchema.parse({ provider: ip.id });
      expect(parsed.provider).toBe(ip.id);
    }
  });

  it("select defaults to the previously chosen provider", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });
    const state: WizardState = {
      completedSteps: [],
      imageProvider: { provider: "fal", apiKey: "old-fal-key-123456" },
    };
    await imageProvidersStep.execute(state, prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "fal" }),
    );
  });
});
