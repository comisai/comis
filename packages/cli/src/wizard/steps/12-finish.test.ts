// SPDX-License-Identifier: Apache-2.0
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

  it("access token block shows full token with a keep-secret warning", async () => {
    const fullToken = "abcdef1234567890abcdef1234567890abcdef1234567890ab";
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "loopback",
        authMethod: "token",
        token: fullToken,
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const tokenNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes(fullToken),
    );
    expect(tokenNote).toBeDefined();
    // Full token shown (so the user can copy-paste), not a preview
    expect(tokenNote![0]).toContain(fullToken);
    expect(tokenNote![0]).not.toContain("...");
    // Warning + password-manager hint make it clear this is sensitive
    expect(tokenNote![0]).toMatch(/keep it secret/i);
    expect(tokenNote![0]).toMatch(/password manager/i);
  });

  it("shows copy-paste SSH tunnel recipe when gateway is loopback-only", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "loopback",
        authMethod: "token",
        token: "tok",
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const tunnelNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("ssh -N -L"),
    );
    expect(tunnelNote).toBeDefined();
    expect(tunnelNote![0]).toContain("ssh -N -L 4766:127.0.0.1:4766 root@YOUR-SERVER");
    expect(tunnelNote![0]).toContain("http://localhost:4766/app/");
  });

  it("does not show SSH tunnel recipe when gateway binds LAN", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "lan",
        authMethod: "token",
        token: "tok",
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const tunnelNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("ssh -N -L"),
    );
    expect(tunnelNote).toBeUndefined();
  });

  it("points user at their chosen password when using password auth", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "loopback",
        authMethod: "password",
        password: "my-secret-password",
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const tokenNote = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("password you set earlier"),
    );
    expect(tokenNote).toBeDefined();
    // Should NOT leak the actual password into the wizard output
    expect(tokenNote![0]).not.toContain("my-secret-password");
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
