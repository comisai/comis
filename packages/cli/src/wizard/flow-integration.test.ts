/**
 * End-to-end flow integration tests for the wizard state machine.
 *
 * Tests runWizardFlow() orchestration: step ordering, state accumulation,
 * _jumpTo go-back, CancelError handling, and unregistered step skipping.
 * Does NOT test individual step logic (that's covered in per-step tests).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { WizardState, WizardStep, WizardStepId } from "./types.js";
import type { WizardPrompter } from "./prompter.js";
import { CancelError } from "./prompter.js";
import { runWizardFlow, updateState } from "./state.js";
import type { StepRegistry } from "./state.js";

// ---------- ScriptedPrompter ----------

/**
 * WizardPrompter that plays back scripted responses.
 * Used to exercise the full flow without real user interaction.
 */
class ScriptedPrompter implements WizardPrompter {
  private selectResponses: unknown[] = [];
  private textResponses: string[] = [];
  private confirmResponses: boolean[] = [];
  private passwordResponses: string[] = [];

  constructor(script: {
    selects?: unknown[];
    texts?: string[];
    confirms?: boolean[];
    passwords?: string[];
  } = {}) {
    this.selectResponses = [...(script.selects ?? [])];
    this.textResponses = [...(script.texts ?? [])];
    this.confirmResponses = [...(script.confirms ?? [])];
    this.passwordResponses = [...(script.passwords ?? [])];
  }

  intro = vi.fn();
  outro = vi.fn();
  note = vi.fn();

  async select<T>(): Promise<T> {
    return this.selectResponses.shift() as T;
  }
  async multiselect<T>(): Promise<T[]> {
    return this.selectResponses.shift() as T[];
  }
  async text(): Promise<string> {
    return this.textResponses.shift() ?? "";
  }
  async password(): Promise<string> {
    return this.passwordResponses.shift() ?? "";
  }
  async confirm(): Promise<boolean> {
    return this.confirmResponses.shift() ?? true;
  }
  spinner = vi.fn(() => ({ start: vi.fn(), update: vi.fn(), stop: vi.fn() }));
  async group<T extends Record<string, unknown>>(
    steps: { [K in keyof T]: () => Promise<T[K]> },
  ): Promise<T> {
    const r = {} as Record<string, unknown>;
    for (const [k, fn] of Object.entries(steps)) r[k] = await fn();
    return r as T;
  }
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() };
}

// ---------- Mock Step Factory ----------

/**
 * Create a mock step that merges fixed updates into state.
 */
function mockStep(
  id: WizardStepId,
  updates: Partial<WizardState>,
): WizardStep {
  return {
    id,
    label: `Mock ${id}`,
    execute: async (state, _prompter) => updateState(state, updates),
  };
}

/**
 * Create a mock step that calls an execute function.
 */
function mockStepFn(
  id: WizardStepId,
  executeFn: (state: WizardState, prompter: WizardPrompter) => Promise<WizardState>,
): WizardStep {
  return {
    id,
    label: `Mock ${id}`,
    execute: executeFn,
  };
}

// ==========================================================================
// QuickStart flow integration
// ==========================================================================

