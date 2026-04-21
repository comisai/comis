// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  updateState,
  markStepComplete,
  jumpToStep,
  getNextStep,
  getStepIndex,
  isStepComplete,
  getCompletedStepCount,
  FLOW_STEPS,
  runWizardFlow,
  DOUBLE_ESCAPE_MS,
  SKIP_SENTINEL,
  wrapWithSkip,
  wrapWithCancel,
} from "./state.js";
import type { StepRegistry } from "./state.js";
import type { WizardState, WizardStep, WizardStepId } from "./types.js";
import { INITIAL_STATE } from "./types.js";
import type { WizardPrompter } from "./prompter.js";
import { CancelError, SkipError } from "./prompter.js";

// ---------- Mock Prompter ----------

function createMockPrompter(): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      update: vi.fn(),
      stop: vi.fn(),
    })),
    group: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
}

// ---------- FLOW_STEPS constants ----------

describe("FLOW_STEPS", () => {
  it("quickstart has 10 steps", () => {
    expect(FLOW_STEPS.quickstart).toHaveLength(10);
  });

  it("advanced has 14 steps", () => {
    expect(FLOW_STEPS.advanced).toHaveLength(14);
  });

  it("remote has 7 steps", () => {
    expect(FLOW_STEPS.remote).toHaveLength(7);
  });

  it("quickstart does not include channels, gateway, or workspace", () => {
    expect(FLOW_STEPS.quickstart).not.toContain("channels");
    expect(FLOW_STEPS.quickstart).not.toContain("gateway");
    expect(FLOW_STEPS.quickstart).not.toContain("workspace");
  });

  it("advanced includes all 13 steps", () => {
    expect(FLOW_STEPS.advanced).toContain("channels");
    expect(FLOW_STEPS.advanced).toContain("gateway");
    expect(FLOW_STEPS.advanced).toContain("workspace");
  });
});

// ---------- updateState ----------

describe("updateState", () => {
  it("merges updates into state immutably", () => {
    const original = { ...INITIAL_STATE };
    const updated = updateState(original, { flow: "quickstart" });

    expect(updated.flow).toBe("quickstart");
    expect(original.flow).toBeUndefined();
    expect(updated).not.toBe(original);
  });

  it("preserves existing fields when updating other fields", () => {
    const state = updateState(INITIAL_STATE, {
      flow: "advanced",
      agentName: "my-bot",
    });
    const updated = updateState(state, { model: "claude-3" });

    expect(updated.flow).toBe("advanced");
    expect(updated.agentName).toBe("my-bot");
    expect(updated.model).toBe("claude-3");
  });

  it("overrides fields with new values", () => {
    const state = updateState(INITIAL_STATE, { agentName: "old" });
    const updated = updateState(state, { agentName: "new" });

    expect(updated.agentName).toBe("new");
  });
});

// ---------- markStepComplete ----------

describe("markStepComplete", () => {
  it("adds step to completedSteps", () => {
    const state = markStepComplete(INITIAL_STATE, "welcome");
    expect(state.completedSteps).toContain("welcome");
  });

  it("is idempotent -- does not duplicate steps", () => {
    const state1 = markStepComplete(INITIAL_STATE, "welcome");
    const state2 = markStepComplete(state1, "welcome");

    expect(state2.completedSteps.filter((s) => s === "welcome")).toHaveLength(
      1,
    );
  });

  it("returns new object reference", () => {
    const state = markStepComplete(INITIAL_STATE, "welcome");
    expect(state).not.toBe(INITIAL_STATE);
  });

  it("returns new object reference even when idempotent", () => {
    const state1 = markStepComplete(INITIAL_STATE, "welcome");
    const state2 = markStepComplete(state1, "welcome");
    expect(state2).not.toBe(state1);
  });

  it("preserves existing completed steps", () => {
    const state1 = markStepComplete(INITIAL_STATE, "welcome");
    const state2 = markStepComplete(state1, "flow-select");

    expect(state2.completedSteps).toContain("welcome");
    expect(state2.completedSteps).toContain("flow-select");
  });
});

// ---------- jumpToStep ----------

