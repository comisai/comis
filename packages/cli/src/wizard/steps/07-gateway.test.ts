// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for gateway configuration step (step 07).
 *
 * Verifies port selection, bind mode prompts, unconditional token
 * generation (token is the only gateway auth method), LAN security
 * warning, and custom IP input.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({
    toString: () => "a".repeat(48),
  })),
}));

import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { gatewayStep } from "./07-gateway.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    text?: string[];
    select?: string[];
    password?: string[];
  } = {},
): WizardPrompter {
  const textQueue = [...(responses.text ?? [])];
  const selectQueue = [...(responses.select ?? [])];
  const passwordQueue = [...(responses.password ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async (opts) => {
      const val = textQueue.shift();
      return val ?? opts.defaultValue ?? "";
    }),
    select: vi.fn(async () => selectQueue.shift() ?? ""),
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

describe("gatewayStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct step id and label", () => {
    expect(gatewayStep.id).toBe("gateway");
    expect(gatewayStep.label).toBe("Gateway Configuration");
  });

  it("default token flow sets gateway config correctly", async () => {
    const prompter = createMockPrompter({
      text: ["4766"],
      select: ["loopback"],
    });

    const result = await gatewayStep.execute(baseState(), prompter);

    expect(result.gateway).toBeDefined();
    expect(result.gateway!.port).toBe(4766);
    expect(result.gateway!.bindMode).toBe("loopback");
    expect(result.gateway!.token).toBe("a".repeat(48));
  });

  it("LAN bind mode triggers security warning", async () => {
    const prompter = createMockPrompter({
      text: ["4766"],
      select: ["lan"],
    });

    await gatewayStep.execute(baseState(), prompter);

    expect(prompter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("LAN mode"),
    );
  });

  it("custom bind mode prompts for IP address", async () => {
    const prompter = createMockPrompter({
      text: ["4766", "192.168.1.100"],
      select: ["custom"],
    });

    const result = await gatewayStep.execute(baseState(), prompter);

    expect(result.gateway!.bindMode).toBe("custom");
    expect(result.gateway!.customIp).toBe("192.168.1.100");
    // text should be called twice: once for port, once for custom IP
    expect(prompter.text).toHaveBeenCalledTimes(2);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Bind IP address" }),
    );
  });

  it("port text prompt has validate function", async () => {
    const prompter = createMockPrompter({
      text: ["4766"],
      select: ["loopback"],
    });

    await gatewayStep.execute(baseState(), prompter);

    // Extract the options passed to the first text() call (port prompt)
    const textCall = vi.mocked(prompter.text).mock.calls[0][0];
    expect(textCall.validate).toBeDefined();

    // Valid port should return undefined
    expect(textCall.validate!("4766")).toBeUndefined();

    // Invalid port should return an error message string
    const invalidResult = textCall.validate!("abc");
    expect(typeof invalidResult).toBe("string");
  });

  it("token auth logs the generated token", async () => {
    const prompter = createMockPrompter({
      text: ["4766"],
      select: ["loopback"],
    });

    await gatewayStep.execute(baseState(), prompter);

    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("a".repeat(48)),
    );
  });

  it("shows section separator note", async () => {
    const prompter = createMockPrompter({
      text: ["4766"],
      select: ["loopback"],
    });

    await gatewayStep.execute(baseState(), prompter);

    expect(prompter.note).toHaveBeenCalled();
  });
});