describe("QuickStart flow integration", () => {
  it("runs all steps in correct order and accumulates state", async () => {
    const prompter = new ScriptedPrompter();
    const steps: StepRegistry = new Map();

    // QuickStart flow: welcome, detect-existing, flow-select, provider,
    // credentials, agent, review, write-config, daemon-start, finish
    steps.set("welcome", mockStep("welcome", { riskAccepted: true }));
    steps.set("detect-existing", mockStep("detect-existing", {}));
    steps.set("flow-select", mockStep("flow-select", { flow: "quickstart" }));
    steps.set("provider", mockStep("provider", { provider: { id: "anthropic" } }));
    steps.set("credentials", mockStep("credentials", {}));
    steps.set("agent", mockStep("agent", { agentName: "test-agent", model: "claude-test" }));
    steps.set("review", mockStep("review", {}));
    steps.set("write-config", mockStep("write-config", {}));
    steps.set("daemon-start", mockStep("daemon-start", {}));
    steps.set("finish", mockStep("finish", {}));

    const finalState = await runWizardFlow("quickstart", prompter, steps);

    expect(finalState.riskAccepted).toBe(true);
    expect(finalState.flow).toBe("quickstart");
    expect(finalState.provider).toEqual({ id: "anthropic" });
    expect(finalState.agentName).toBe("test-agent");
    expect(finalState.model).toBe("claude-test");

    // All 10 quickstart steps should be in completedSteps
    expect(finalState.completedSteps).toContain("welcome");
    expect(finalState.completedSteps).toContain("detect-existing");
    expect(finalState.completedSteps).toContain("flow-select");
    expect(finalState.completedSteps).toContain("provider");
    expect(finalState.completedSteps).toContain("credentials");
    expect(finalState.completedSteps).toContain("agent");
    expect(finalState.completedSteps).toContain("review");
    expect(finalState.completedSteps).toContain("write-config");
    expect(finalState.completedSteps).toContain("daemon-start");
    expect(finalState.completedSteps).toContain("finish");
    expect(finalState.completedSteps).toHaveLength(10);

    // channels step is NOT in quickstart flow, so NOT in completedSteps
    expect(finalState.completedSteps).not.toContain("channels");
  });
});

// ==========================================================================
// Advanced flow integration
// ==========================================================================

describe("Advanced flow integration", () => {
  it("runs all 13 steps and populates full state", async () => {
    const prompter = new ScriptedPrompter();
    const steps: StepRegistry = new Map();

    // Advanced flow: welcome, detect-existing, flow-select, provider,
    // credentials, agent, channels, gateway, workspace, review,
    // write-config, daemon-start, finish
    steps.set("welcome", mockStep("welcome", { riskAccepted: true }));
    steps.set("detect-existing", mockStep("detect-existing", {}));
    steps.set("flow-select", mockStep("flow-select", { flow: "advanced" }));
    steps.set("provider", mockStep("provider", { provider: { id: "openai" } }));
    steps.set("credentials", mockStep("credentials", {}));
    steps.set("agent", mockStep("agent", { agentName: "adv-agent", model: "gpt-4o" }));
    steps.set("channels", mockStep("channels", { channels: [{ type: "telegram", botToken: "tok" }] }));
    steps.set("gateway", mockStep("gateway", { gateway: { port: 4766, bindMode: "loopback", authMethod: "token", token: "abc" } }));
    steps.set("workspace", mockStep("workspace", { dataDir: "/tmp/data" }));
    steps.set("review", mockStep("review", {}));
    steps.set("write-config", mockStep("write-config", {}));
    steps.set("daemon-start", mockStep("daemon-start", {}));
    steps.set("finish", mockStep("finish", {}));

    const finalState = await runWizardFlow("advanced", prompter, steps);

    // Check all state fields
    expect(finalState.riskAccepted).toBe(true);
    expect(finalState.flow).toBe("advanced");
    expect(finalState.provider).toEqual({ id: "openai" });
    expect(finalState.agentName).toBe("adv-agent");
    expect(finalState.model).toBe("gpt-4o");
    expect(finalState.channels).toHaveLength(1);
    expect(finalState.gateway).toBeDefined();
    expect(finalState.gateway!.port).toBe(4766);
    expect(finalState.dataDir).toBe("/tmp/data");

    // All 14 steps in completedSteps
    expect(finalState.completedSteps).toHaveLength(14);
    expect(finalState.completedSteps).toContain("channels");
    expect(finalState.completedSteps).toContain("gateway");
    expect(finalState.completedSteps).toContain("workspace");
  });
});

// ==========================================================================
// Flow with _jumpTo
// ==========================================================================

