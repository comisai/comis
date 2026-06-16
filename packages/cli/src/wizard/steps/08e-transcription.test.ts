// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for voice transcription (STT) step (step 08e).
 */

import { describe, it, expect, vi } from "vitest";
import { TranscriptionConfigSchema } from "@comis/core";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { SUPPORTED_TRANSCRIPTION_PROVIDERS } from "../index.js";
import { transcriptionStep } from "./08e-transcription.js";

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

describe("transcriptionStep", () => {
  it("has correct step id and label", () => {
    expect(transcriptionStep.id).toBe("transcription");
    expect(transcriptionStep.label).toBe("Voice Transcription");
  });

  it("select offers every supported STT provider", async () => {
    const prompter = createMockPrompter({ select: ["openai"], password: ["sk-openai-key-1234"] });
    const state: WizardState = { completedSteps: [], provider: { id: "anthropic", apiKey: "x" } };
    await transcriptionStep.execute(state, prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ value: "openai" }),
          expect.objectContaining({ value: "groq" }),
          expect.objectContaining({ value: "deepgram" }),
        ]),
      }),
    );
  });

  it("reuses the main provider key when the main provider matches (openai)", async () => {
    const prompter = createMockPrompter({ select: ["openai"] });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "openai", apiKey: "sk-openai-main-123456" },
    };
    const result = await transcriptionStep.execute(state, prompter);
    expect(result.transcriptionProvider).toEqual({ provider: "openai" });
    expect(prompter.password).not.toHaveBeenCalled();
  });

  it("deepgram: always prompts for DEEPGRAM_API_KEY", async () => {
    const prompter = createMockPrompter({
      select: ["deepgram"],
      password: ["dg-secret-key-123456"],
    });
    const state: WizardState = {
      completedSteps: [],
      provider: { id: "openai", apiKey: "sk-openai-main-123456" },
    };
    const result = await transcriptionStep.execute(state, prompter);
    expect(result.transcriptionProvider).toEqual({
      provider: "deepgram",
      apiKey: "dg-secret-key-123456",
    });
    expect(prompter.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("DEEPGRAM_API_KEY") }),
    );
  });

  it("password validates minimum length", async () => {
    const prompter = createMockPrompter({ select: ["deepgram"], password: ["dg-key-123456"] });
    await transcriptionStep.execute(baseState(), prompter);
    const validate = vi.mocked(prompter.password).mock.calls[0][0].validate!;
    expect(validate("")).toBeDefined();
    expect(validate("short")).toBeDefined();
    expect(validate("a-valid-api-key-1234")).toBeUndefined();
  });

  it("every offered provider id is accepted by TranscriptionConfigSchema (drift guard)", () => {
    for (const tp of SUPPORTED_TRANSCRIPTION_PROVIDERS) {
      const parsed = TranscriptionConfigSchema.parse({ provider: tp.id });
      expect(parsed.provider).toBe(tp.id);
    }
  });

  it("select defaults to the previously chosen provider", async () => {
    const prompter = createMockPrompter({ select: ["groq"], password: ["gsk-key-1234567"] });
    const state: WizardState = {
      completedSteps: [],
      transcriptionProvider: { provider: "deepgram", apiKey: "old-dg-key-123456" },
    };
    await transcriptionStep.execute(state, prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "deepgram" }),
    );
  });

  it("defaults to the keyless auto provider on a first-time run (WIZ-01)", async () => {
    const prompter = createMockPrompter({ select: ["auto"] });
    await transcriptionStep.execute(baseState(), prompter);
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "auto" }),
    );
  });

  it("auto and local are keyless and prompt for no API key (WIZ-01)", async () => {
    for (const id of ["auto", "local"]) {
      const p = createMockPrompter({ select: [id] });
      const r = await transcriptionStep.execute(baseState(), p);
      expect(r.transcriptionProvider).toEqual({ provider: id });
      expect(p.password).not.toHaveBeenCalled();
    }
  });

  it("offers auto and local as keyless-first ordered options (WIZ-04 drift mirror)", () => {
    expect(SUPPORTED_TRANSCRIPTION_PROVIDERS.map((t) => t.id)).toEqual([
      "auto",
      "local",
      "openai",
      "groq",
      "deepgram",
    ]);
  });

  it("openai with a non-openai main prompts OPENAI_API_KEY but reuses an openai main key (CRED-01)", async () => {
    // (a) non-openai main → must prompt for the OpenAI key (no silent reuse).
    const promptingPrompter = createMockPrompter({
      select: ["openai"],
      password: ["sk-openai-key-1234"],
    });
    const anthropicMain: WizardState = {
      completedSteps: [],
      provider: { id: "anthropic", apiKey: "test-anthropic-key" },
    };
    await transcriptionStep.execute(anthropicMain, promptingPrompter);
    expect(promptingPrompter.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("OPENAI_API_KEY") }),
    );

    // (b) openai main → reuse its key, no prompt.
    const reusingPrompter = createMockPrompter({ select: ["openai"] });
    const openaiMain: WizardState = {
      completedSteps: [],
      provider: { id: "openai", apiKey: "test-openai-key" },
    };
    const result = await transcriptionStep.execute(openaiMain, reusingPrompter);
    expect(reusingPrompter.password).not.toHaveBeenCalled();
    expect(result.transcriptionProvider).toEqual({ provider: "openai" });
  });
});
