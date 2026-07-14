// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for finish step (step 12).
 *
 * Verifies quick-reference card display, gateway access info,
 * accurate access guidance and branded outro message.
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
    expect(referenceCard).toContain("comis init");
    expect(referenceCard).not.toContain("configure --section channels");
  });

  it("does not offer shell completion when no completion command exists", async () => {
    const prompter = createMockPrompter();

    await finishStep.execute(baseState(), prompter);

    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("displays gateway info when state.gateway exists", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 9000,
        bindMode: "loopback",
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
    expect(tokenNote![0].split(fullToken)).toHaveLength(2);
  });

  it("access token block describes encrypted storage without claiming the token is in .env", async () => {
    const state: WizardState = {
      completedSteps: [],
      storageMode: "encrypted",
      gateway: {
        port: 4766,
        bindMode: "loopback",
        token: "test-token",
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const tokenNote = vi.mocked(prompter.note).mock.calls.find(
      ([message]) => String(message).includes("test-token"),
    );
    expect(tokenNote?.[0]).toContain("encrypted secrets database");
    expect(tokenNote?.[0]).toContain("decryption key");
    expect(tokenNote?.[0]).not.toContain("It is also stored at ~/.comis/.env");
  });

  it("access token block names .env only when file storage was selected", async () => {
    const state: WizardState = {
      completedSteps: [],
      storageMode: "file",
      gateway: {
        port: 4766,
        bindMode: "loopback",
        token: "test-token",
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const tokenNote = vi.mocked(prompter.note).mock.calls.find(
      ([message]) => String(message).includes("test-token"),
    );
    expect(tokenNote?.[0]).toContain("~/.comis/.env");
    expect(tokenNote?.[0]).toContain("0600");
    expect(tokenNote?.[0]).not.toContain("encrypted secrets database");
  });

  it("shows copy-paste SSH tunnel recipe when gateway is loopback-only", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "loopback",
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

  it("LAN gateway access uses a reachable local URL and explains remote LAN access", async () => {
    const state: WizardState = {
      completedSteps: [],
      gateway: {
        port: 4766,
        bindMode: "lan",
        token: "test-token",
        webEnabled: true,
      },
    };
    const prompter = createMockPrompter();

    await finishStep.execute(state, prompter);

    const gatewayNote = vi.mocked(prompter.note).mock.calls.find(
      ([message]) => String(message).includes("Dashboard:"),
    );
    expect(gatewayNote?.[0]).toContain("http://127.0.0.1:4766/app/");
    expect(gatewayNote?.[0]).toContain("LAN IP or hostname");
    expect(gatewayNote?.[0]).not.toContain("0.0.0.0");
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
