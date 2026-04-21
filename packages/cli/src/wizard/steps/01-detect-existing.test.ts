// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for detect existing configuration step (step 01).
 *
 * Verifies filesystem detection of existing config, summary display,
 * and user choices (update, fresh with reset scope, cancel).
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState } from "../types.js";
import { INITIAL_STATE } from "../types.js";
import { CancelError } from "../prompter.js";

// ---------- Mocks ----------

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    loadConfigFile: vi.fn(() => ({ ok: false, error: { message: "Not found" } })),
    validatePartial: vi.fn(() => ({ errors: [] })),
    safePath: vi.fn((...args: string[]) => args.join("/")),
  };
});

import { detectExistingStep } from "./01-detect-existing.js";
import { existsSync } from "node:fs";
import { loadConfigFile, validatePartial } from "@comis/core";

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

describe("detectExistingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the correct step id and label", () => {
    expect(detectExistingStep.id).toBe("detect-existing");
    expect(detectExistingStep.label).toBe("Check Existing Config");
  });

  it("passes through when no config file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const prompter = createMockPrompter();
    const state: WizardState = { ...INITIAL_STATE };

    const result = await detectExistingStep.execute(state, prompter);

    // State should be unchanged
    expect(result).toEqual(state);
    expect(prompter.select).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("displays summary and offers update/fresh/cancel for valid config", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: {
        agents: {
          default: { name: "test-agent", model: "claude-sonnet-4-5-20250929" },
        },
        gateway: { host: "localhost", port: 3000 },
        channels: { telegram: { enabled: true } },
      },
    } as any);
    vi.mocked(validatePartial).mockReturnValue({ errors: [] } as any);

    const prompter = createMockPrompter({ select: "update" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await detectExistingStep.execute(state, prompter);

    expect(result.existingConfigAction).toBe("update");
    expect(prompter.note).toHaveBeenCalled();
    expect(prompter.select).toHaveBeenCalledOnce();
  });

  it("sets existingConfigAction to 'fresh' and prompts for reset scope", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: {
        agents: { default: { name: "a" } },
      },
    } as any);
    vi.mocked(validatePartial).mockReturnValue({ errors: [] } as any);

    // First select returns "fresh", second select returns reset scope
    const prompter = createMockPrompter();
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("fresh")
      .mockResolvedValueOnce("config");

    const state: WizardState = { ...INITIAL_STATE };

    const result = await detectExistingStep.execute(state, prompter);

    expect(result.existingConfigAction).toBe("fresh");
    expect(result.resetScope).toBe("config");
    expect(prompter.select).toHaveBeenCalledTimes(2);
  });

  it("throws CancelError when user selects cancel on valid config", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { agents: {} },
    } as any);
    vi.mocked(validatePartial).mockReturnValue({ errors: [] } as any);

    const prompter = createMockPrompter({ select: "cancel" });
    const state: WizardState = { ...INITIAL_STATE };

    await expect(
      detectExistingStep.execute(state, prompter),
    ).rejects.toThrow(CancelError);

    expect(prompter.outro).toHaveBeenCalledOnce();
  });

  it("sets existingConfigAction to 'update' for update choice", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: {},
    } as any);
    vi.mocked(validatePartial).mockReturnValue({ errors: [] } as any);

    const prompter = createMockPrompter({ select: "update" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await detectExistingStep.execute(state, prompter);

    expect(result.existingConfigAction).toBe("update");
  });

  it("handles unreadable config (loadConfigFile fails) with fresh/cancel", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: false,
      error: { message: "YAML parse error" },
    } as any);

    // First select: "fresh", second select: "config+creds" (reset scope)
    const prompter = createMockPrompter();
    vi.mocked(prompter.select)
      .mockResolvedValueOnce("fresh")
      .mockResolvedValueOnce("config+creds");

    const state: WizardState = { ...INITIAL_STATE };

    const result = await detectExistingStep.execute(state, prompter);

    expect(result.existingConfigAction).toBe("fresh");
    expect(result.resetScope).toBe("config+creds");
  });

  it("throws CancelError when user cancels on unreadable config", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: false,
      error: { message: "Permission denied" },
    } as any);

    const prompter = createMockPrompter({ select: "cancel" });
    const state: WizardState = { ...INITIAL_STATE };

    await expect(
      detectExistingStep.execute(state, prompter),
    ).rejects.toThrow(CancelError);
  });

  it("shows validation warnings for config with errors", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: true,
      value: { agents: { default: {} }, gateway: {} },
    } as any);
    vi.mocked(validatePartial).mockReturnValue({
      errors: [
        { section: "agents", error: { message: "missing name" } },
        { section: "gateway", error: { message: "invalid port" } },
      ],
    } as any);

    const prompter = createMockPrompter({ select: "update" });
    const state: WizardState = { ...INITIAL_STATE };

    await detectExistingStep.execute(state, prompter);

    // Should log warnings for each validation error
    expect(prompter.log.warn).toHaveBeenCalledTimes(2);
  });
});
