/**
 * Unit tests for welcome step (step 00).
 *
 * Verifies branded intro display, security notice, and risk acknowledgement
 * flow including both acceptance and cancellation paths.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState } from "../types.js";
import { INITIAL_STATE } from "../types.js";
import { CancelError } from "../prompter.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

import { welcomeStep } from "./00-welcome.js";

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

describe("welcomeStep", () => {
  it("has the correct step id and label", () => {
    expect(welcomeStep.id).toBe("welcome");
    expect(welcomeStep.label).toBe("Welcome & Security");
  });

  it("sets riskAccepted to true when user accepts", async () => {
    const prompter = createMockPrompter({ confirm: true });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await welcomeStep.execute(state, prompter);

    expect(result.riskAccepted).toBe(true);
  });

  it("throws CancelError when user declines risk acknowledgement", async () => {
    const prompter = createMockPrompter({ confirm: false });
    const state: WizardState = { ...INITIAL_STATE };

    await expect(
      welcomeStep.execute(state, prompter),
    ).rejects.toThrow(CancelError);
  });

  it("calls intro() with branded heading string", async () => {
    const prompter = createMockPrompter({ confirm: true });
    const state: WizardState = { ...INITIAL_STATE };

    await welcomeStep.execute(state, prompter);

    expect(prompter.intro).toHaveBeenCalledOnce();
    const introArg = (prompter.intro as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // heading() wraps text in a box with the title inside
    expect(introArg).toContain("Comis Agent Setup");
  });

  it("calls note() with security notice text", async () => {
    const prompter = createMockPrompter({ confirm: true });
    const state: WizardState = { ...INITIAL_STATE };

    await welcomeStep.execute(state, prompter);

    // note() called at least twice: welcome message + security notice
    expect(prompter.note).toHaveBeenCalledTimes(2);

    // Second note is the security notice
    const secondNoteCall = (prompter.note as ReturnType<typeof vi.fn>).mock
      .calls[1];
    const message = secondNoteCall[0] as string;
    const title = secondNoteCall[1] as string;

    expect(message).toContain("execute tools");
    expect(message).toContain("safety guardrails");
    expect(title).toBe("Security Notice");
  });

  it("calls outro() before throwing CancelError on decline", async () => {
    const prompter = createMockPrompter({ confirm: false });
    const state: WizardState = { ...INITIAL_STATE };

    await expect(
      welcomeStep.execute(state, prompter),
    ).rejects.toThrow(CancelError);

    expect(prompter.outro).toHaveBeenCalledOnce();
    const outroArg = (prompter.outro as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(outroArg).toContain("cancelled");
  });

  it("preserves existing state fields when accepting", async () => {
    const prompter = createMockPrompter({ confirm: true });
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: ["welcome"],
    };

    const result = await welcomeStep.execute(state, prompter);

    expect(result.riskAccepted).toBe(true);
    expect(result.completedSteps).toEqual(["welcome"]);
  });
});