describe("jumpToStep", () => {
  it("clears downstream state fields per STATE_DEPENDENCIES", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      provider: { id: "anthropic", apiKey: "sk-ant-test" },
      model: "claude-3",
      channels: [{ type: "telegram" }],
      completedSteps: [
        "welcome",
        "detect-existing",
        "flow-select",
        "provider",
        "credentials",
        "agent",
        "channels",
      ],
    };

    // Jumping to "provider" clears provider, model, channels
    const jumped = jumpToStep(state, "provider", "advanced");

    expect(jumped.provider).toBeUndefined();
    expect(jumped.model).toBeUndefined();
    expect(jumped.channels).toBeUndefined();
    // Upstream state preserved
    expect(jumped.flow).toBe("advanced");
  });

  it("removes downstream steps from completedSteps", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      completedSteps: [
        "welcome",
        "detect-existing",
        "flow-select",
        "provider",
        "credentials",
        "agent",
        "channels",
      ],
    };

    const jumped = jumpToStep(state, "provider", "advanced");

    // provider and all after should be removed
    expect(jumped.completedSteps).toContain("welcome");
    expect(jumped.completedSteps).toContain("detect-existing");
    expect(jumped.completedSteps).toContain("flow-select");
    expect(jumped.completedSteps).not.toContain("provider");
    expect(jumped.completedSteps).not.toContain("credentials");
    expect(jumped.completedSteps).not.toContain("agent");
    expect(jumped.completedSteps).not.toContain("channels");
  });

  it("returns new reference for step not in flow", () => {
    const state = { ...INITIAL_STATE, flow: "quickstart" as const };
    const jumped = jumpToStep(state, "channels", "quickstart");

    // "channels" is not in quickstart flow
    expect(jumped).not.toBe(state);
    expect(jumped.completedSteps).toEqual(state.completedSteps);
  });

  it("preserves upstream state", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      flow: "advanced",
      riskAccepted: true,
      agentName: "my-bot",
      completedSteps: [
        "welcome",
        "detect-existing",
        "flow-select",
        "provider",
        "credentials",
        "agent",
      ],
    };

    const jumped = jumpToStep(state, "agent", "advanced");

    expect(jumped.riskAccepted).toBe(true);
    // agentName is not in STATE_DEPENDENCIES for agent, so it stays
    expect(jumped.agentName).toBe("my-bot");
  });
});

// ---------- getNextStep ----------

describe("getNextStep", () => {
  it("returns first incomplete step", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: ["welcome"],
    };

    expect(getNextStep(state, "quickstart")).toBe("detect-existing");
  });

  it("returns null when all steps complete", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: [...FLOW_STEPS.quickstart],
    };

    expect(getNextStep(state, "quickstart")).toBeNull();
  });

  it("returns first step when none completed", () => {
    expect(getNextStep(INITIAL_STATE, "quickstart")).toBe("welcome");
  });

  it("works with advanced flow", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: [
        "welcome",
        "detect-existing",
        "flow-select",
        "provider",
        "credentials",
        "agent",
      ],
    };

    // In advanced flow, next after agent is channels
    expect(getNextStep(state, "advanced")).toBe("channels");
  });

  it("works with remote flow", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: ["welcome", "detect-existing", "flow-select"],
    };

    // In remote flow, next after flow-select is gateway
    expect(getNextStep(state, "remote")).toBe("gateway");
  });
});

// ---------- getStepIndex ----------

describe("getStepIndex", () => {
  it("returns correct index for welcome in quickstart", () => {
    expect(getStepIndex("welcome", "quickstart")).toBe(0);
  });

  it("returns correct index for finish in quickstart", () => {
    expect(getStepIndex("finish", "quickstart")).toBe(9);
  });

  it("returns -1 for channels in quickstart", () => {
    expect(getStepIndex("channels", "quickstart")).toBe(-1);
  });

  it("returns correct index for channels in advanced", () => {
    expect(getStepIndex("channels", "advanced")).toBe(6);
  });

  it("returns -1 for gateway in quickstart", () => {
    expect(getStepIndex("gateway", "quickstart")).toBe(-1);
  });
});

// ---------- isStepComplete ----------

describe("isStepComplete", () => {
  it("returns true for completed step", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: ["welcome", "flow-select"],
    };

    expect(isStepComplete(state, "welcome")).toBe(true);
    expect(isStepComplete(state, "flow-select")).toBe(true);
  });

  it("returns false for incomplete step", () => {
    expect(isStepComplete(INITIAL_STATE, "welcome")).toBe(false);
  });
});

// ---------- getCompletedStepCount ----------

