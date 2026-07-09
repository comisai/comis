// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the semantic-memory-recall (embedding) step (step 08g).
 */

import { describe, it, expect, vi } from "vitest";
import { AppConfigSchema } from "@comis/core";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { EMBED_BGE_M3_MODEL_URI } from "../index.js";
import { recallStep } from "./08g-recall.js";

function createMockPrompter(
  responses: { confirm?: boolean[]; select?: string[]; password?: string[] } = {},
): WizardPrompter {
  const confirmQueue = [...(responses.confirm ?? [])];
  const selectQueue = [...(responses.select ?? [])];
  const passwordQueue = [...(responses.password ?? [])];
  const mockSpinner: Spinner = { start: vi.fn(), update: vi.fn(), stop: vi.fn() };
  return {
    intro: vi.fn(), outro: vi.fn(), note: vi.fn(),
    text: vi.fn(async () => ""),
    select: vi.fn(async (opts) => selectQueue.shift() ?? opts.initialValue ?? ""),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => passwordQueue.shift() ?? ""),
    confirm: vi.fn(async (opts) => confirmQueue.shift() ?? opts.initialValue ?? false),
    spinner: vi.fn(() => mockSpinner),
    group: vi.fn(async (steps) => {
      const result: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) result[key] = await (fn as () => Promise<unknown>)();
      return result;
    }) as WizardPrompter["group"],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
}

const openaiMain: WizardState = { completedSteps: [], provider: { id: "openai", apiKey: "sk-openai-main-123456" } };
const anthropicMain: WizardState = { completedSteps: [], provider: { id: "anthropic", apiKey: "test-key" } };

describe("recallStep", () => {
  it("has correct step id and label", () => {
    expect(recallStep.id).toBe("recall");
    expect(recallStep.label).toBe("Memory Recall");
  });

  it("English (default): keeps nomic, records multilingual:false, and never shows the provider select", async () => {
    const prompter = createMockPrompter({ confirm: [false] });
    const result = await recallStep.execute(anthropicMain, prompter);
    expect(result.recallProvider).toEqual({ multilingual: false, provider: "local" });
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("multilingual + on-device: writes bge-m3 local modelUri", async () => {
    const prompter = createMockPrompter({ confirm: [true], select: ["local"] });
    const result = await recallStep.execute(anthropicMain, prompter);
    expect(result.recallProvider).toEqual({
      multilingual: true, provider: "local", modelUri: EMBED_BGE_M3_MODEL_URI,
    });
  });

  it("multilingual + non-openai main + openai selection: prompts for a standalone OPENAI_API_KEY and stores it", async () => {
    const prompter = createMockPrompter({ confirm: [true], select: ["openai"], password: ["sk-standalone-embed-123456"] });
    const result = await recallStep.execute(anthropicMain, prompter);
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("OPENAI_API_KEY") }),
    );
    expect(result.recallProvider).toEqual({
      multilingual: true, provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKey: "sk-standalone-embed-123456",
    });
  });

  it("multilingual + openai main: offers BOTH local and openai; choosing openai reuses the key (no prompt) and writes text-embedding-3-small", async () => {
    const prompter = createMockPrompter({ confirm: [true], select: ["openai"] });
    const result = await recallStep.execute(openaiMain, prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "local" }),
          expect.objectContaining({ value: "openai" }),
        ]),
      }),
    );
    expect(prompter.password).not.toHaveBeenCalled();
    expect(result.recallProvider).toEqual({
      multilingual: true, provider: "openai", model: "text-embedding-3-small", dimensions: 1536,
    });
  });

  it("drift guard: the written embedding block parses in the real root config (AppConfigSchema)", () => {
    const agents = { default: { provider: "anthropic", model: "claude-opus-4-8" } };
    // local (bge-m3)
    const local = AppConfigSchema.parse({
      agents,
      embedding: { provider: "local", multilingual: true, local: { modelUri: EMBED_BGE_M3_MODEL_URI } },
    });
    expect(local.embedding.provider).toBe("local");
    expect(local.embedding.multilingual).toBe(true);
    expect(local.embedding.local.modelUri).toBe(EMBED_BGE_M3_MODEL_URI);
    // openai (text-embedding-3-small)
    const openai = AppConfigSchema.parse({
      agents,
      embedding: { provider: "openai", multilingual: true, openai: { model: "text-embedding-3-small", dimensions: 1536 } },
    });
    expect(openai.embedding.provider).toBe("openai");
    expect(openai.embedding.openai.dimensions).toBe(1536);
  });
});
