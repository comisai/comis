/**
 * Unit tests for flow selection step (step 02).
 *
 * Verifies that each flow type (quickstart, advanced, remote) is properly
 * stored in state, and that the select prompt offers all three options.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

import { flowSelectStep } from "./02-flow-select.js";

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

describe("flowSelectStep", () => {
  it("has the correct step id and label", () => {
    expect(flowSelectStep.id).toBe("flow-select");
    expect(flowSelectStep.label).toBe("Setup Mode");
  });

  it("sets flow to 'quickstart' when user selects quickstart", async () => {
    const prompter = createMockPrompter({ select: "quickstart" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await flowSelectStep.execute(state, prompter);

    expect(result.flow).toBe("quickstart");
  });

  it("sets flow to 'advanced' when user selects advanced", async () => {
    const prompter = createMockPrompter({ select: "advanced" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await flowSelectStep.execute(state, prompter);

    expect(result.flow).toBe("advanced");
  });

  it("sets flow to 'remote' when user selects remote", async () => {
    const prompter = createMockPrompter({ select: "remote" });
    const state: WizardState = { ...INITIAL_STATE };

    const result = await flowSelectStep.execute(state, prompter);

    expect(result.flow).toBe("remote");
  });

  it("calls select() with 3 flow options", async () => {
    const prompter = createMockPrompter({ select: "quickstart" });
    const state: WizardState = { ...INITIAL_STATE };

    await flowSelectStep.execute(state, prompter);

    expect(prompter.select).toHaveBeenCalledOnce();

    const selectCall = (prompter.select as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { options: Array<{ value: string }> };
    expect(selectCall.options).toHaveLength(3);

    const values = selectCall.options.map(
      (o: { value: string }) => o.value,
    );
    expect(values).toContain("quickstart");
    expect(values).toContain("advanced");
    expect(values).toContain("remote");
  });

  it("preserves existing state fields", async () => {
    const prompter = createMockPrompter({ select: "advanced" });
    const state: WizardState = {
      ...INITIAL_STATE,
      riskAccepted: true,
      completedSteps: ["welcome", "detect-existing"],
    };

    const result = await flowSelectStep.execute(state, prompter);

    expect(result.flow).toBe("advanced");
    expect(result.riskAccepted).toBe(true);
    expect(result.completedSteps).toEqual(["welcome", "detect-existing"]);
  });
});
