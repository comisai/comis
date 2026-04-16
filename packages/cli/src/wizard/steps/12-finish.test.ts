/**
 * Tests for finish step (step 12).
 *
 * Verifies quick-reference card display, gateway access info,
 * shell completion offer, and branded outro message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { finishStep } from "./12-finish.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    confirm?: boolean[];
  } = {},
): WizardPrompter {
  const confirmQueue = [...(responses.confirm ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async (opts) => opts.defaultValue ?? ""),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => ""),
    confirm: vi.fn(async () => confirmQueue.shift() ?? false),
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

describe("finishStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct step id and label", () => {
    expect(finishStep.id).toBe("finish");
    expect(finishStep.label).toBe("Finish");
  });

  it("displays quick-reference card note with commands", async () => {
    const prompter = createMockPrompter();

    await finishStep.execute(baseState(), prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    // First note call is the quick reference card
    expect(noteCalls.length).toBeGreaterThanOrEqual(1);
    const referenceCard = noteCalls[0][0];
    expect(referenceCard).toContain("comis daemon start");
    expect(referenceCard).toContain("comis status");
    expect(referenceCard).toContain("comis doctor");
    expect(referenceCard).toContain("comis --help");
  });

  it("shell completion offer declined by default", async () => {
    const prompter = createMockPrompter({
      confirm: [false],
    });

    await finishStep.execute(baseState(), prompter);

    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enable shell completions for comis?",
      }),
    );

    // When declined, should NOT show completion info
    const infoCalls = vi.mocked(prompter.log.info).mock.calls;
    const completionCalls = infoCalls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("shell completion"),
    );
    expect(completionCalls).toHaveLength(0);
  });

  it("shell completion offer accepted shows info", async () => {
    const prompter = createMockPrompter({
      confirm: [true],
    });

    await finishStep.execute(baseState(), prompter);

    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("comis --help"),
    );
  });

  it("displays gateway info when state.gateway exists", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 9000,
        bindMode: "loopback",
        authMethod: "token",
        token: "abcdef1234567890abcdef1234567890abcdef1234567890ab",
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    // Should have at least 2 notes: reference card + gateway access
    expect(noteCalls.length).toBeGreaterThanOrEqual(2);

    const gatewayNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("9000"),
    );
    expect(gatewayNote).toBeDefined();
    expect(gatewayNote![0]).toContain("ws://");
  });

  it("does not display gateway info when state.gateway is absent", async () => {
    const prompter = createMockPrompter();

    await finishStep.execute(baseState(), prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    // Only 1 note (reference card), no gateway note
    expect(noteCalls).toHaveLength(1);
  });

  it("gateway info shows token preview for token auth", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "loopback",
        authMethod: "token",
        token: "abcdef1234567890abcdef1234567890abcdef1234567890ab",
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const gatewayNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("Token"),
    );
    expect(gatewayNote).toBeDefined();
    // Should show first 8 chars of token
    expect(gatewayNote![0]).toContain("abcdef12...");
  });

  it("gateway info shows password auth reference for password auth", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "loopback",
        authMethod: "password",
        password: "my-secret-password",
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const gatewayNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("Password auth"),
    );
    expect(gatewayNote).toBeDefined();
  });

  it("outro() called with completion message", async () => {
    const prompter = createMockPrompter();

    await finishStep.execute(baseState(), prompter);

    expect(prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining("comis status"),
    );
  });

  it("returns state unchanged", async () => {
    const state = baseState();
    const prompter = createMockPrompter();

    const result = await finishStep.execute(state, prompter);

    expect(result.completedSteps).toEqual([]);
    expect(result.gateway).toBeUndefined();
  });
});