describe("Flow with _jumpTo", () => {
  it("jumps back to provider step and re-executes downstream steps", async () => {
    const prompter = new ScriptedPrompter();
    const steps: StepRegistry = new Map();

    let reviewCallCount = 0;

    steps.set("welcome", mockStep("welcome", { riskAccepted: true }));
    steps.set("detect-existing", mockStep("detect-existing", {}));
    steps.set("flow-select", mockStep("flow-select", { flow: "quickstart" }));

    // Provider step: first call sets anthropic, second call sets openai
    let providerCallCount = 0;
    steps.set("provider", mockStepFn("provider", async (state) => {
      providerCallCount++;
      if (providerCallCount === 1) {
        return updateState(state, { provider: { id: "anthropic" } });
      }
      return updateState(state, { provider: { id: "openai" } });
    }));

    steps.set("credentials", mockStep("credentials", {}));
    steps.set("agent", mockStep("agent", { agentName: "test-agent", model: "test-model" }));

    // Review step: first call returns _jumpTo=provider, second call passes through
    steps.set("review", mockStepFn("review", async (state) => {
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return { ...state, _jumpTo: "provider" as WizardStepId };
      }
      return state;
    }));

    steps.set("write-config", mockStep("write-config", {}));
    steps.set("daemon-start", mockStep("daemon-start", {}));
    steps.set("finish", mockStep("finish", {}));

    const finalState = await runWizardFlow("quickstart", prompter, steps);

    // Provider was called twice (original + after jump)
    expect(providerCallCount).toBe(2);

    // Review was called twice (first triggered jump, second passed through)
    expect(reviewCallCount).toBe(2);

    // Final state should have the second provider (openai, from re-run)
    expect(finalState.provider!.id).toBe("openai");

    // All steps should be completed
    expect(finalState.completedSteps).toContain("finish");
  });
});

// ==========================================================================
// Flow with CancelError
// ==========================================================================

describe("Flow with CancelError", () => {
  it("returns state before the cancelling step without throwing", async () => {
    const prompter = new ScriptedPrompter();
    const steps: StepRegistry = new Map();

    steps.set("welcome", mockStep("welcome", { riskAccepted: true }));
    steps.set("detect-existing", mockStep("detect-existing", {}));
    steps.set("flow-select", mockStep("flow-select", { flow: "quickstart" }));

    // Provider step throws CancelError
    steps.set("provider", mockStepFn("provider", async () => {
      throw new CancelError();
    }));

    steps.set("credentials", mockStep("credentials", {}));
    steps.set("agent", mockStep("agent", { agentName: "never-reached" }));

    // Should NOT throw -- CancelError is caught by runWizardFlow
    const finalState = await runWizardFlow("quickstart", prompter, steps);

    // State should have welcome and detect-existing and flow-select completed
    expect(finalState.riskAccepted).toBe(true);
    expect(finalState.flow).toBe("quickstart");

    // Provider step did NOT complete
    expect(finalState.completedSteps).not.toContain("provider");

    // Agent step never ran
    expect(finalState.agentName).toBeUndefined();
  });
});

// ==========================================================================
// Unregistered steps are skipped
// ==========================================================================

describe("Unregistered steps are skipped", () => {
  it("completes flow when only some steps are registered", async () => {
    const prompter = new ScriptedPrompter();
    const steps: StepRegistry = new Map();

    // Only register welcome and finish -- all other steps are unregistered
    steps.set("welcome", mockStep("welcome", { riskAccepted: true }));
    steps.set("finish", mockStep("finish", {}));

    const finalState = await runWizardFlow("quickstart", prompter, steps);

    // Flow completes without error
    expect(finalState.riskAccepted).toBe(true);

    // All steps are in completedSteps (unregistered ones auto-completed)
    expect(finalState.completedSteps).toContain("welcome");
    expect(finalState.completedSteps).toContain("detect-existing");
    expect(finalState.completedSteps).toContain("flow-select");
    expect(finalState.completedSteps).toContain("provider");
    expect(finalState.completedSteps).toContain("credentials");
    expect(finalState.completedSteps).toContain("agent");
    expect(finalState.completedSteps).toContain("review");
    expect(finalState.completedSteps).toContain("write-config");
    expect(finalState.completedSteps).toContain("daemon-start");
    expect(finalState.completedSteps).toContain("finish");
    expect(finalState.completedSteps).toHaveLength(10);
  });
});