describe("getCompletedStepCount", () => {
  it("returns correct counts", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: ["welcome", "detect-existing", "flow-select"],
    };

    const result = getCompletedStepCount(state, "quickstart");
    expect(result.completed).toBe(3);
    expect(result.total).toBe(10);
  });

  it("returns 0/total for initial state", () => {
    const result = getCompletedStepCount(INITIAL_STATE, "advanced");
    expect(result.completed).toBe(0);
    expect(result.total).toBe(14);
  });

  it("returns total/total when all complete", () => {
    const state: WizardState = {
      ...INITIAL_STATE,
      completedSteps: [...FLOW_STEPS.remote],
    };

    const result = getCompletedStepCount(state, "remote");
    expect(result.completed).toBe(7);
    expect(result.total).toBe(7);
  });
});

// ---------- wrapWithSkip ----------

describe("wrapWithSkip", () => {
  it("injects skip option into select and throws SkipError when chosen", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP_SENTINEL);

    const wrapped = wrapWithSkip(mockPrompter);

    await expect(
      wrapped.select({
        message: "Pick one",
        options: [{ value: "a", label: "A" }],
      }),
    ).rejects.toThrow(SkipError);

    // Verify skip option was appended
    const call = (mockPrompter.select as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.options).toHaveLength(2);
    expect(call.options[1]).toEqual({
      value: SKIP_SENTINEL,
      label: "Skip",
      hint: "skip this section",
    });
  });

  it("select passes through non-skip values", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("real-value");

    const wrapped = wrapWithSkip(mockPrompter);
    const result = await wrapped.select({
      message: "Pick",
      options: [{ value: "real-value", label: "Real" }],
    });

    expect(result).toBe("real-value");
  });

  it("injects skip option into multiselect and throws SkipError when chosen", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.multiselect as ReturnType<typeof vi.fn>).mockResolvedValue([SKIP_SENTINEL]);

    const wrapped = wrapWithSkip(mockPrompter);

    await expect(
      wrapped.multiselect({
        message: "Pick many",
        options: [{ value: "a", label: "A" }],
        required: true,
      }),
    ).rejects.toThrow(SkipError);

    // Verify required was set to false (so skip-only selection is allowed)
    const call = (mockPrompter.multiselect as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.required).toBe(false);
  });

  it("multiselect passes through non-skip selections", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.multiselect as ReturnType<typeof vi.fn>).mockResolvedValue(["a", "b"]);

    const wrapped = wrapWithSkip(mockPrompter);
    const result = await wrapped.multiselect({
      message: "Pick",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });

    expect(result).toEqual(["a", "b"]);
  });

  it("text throws SkipError on empty input", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.text as ReturnType<typeof vi.fn>).mockResolvedValue("");

    const wrapped = wrapWithSkip(mockPrompter);

    await expect(
      wrapped.text({ message: "Enter name" }),
    ).rejects.toThrow(SkipError);

    // Message has skip hint appended
    const call = (mockPrompter.text as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.message).toBe("Enter name (leave empty to skip)");
  });

  it("text bypasses original validator for empty input", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.text as ReturnType<typeof vi.fn>).mockResolvedValue("");

    const wrapped = wrapWithSkip(mockPrompter);
    const strictValidator = (v: string) => (v === "" ? "Required" : undefined);

    await expect(
      wrapped.text({ message: "Name", validate: strictValidator }),
    ).rejects.toThrow(SkipError);

    // The wrapped validator should allow empty (return undefined, not "Required")
    const call = (mockPrompter.text as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.validate("")).toBeUndefined();
    expect(call.validate("bad!")).toBe(undefined); // no original validator error for "bad!"
    // Actually the original validator only fails on empty, so "bad!" passes
  });

  it("text passes through non-empty values", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.text as ReturnType<typeof vi.fn>).mockResolvedValue("my-bot");

    const wrapped = wrapWithSkip(mockPrompter);
    const result = await wrapped.text({ message: "Name" });

    expect(result).toBe("my-bot");
  });

  it("password throws SkipError on empty input", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.password as ReturnType<typeof vi.fn>).mockResolvedValue("");

    const wrapped = wrapWithSkip(mockPrompter);

    await expect(
      wrapped.password({ message: "API key" }),
    ).rejects.toThrow(SkipError);

    const call = (mockPrompter.password as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.message).toBe("API key (leave empty to skip)");
  });

  it("password passes through non-empty values", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.password as ReturnType<typeof vi.fn>).mockResolvedValue("sk-secret");

    const wrapped = wrapWithSkip(mockPrompter);
    const result = await wrapped.password({ message: "Key" });

    expect(result).toBe("sk-secret");
  });

  it("select does not inject skip when options already include Cancel", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("update");

    const wrapped = wrapWithSkip(mockPrompter);
    await wrapped.select({
      message: "What to do?",
      options: [
        { value: "update", label: "Update" },
        { value: "cancel", label: "Cancel" },
      ],
    });

    // Options passed through unchanged — no Skip appended
    const call = (mockPrompter.select as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.options).toHaveLength(2);
    expect(call.options.map((o: { label: string }) => o.label)).toEqual(["Update", "Cancel"]);
  });
});

