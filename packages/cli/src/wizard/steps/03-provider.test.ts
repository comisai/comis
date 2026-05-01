// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for provider selection step (step 03).
 *
 * Verifies:
 * - Provider selection (anthropic, ollama, custom) results in correct state.
 * - Select options come from `loadProvidersWithFallback()` (live catalog) +
 *   the synthetic "custom" option appended last.
 * - Unknown provider IDs render with capitalize-fallback labels.
 * - Source-grep regression: SUPPORTED_PROVIDERS is gone from wizard source.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

// Mock the shared provider-list utility (live catalog access in tests)
vi.mock("../../client/provider-list.js", () => ({
  loadProvidersWithFallback: vi.fn(),
}));

import { providerStep } from "./03-provider.js";
import { loadProvidersWithFallback } from "../../client/provider-list.js";

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
  beforeEach(() => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      "anthropic",
      "openai",
      "openrouter",
    ]);
  });

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

  it("calls select() with options from the live catalog plus synthetic Custom", async () => {
    const prompter = createMockPrompter({ select: "anthropic" });
    const state: WizardState = { ...INITIAL_STATE };

    await providerStep.execute(state, prompter);

    expect(prompter.select).toHaveBeenCalledOnce();

    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { options: Array<{ value: string; label: string }> };

    // Options come from the live catalog (mocked above) + synthetic "custom"
    expect(selectCall.options.length).toBeGreaterThan(0);
    expect(
      selectCall.options.some((o: { value: string }) => o.value === "custom"),
    ).toBe(true);

    // Verify each catalog provider is rendered as an option
    const optionValues = selectCall.options.map(
      (o: { value: string }) => o.value,
    );
    expect(optionValues).toContain("anthropic");
    expect(optionValues).toContain("openai");
    expect(optionValues).toContain("openrouter");
    expect(optionValues).toContain("custom");
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

  // ---------- A1-A4: catalog-driven menu regression tests ----------

  it("A1: renders all catalog providers + synthetic Custom (last)", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      "anthropic",
      "openai",
      "ollama",
      "groq",
    ]);

    const prompter = createMockPrompter({ select: "anthropic" });
    await providerStep.execute({ ...INITIAL_STATE }, prompter);

    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { options: Array<{ value: string; label?: string; hint?: string }> };

    const values = selectCall.options.map((o) => o.value);
    expect(values).toEqual(["anthropic", "openai", "ollama", "groq", "custom"]);

    // Custom is always last
    expect(selectCall.options[selectCall.options.length - 1]).toEqual({
      value: "custom",
      label: "Custom endpoint",
      hint: "OpenAI-compatible API",
    });
  });

  it("A2: renders only synthetic Custom when catalog returns []", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([]);

    const prompter = createMockPrompter({ select: "custom" });
    await providerStep.execute({ ...INITIAL_STATE }, prompter);

    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { options: Array<{ value: string }> };

    expect(selectCall.options).toHaveLength(1);
    expect(selectCall.options[0].value).toBe("custom");
  });

  it("A3: unknown catalog provider renders with capitalize-fallback label", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      "vercel-ai-gateway",
    ]);

    const prompter = createMockPrompter({ select: "vercel-ai-gateway" });
    await providerStep.execute({ ...INITIAL_STATE }, prompter);

    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { options: Array<{ value: string; label?: string; hint?: string }> };

    const vercel = selectCall.options.find((o) => o.value === "vercel-ai-gateway");
    expect(vercel).toBeDefined();
    expect(vercel!.label).toBe("Vercel-ai-gateway");
    expect(vercel!.hint).toBeUndefined();
  });

  it("A4: SUPPORTED_PROVIDERS does not appear in any wizard source file", () => {
    // Source-grep regression pin: walk the wizard tree and assert none of
    // the .ts (non-test) files contains the dropped constant.
    const here = dirname(fileURLToPath(import.meta.url));
    const wizardRoot = resolve(here, "..");

    function* walk(dir: string): Generator<string> {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          yield* walk(full);
        } else if (
          st.isFile() &&
          entry.endsWith(".ts") &&
          !entry.endsWith(".test.ts")
        ) {
          yield full;
        }
      }
    }

    const offenders: string[] = [];
    for (const path of walk(wizardRoot)) {
      const src = readFileSync(path, "utf-8");
      if (/SUPPORTED_PROVIDERS/.test(src)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
