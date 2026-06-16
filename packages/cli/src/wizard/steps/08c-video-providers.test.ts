// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for video providers step (step 08c).
 *
 * Verifies the single-select of all supported video-generation providers
 * (auto / fal / google / xai), the credential-collection branches
 * (auto + reuse-main = no prompt; fal + cross-provider = prompt), and
 * the videoProvider state it returns.
 */

import { describe, it, expect, vi } from "vitest";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { videoProvidersStep } from "./08c-video-providers.js";

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

describe("videoProvidersStep", () => {
  it("has correct step id and label", () => {
    expect(videoProvidersStep.id).toBe("video-providers");
    expect(videoProvidersStep.label).toBe("Video Generation");
  });

  it("shows section separator", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });

    await videoProvidersStep.execute(baseState(), prompter);

    expect(prompter.note).toHaveBeenCalled();
  });

  it("select offers every supported video provider", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });

    await videoProvidersStep.execute(baseState(), prompter);

    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "auto" }),
          expect.objectContaining({ value: "fal" }),
          expect.objectContaining({ value: "google" }),
          expect.objectContaining({ value: "xai" }),
        ]),
      }),
    );
  });

  it("auto: records provider without collecting any credential", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });

    const result = await videoProvidersStep.execute(baseState(), prompter);

    expect(result.videoProvider).toEqual({ provider: "auto" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("fal: prompts for a FAL_KEY and records it on the videoProvider", async () => {
    const prompter = createMockPrompter({
      select: ["fal"],
      password: ["fal-secret-key-123456"],
    });

    const result = await videoProvidersStep.execute(baseState(), prompter);

    expect(result.videoProvider).toEqual({
      provider: "fal",
      apiKey: "fal-secret-key-123456",
    });
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("FAL_KEY") }),
    );
  });

  it("google: reuses the main provider key when the main provider is google", async () => {
    const prompter = createMockPrompter({ select: ["google"] });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "google", apiKey: "AIza-main-key-123456" },
    };

    const result = await videoProvidersStep.execute(state, prompter);

    // No extra credential collected — CRED-01 reuse of GOOGLE_API_KEY.
    expect(result.videoProvider).toEqual({ provider: "google" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("google: collects GOOGLE_API_KEY when the main provider is not google", async () => {
    const prompter = createMockPrompter({
      select: ["google"],
      password: ["AIza-video-key-7890"],
    });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "anthropic", apiKey: "sk-ant-main-123456" },
    };

    const result = await videoProvidersStep.execute(state, prompter);

    expect(result.videoProvider).toEqual({
      provider: "google",
      apiKey: "AIza-video-key-7890",
    });
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("GOOGLE_API_KEY"),
      }),
    );
  });

  it("xai: reuses the main provider key when the main provider is xai", async () => {
    const prompter = createMockPrompter({ select: ["xai"] });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "xai", apiKey: "xai-main-key-123456" },
    };

    const result = await videoProvidersStep.execute(state, prompter);

    expect(result.videoProvider).toEqual({ provider: "xai" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("password validates minimum length", async () => {
    const prompter = createMockPrompter({
      select: ["fal"],
      password: ["fal-secret-key-123456"],
    });

    await videoProvidersStep.execute(baseState(), prompter);

    const passwordCall = vi.mocked(prompter.password).mock.calls[0][0];
    const validate = passwordCall.validate!;

    expect(validate("")).toBeDefined();
    expect(validate("short")).toBeDefined();
    expect(validate("a-valid-api-key-1234")).toBeUndefined();
  });

  it("select defaults to the previously chosen provider", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });
    const state: WizardState = {
      completedSteps: [],
      videoProvider: { provider: "fal", apiKey: "old-fal-key-123456" },
    };

    await videoProvidersStep.execute(state, prompter);

    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "fal" }),
    );
  });
});