// ---------- wrapWithCancel ----------

describe("wrapWithCancel", () => {
  it("select throws explicit CancelError when Cancel option is chosen", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("cancel");

    const wrapped = wrapWithCancel(mockPrompter);

    const err = await wrapped.select({
      message: "What to do?",
      options: [
        { value: "update", label: "Update" },
        { value: "cancel", label: "Cancel" },
      ],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CancelError);
    expect((err as CancelError).explicit).toBe(true);
  });

  it("select passes through non-cancel values", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("update");

    const wrapped = wrapWithCancel(mockPrompter);
    const result = await wrapped.select({
      message: "What to do?",
      options: [
        { value: "update", label: "Update" },
        { value: "cancel", label: "Cancel" },
      ],
    });

    expect(result).toBe("update");
  });

  it("select passes through when no Cancel option exists", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("a");

    const wrapped = wrapWithCancel(mockPrompter);
    const result = await wrapped.select({
      message: "Pick",
      options: [{ value: "a", label: "A" }],
    });

    expect(result).toBe("a");
  });

  it("confirm passes through unchanged", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const wrapped = wrapWithSkip(mockPrompter);
    const result = await wrapped.confirm({ message: "Accept?" });

    expect(result).toBe(true);
    expect(mockPrompter.confirm).toHaveBeenCalled();
  });
});

// ---------- runWizardFlow ----------

