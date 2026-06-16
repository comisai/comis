// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for text-to-speech (TTS) step (step 08f).
 */

import { describe, it, expect, vi } from "vitest";
import { TtsConfigSchema } from "@comis/core";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { SUPPORTED_TTS_PROVIDERS } from "../index.js";
import { ttsStep } from "./08f-tts.js";

function createMockPrompter(
  responses: { select?: string[]; password?: string[] } = {},
): WizardPrompter {
  const selectQueue = [...(responses.select ?? [])];
  const passwordQueue = [...(responses.password ?? [])];
  const mockSpinner: Spinner = { start: vi.fn(), update: vi.fn(), stop: vi.fn() };
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
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
}

function baseState(): WizardState {
  return { completedSteps: [] };
}

describe("ttsStep", () => {
  it("has correct step id and label", () => {
    expect(ttsStep.id).toBe("tts");
    expect(ttsStep.label).toBe("Text-to-Speech");
  });

  it("select offers every supported TTS provider", async () => {
    const prompter = createMockPrompter({ select: ["edge"] });
    await ttsStep.execute(baseState(), prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "openai" }),
          expect.objectContaining({ value: "elevenlabs" }),
          expect.objectContaining({ value: "edge" }),
        ]),
      }),
    );
  });

  it("edge: records provider with no credential prompt (free)", async () => {
    const prompter = createMockPrompter({ select: ["edge"] });
    const result = await ttsStep.execute(baseState(), prompter);
    expect(result.ttsProvider).toEqual({ provider: "edge" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("openai: reuses the main provider key when the main provider is openai", async () => {
    const prompter = createMockPrompter({ select: ["openai"] });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "openai", apiKey: "sk-openai-main-123456" },
    };
    const result = await ttsStep.execute(state, prompter);
    expect(result.ttsProvider).toEqual({ provider: "openai" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("elevenlabs: always prompts for ELEVENLABS_API_KEY", async () => {
    const prompter = createMockPrompter({
      select: ["elevenlabs"],
      password: ["el-secret-key-123456"],
    });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "openai", apiKey: "sk-openai-main-123456" },
    };
    const result = await ttsStep.execute(state, prompter);
    expect(result.ttsProvider).toEqual({
      provider: "elevenlabs",
      apiKey: "el-secret-key-123456",
    });
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ELEVENLABS_API_KEY") }),
    );
  });

  it("every offered provider id is accepted by TtsConfigSchema (drift guard)", () => {
    for (const tp of SUPPORTED_TTS_PROVIDERS) {
      const parsed = TtsConfigSchema.parse({ provider: tp.id });
      expect(parsed.provider).toBe(tp.id);
    }
  });

  it("select defaults to the previously chosen provider", async () => {
    const prompter = createMockPrompter({ select: ["edge"] });
    const state: WizardState = {
      completedSteps: [],
      ttsProvider: { provider: "elevenlabs", apiKey: "old-el-key-123456" },
    };
    await ttsStep.execute(state, prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "elevenlabs" }),
    );
  });
});