describe("runWizardFlow", () => {
  it("runs steps in sequence, passing state through each", async () => {
    const mockPrompter = createMockPrompter();
    const executionOrder: string[] = [];

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => {
        executionOrder.push("welcome");
        return updateState(state, { riskAccepted: true });
      },
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => {
        executionOrder.push("detect-existing");
        return updateState(state, {
          existingConfigAction: "fresh" as const,
        });
      },
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => {
        executionOrder.push("flow-select");
        return updateState(state, { flow: "remote" });
      },
    };

    const gatewayStep: WizardStep = {
      id: "gateway",
      label: "Gateway",
      execute: async (state) => {
        executionOrder.push("gateway");
        return updateState(state, {
          gateway: {
            port: 4766,
            bindMode: "loopback",
            authMethod: "token",
          },
        });
      },
    };

    const reviewStep: WizardStep = {
      id: "review",
      label: "Review",
      execute: async (state) => {
        executionOrder.push("review");
        return state;
      },
    };

    const writeConfigStep: WizardStep = {
      id: "write-config",
      label: "Write Config",
      execute: async (state) => {
        executionOrder.push("write-config");
        return state;
      },
    };

    const finishStep: WizardStep = {
      id: "finish",
      label: "Finish",
      execute: async (state) => {
        executionOrder.push("finish");
        return state;
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["gateway", gatewayStep],
      ["review", reviewStep],
      ["write-config", writeConfigStep],
      ["finish", finishStep],
    ]);

    const finalState = await runWizardFlow(
      "remote",
      mockPrompter,
      steps,
    );

    expect(executionOrder).toEqual([
      "welcome",
      "detect-existing",
      "flow-select",
      "gateway",
      "review",
      "write-config",
      "finish",
    ]);

    expect(finalState.riskAccepted).toBe(true);
    expect(finalState.flow).toBe("remote");
    expect(finalState.gateway?.port).toBe(4766);
  });

  it("skips unregistered steps", async () => {
    const mockPrompter = createMockPrompter();
    const executed: string[] = [];

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => {
        executed.push("welcome");
        return updateState(state, { riskAccepted: true });
      },
    };

    const finishStep: WizardStep = {
      id: "finish",
      label: "Finish",
      execute: async (state) => {
        executed.push("finish");
        return state;
      },
    };

    // Only register welcome and finish -- all middle steps are unregistered
    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["finish", finishStep],
    ]);

    const finalState = await runWizardFlow(
      "remote",
      mockPrompter,
      steps,
    );

    // Only welcome and finish were executed; other steps were skipped
    expect(executed).toEqual(["welcome", "finish"]);
    // Skipped steps should be marked complete
    expect(finalState.completedSteps).toContain("detect-existing");
    expect(finalState.completedSteps).toContain("flow-select");
    expect(finalState.completedSteps).toContain("gateway");
    expect(finalState.completedSteps).toContain("review");
    expect(finalState.completedSteps).toContain("write-config");
  });

  it("exits wizard on CancelError at first step (no previous step)", async () => {
    const mockPrompter = createMockPrompter();

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async () => {
        throw new CancelError();
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
    ]);

    // At first step, single escape exits
    const result = await runWizardFlow(
      "remote",
      mockPrompter,
      steps,
    );

    expect(result.completedSteps).not.toContain("welcome");
  });

  it("single escape goes back one step", async () => {
    const mockPrompter = createMockPrompter();
    let detectCallCount = 0;

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => {
        return updateState(state, { riskAccepted: true });
      },
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect Existing",
      execute: async (state) => {
        detectCallCount++;
        if (detectCallCount === 1) {
          throw new CancelError();
        }
        return updateState(state, { existingConfigAction: "fresh" as const });
      },
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => {
        return updateState(state, { flow: "remote" });
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
    ]);

    const result = await runWizardFlow(
      "remote",
      mockPrompter,
      steps,
    );

    // detect-existing was called twice (first cancel, then re-run after going back through welcome)
    expect(detectCallCount).toBe(2);
    // Welcome step was re-run (went back to it)
    expect(result.completedSteps).toContain("welcome");
    expect(result.completedSteps).toContain("detect-existing");
    // Info message was shown
    expect(mockPrompter.log.info).toHaveBeenCalledWith("Going back to: Welcome");
  });

  it("double escape exits wizard", async () => {
    const mockPrompter = createMockPrompter();
    let callCount = 0;
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => {
        return updateState(state, { riskAccepted: true });
      },
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async () => {
        callCount++;
        throw new CancelError();
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
    ]);

    // Mock Date.now to simulate rapid double-escape
    const originalNow = Date.now;
    let mockTime = 1000;
    Date.now = () => mockTime;

    try {
      const result = await runWizardFlow(
        "remote",
        mockPrompter,
        steps,
      );

      // First cancel at detect → goes back to welcome (time=1000),
      // welcome re-runs and completes, detect cancels again (time=1000, same mock),
      // 1000 - 1000 = 0 < 800 → double escape → confirm exit → exits.
      expect(result.riskAccepted).toBe(true);
      expect(result.completedSteps).toContain("welcome");
      expect(result.completedSteps).not.toContain("detect-existing");
    } finally {
      Date.now = originalNow;
    }
  });

  it("spaced-out cancels each trigger go-back (not double-escape)", async () => {
    const mockPrompter = createMockPrompter();
    let gatewayCallCount = 0;
    let reviewCallCount = 0;

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => updateState(state, { riskAccepted: true }),
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => updateState(state, { existingConfigAction: "fresh" as const }),
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => updateState(state, { flow: "remote" }),
    };

    const gatewayStep: WizardStep = {
      id: "gateway",
      label: "Gateway",
      execute: async (state) => {
        gatewayCallCount++;
        if (gatewayCallCount === 1) {
          throw new CancelError();
        }
        return updateState(state, {
          gateway: { port: 4766, bindMode: "loopback" as const, authMethod: "token" as const },
        });
      },
    };

    const reviewStep: WizardStep = {
      id: "review",
      label: "Review",
      execute: async (state) => {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          throw new CancelError();
        }
        return state;
      },
    };

    const writeConfigStep: WizardStep = {
      id: "write-config",
      label: "Write Config",
      execute: async (state) => state,
    };

    const finishStep: WizardStep = {
      id: "finish",
      label: "Finish",
      execute: async (state) => state,
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["gateway", gatewayStep],
      ["review", reviewStep],
      ["write-config", writeConfigStep],
      ["finish", finishStep],
    ]);

    // First cancel at t=1000, second cancel at t=5000 (well outside 800ms window)
    const originalNow = Date.now;
    let mockTime = 1000;
    Date.now = () => mockTime;

    try {
      // Override gateway to advance time after it succeeds on second call
      const originalGatewayExec = gatewayStep.execute.bind(gatewayStep);
      gatewayStep.execute = async (state, prompter) => {
        const result = await originalGatewayExec(state, prompter);
        // After gateway succeeds, advance time well past the double-escape window
        mockTime = 5000;
        return result;
      };

      const result = await runWizardFlow("remote", mockPrompter, steps);

      // Both go-backs happened (not exits), wizard completed
      // gateway: 1st (cancel) + 2nd (success) + 3rd (success after review go-back) = 3
      expect(gatewayCallCount).toBe(3);
      expect(reviewCallCount).toBe(2);
      expect(result.completedSteps).toContain("finish");
    } finally {
      Date.now = originalNow;
    }
  });

  it("processes _jumpTo signals", async () => {
    const mockPrompter = createMockPrompter();
    let providerCallCount = 0;

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => {
        return updateState(state, { riskAccepted: true });
      },
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => {
        return updateState(state, {
          existingConfigAction: "fresh" as const,
        });
      },
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => {
        return updateState(state, { flow: "quickstart" });
      },
    };

    const providerStep: WizardStep = {
      id: "provider",
      label: "Provider",
      execute: async (state) => {
        providerCallCount++;
        return updateState(state, {
          provider: { id: "anthropic" },
        });
      },
    };

    const credentialsStep: WizardStep = {
      id: "credentials",
      label: "Credentials",
      execute: async (state) => {
        return updateState(state, { model: "claude-3" });
      },
    };

    const agentStep: WizardStep = {
      id: "agent",
      label: "Agent",
      execute: async (state) => {
        return updateState(state, { agentName: "test-bot" });
      },
    };

    const reviewStep: WizardStep = {
      id: "review",
      label: "Review",
      execute: async (state) => {
        // On first call, jump back to provider
        if (providerCallCount === 1) {
          return updateState(state, {
            _jumpTo: "provider" as WizardStepId,
          });
        }
        return state;
      },
    };

    const writeConfigStep: WizardStep = {
      id: "write-config",
      label: "Write Config",
      execute: async (state) => state,
    };

    const daemonStep: WizardStep = {
      id: "daemon-start",
      label: "Daemon Start",
      execute: async (state) => state,
    };

    const finishStep: WizardStep = {
      id: "finish",
      label: "Finish",
      execute: async (state) => state,
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["provider", providerStep],
      ["credentials", credentialsStep],
      ["agent", agentStep],
      ["review", reviewStep],
      ["write-config", writeConfigStep],
      ["daemon-start", daemonStep],
      ["finish", finishStep],
    ]);

    const finalState = await runWizardFlow(
      "quickstart",
      mockPrompter,
      steps,
    );

    // Provider was called twice (once normally, once after jump back)
    expect(providerCallCount).toBe(2);
    expect(finalState.completedSteps).toContain("finish");
  });

  it("returns final state when all steps complete", async () => {
    const mockPrompter = createMockPrompter();

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>();

    // No steps registered -- all are skipped (marked complete)
    const finalState = await runWizardFlow(
      "remote",
      mockPrompter,
      steps,
    );

    // All remote flow steps should be marked complete
    for (const stepId of FLOW_STEPS.remote) {
      expect(finalState.completedSteps).toContain(stepId);
    }
  });

  it("explicit cancel + confirm No → wizard continues (step re-runs)", async () => {
    const mockPrompter = createMockPrompter();
    let gatewayCallCount = 0;

    // confirm returns false → stay in wizard
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => updateState(state, { riskAccepted: true }),
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => updateState(state, { existingConfigAction: "fresh" as const }),
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => updateState(state, { flow: "remote" }),
    };

    const gatewayStep: WizardStep = {
      id: "gateway",
      label: "Gateway",
      execute: async (state, stepPrompter) => {
        gatewayCallCount++;
        if (gatewayCallCount === 1) {
          // Simulate user selecting Cancel
          await stepPrompter.select({
            message: "Configure",
            options: [
              { value: "loopback", label: "Loopback" },
              { value: "cancel", label: "Cancel" },
            ],
          });
        }
        return updateState(state, {
          gateway: { port: 4766, bindMode: "loopback" as const, authMethod: "token" as const },
        });
      },
    };

    const reviewStep: WizardStep = {
      id: "review",
      label: "Review",
      execute: async (state) => state,
    };

    const writeConfigStep: WizardStep = {
      id: "write-config",
      label: "Write Config",
      execute: async (state) => state,
    };

    const finishStep: WizardStep = {
      id: "finish",
      label: "Finish",
      execute: async (state) => state,
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["gateway", gatewayStep],
      ["review", reviewStep],
      ["write-config", writeConfigStep],
      ["finish", finishStep],
    ]);

    // First call returns "cancel" (triggers CancelError), subsequent calls return non-cancel
    (mockPrompter.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("cancel")
      .mockResolvedValue("loopback");

    const result = await runWizardFlow("remote", mockPrompter, steps);

    // Confirmation was shown
    expect(mockPrompter.confirm).toHaveBeenCalledWith({
      message: "Are you sure you want to exit?",
      initialValue: false,
    });
    // Gateway was called twice (first cancel, then re-run)
    expect(gatewayCallCount).toBe(2);
    // Wizard completed
    expect(result.completedSteps).toContain("finish");
  });

  it("explicit cancel + confirm Yes → wizard exits", async () => {
    const mockPrompter = createMockPrompter();

    // confirm returns true → exit
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => updateState(state, { riskAccepted: true }),
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => updateState(state, { existingConfigAction: "fresh" as const }),
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => updateState(state, { flow: "remote" }),
    };

    const gatewayStep: WizardStep = {
      id: "gateway",
      label: "Gateway",
      execute: async (_state, stepPrompter) => {
        // Simulate user selecting Cancel
        await stepPrompter.select({
          message: "Configure",
          options: [
            { value: "loopback", label: "Loopback" },
            { value: "cancel", label: "Cancel" },
          ],
        });
        return _state;
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["gateway", gatewayStep],
    ]);

    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("cancel");

    const result = await runWizardFlow("remote", mockPrompter, steps);

    // Wizard exited — gateway not completed
    expect(result.completedSteps).not.toContain("gateway");
    expect(result.completedSteps).toContain("welcome");
  });

  it("double escape + confirm No → wizard continues", async () => {
    const mockPrompter = createMockPrompter();
    let detectCallCount = 0;

    // confirm returns false → stay
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => updateState(state, { riskAccepted: true }),
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => {
        detectCallCount++;
        if (detectCallCount <= 2) {
          throw new CancelError();
        }
        return updateState(state, { existingConfigAction: "fresh" as const });
      },
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => updateState(state, { flow: "remote" }),
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
    ]);

    const originalNow = Date.now;
    const mockTime = 1000;
    Date.now = () => mockTime;

    try {
      const result = await runWizardFlow("remote", mockPrompter, steps);

      // Confirmation was shown (for the double-escape)
      expect(mockPrompter.confirm).toHaveBeenCalled();
      // Wizard continued and completed
      expect(result.completedSteps).toContain("flow-select");
    } finally {
      Date.now = originalNow;
    }
  });

  it("confirm itself throws CancelError → wizard exits (user insists)", async () => {
    const mockPrompter = createMockPrompter();

    // confirm throws CancelError (user presses Escape on the confirmation)
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new CancelError());

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => updateState(state, { riskAccepted: true }),
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => updateState(state, { existingConfigAction: "fresh" as const }),
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => updateState(state, { flow: "remote" }),
    };

    const gatewayStep: WizardStep = {
      id: "gateway",
      label: "Gateway",
      execute: async (_state, stepPrompter) => {
        await stepPrompter.select({
          message: "Configure",
          options: [
            { value: "loopback", label: "Loopback" },
            { value: "cancel", label: "Cancel" },
          ],
        });
        return _state;
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["gateway", gatewayStep],
    ]);

    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("cancel");

    const result = await runWizardFlow("remote", mockPrompter, steps);

    // Wizard exited — CancelError on confirm treated as "yes, exit"
    expect(result.completedSteps).not.toContain("gateway");
    expect(mockPrompter.confirm).toHaveBeenCalled();
  });

  it("re-throws non-CancelError exceptions", async () => {
    const mockPrompter = createMockPrompter();

    const failStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async () => {
        throw new Error("unexpected failure");
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", failStep],
    ]);

    await expect(
      runWizardFlow("remote", mockPrompter, steps),
    ).rejects.toThrow("unexpected failure");
  });

  it("SkipError marks step complete and preserves state", async () => {
    const mockPrompter = createMockPrompter();

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => {
        return updateState(state, { riskAccepted: true });
      },
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect Existing",
      execute: async () => {
        // Simulate user choosing skip from a prompt
        throw new SkipError();
      },
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => {
        return updateState(state, { flow: "remote" });
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
    ]);

    const result = await runWizardFlow(
      "remote",
      mockPrompter,
      steps,
    );

    // Skipped step is marked complete
    expect(result.completedSteps).toContain("detect-existing");
    // State from before the skip is preserved (welcome's riskAccepted)
    expect(result.riskAccepted).toBe(true);
    // Wizard continued past the skipped step
    expect(result.completedSteps).toContain("flow-select");
    expect(result.flow).toBe("remote");
    // Info message was shown
    expect(mockPrompter.log.info).toHaveBeenCalledWith("Skipped: Detect Existing");
  });

  it("skip wrapping injects skip option into step prompts", async () => {
    const mockPrompter = createMockPrompter();
    // When the step calls prompter.select(), it receives the wrapped version
    // which appends a Skip option. Simulate the user choosing skip.
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue(SKIP_SENTINEL);

    // Use "workspace" -- a skippable step (not in NON_SKIPPABLE_STEPS)
    const workspaceStep: WizardStep = {
      id: "workspace",
      label: "Workspace",
      execute: async (state, prompter) => {
        await prompter.select({
          message: "Pick",
          options: [{ value: "a", label: "A" }],
        });
        return state;
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["workspace", workspaceStep],
    ]);

    const result = await runWizardFlow("advanced", mockPrompter, steps);

    // Workspace was skipped via the injected skip option
    expect(result.completedSteps).toContain("workspace");
    expect(mockPrompter.log.info).toHaveBeenCalledWith("Skipped: Workspace");
  });

  it("Cancel in non-skippable step exits immediately (explicit cancel)", async () => {
    const mockPrompter = createMockPrompter();
    (mockPrompter.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const welcomeStep: WizardStep = {
      id: "welcome",
      label: "Welcome",
      execute: async (state) => updateState(state, { riskAccepted: true }),
    };

    const detectStep: WizardStep = {
      id: "detect-existing",
      label: "Detect",
      execute: async (state) => updateState(state, { existingConfigAction: "fresh" as const }),
    };

    const flowSelectStep: WizardStep = {
      id: "flow-select",
      label: "Flow",
      execute: async (state) => updateState(state, { flow: "remote" }),
    };

    const gatewayStep: WizardStep = {
      id: "gateway",
      label: "Gateway",
      execute: async (state) => updateState(state, {
        gateway: { port: 4766, bindMode: "loopback" as const, authMethod: "token" as const },
      }),
    };

    // Review is non-skippable but should still handle Cancel → exit
    const reviewStep: WizardStep = {
      id: "review",
      label: "Review",
      execute: async (_state, prompter) => {
        // This prompter should be cancelPrompter (not raw), so Cancel is intercepted
        await prompter.select({
          message: "Review settings",
          options: [
            { value: "confirm", label: "Confirm" },
            { value: "cancel", label: "Cancel" },
          ],
        });
        return _state;
      },
    };

    const steps: StepRegistry = new Map<WizardStepId, WizardStep>([
      ["welcome", welcomeStep],
      ["detect-existing", detectStep],
      ["flow-select", flowSelectStep],
      ["gateway", gatewayStep],
      ["review", reviewStep],
    ]);

    // Mock select to return "cancel" (simulating user choosing Cancel in review)
    (mockPrompter.select as ReturnType<typeof vi.fn>).mockResolvedValue("cancel");

    const result = await runWizardFlow("remote", mockPrompter, steps);

    // Wizard exited immediately — review was NOT completed
    expect(result.completedSteps).not.toContain("review");
    // Previous steps were completed
    expect(result.completedSteps).toContain("welcome");
    expect(result.completedSteps).toContain("gateway");
  });
});
