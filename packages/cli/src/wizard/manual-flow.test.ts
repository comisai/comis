// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for manual wizard flow.
 *
 * Verifies full manual flow with provider, API key, agent name,
 * model selection, channels, gateway, data directory, and cancel handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";

// Use vi.hoisted() so mock fns are available before vi.mock hoisting
const {
  mockSelect, mockText, mockPassword, mockConfirm,
  mockMultiselect, mockIsCancel,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockText: vi.fn(),
  mockPassword: vi.fn(),
  mockConfirm: vi.fn(),
  mockMultiselect: vi.fn(),
  mockIsCancel: vi.fn(() => false),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  log: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  select: mockSelect,
  text: mockText,
  password: mockPassword,
  confirm: mockConfirm,
  multiselect: mockMultiselect,
  isCancel: mockIsCancel,
}));

// Mock config-writer
vi.mock("./config-writer.js", () => ({
  writeWizardConfig: vi.fn(() => ok("/tmp/config.yaml")),
  writeWizardEnv: vi.fn(() => ok(undefined)),
}));

// Mock @comis/agent
vi.mock("@comis/agent", () => ({
  createModelCatalog: vi.fn(() => ({
    loadStatic: vi.fn(),
    getByProvider: vi.fn(() => [
      { modelId: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet", contextWindow: 200000 },
      { modelId: "claude-haiku-35-20250929", displayName: "Claude Haiku", contextWindow: 200000 },
    ]),
  })),
}));

// Mock node:crypto
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({
    toString: vi.fn(() => "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"),
  })),
}));

import { runManualFlow } from "./manual-flow.js";
import { writeWizardConfig, writeWizardEnv } from "./config-writer.js";

describe("runManualFlow", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  /** Set up mock sequence for a complete happy-path flow. */
  function setupHappyPath(): void {
    // Step 1: provider
    mockSelect.mockResolvedValueOnce("anthropic");
    // Step 2: API key
    mockPassword.mockResolvedValueOnce("sk-test-key-1234567890abcdef");
    // Step 3: agent name
    mockText.mockResolvedValueOnce("TestBot");
    // Step 4: model selection
    mockSelect.mockResolvedValueOnce("claude-sonnet-4-5-20250929");
    // Step 5: channels -- no
    mockConfirm.mockResolvedValueOnce(false);
    // Step 6: gateway -- yes
    mockConfirm.mockResolvedValueOnce(true);
    // Step 6b: host
    mockText.mockResolvedValueOnce("127.0.0.1");
    // Step 6c: port
    mockText.mockResolvedValueOnce("3000");
    // Step 7: data dir
    mockText.mockResolvedValueOnce("/tmp/test-comis");
    // Step 8: confirm
    mockConfirm.mockResolvedValueOnce(true);
  }

  it("happy path -- writes config and env with all settings", async () => {
    setupHappyPath();

    const result = await runManualFlow("/tmp/test-comis");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe("anthropic");
      expect(result.value.agentName).toBe("TestBot");
      expect(result.value.model).toBe("claude-sonnet-4-5-20250929");
      expect(result.value.gatewayEnabled).toBe(true);
      expect(result.value.gatewayPort).toBe(3000);
      expect(result.value.gatewayToken).toBeDefined();
    }
    expect(writeWizardConfig).toHaveBeenCalled();
    expect(writeWizardEnv).toHaveBeenCalled();
  });

  it("cancel at provider step calls process.exit", async () => {
    const cancelSymbol = Symbol("cancel");
    mockSelect.mockResolvedValueOnce(cancelSymbol);
    mockIsCancel.mockImplementation((val) => val === cancelSymbol);

    await expect(runManualFlow("/tmp/test-comis")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("gateway disabled path -- no token generated", async () => {
    // Step 1: provider
    mockSelect.mockResolvedValueOnce("anthropic");
    // Step 2: API key
    mockPassword.mockResolvedValueOnce("sk-test-key-1234567890abcdef");
    // Step 3: agent name
    mockText.mockResolvedValueOnce("TestBot");
    // Step 4: model selection
    mockSelect.mockResolvedValueOnce("claude-sonnet-4-5-20250929");
    // Step 5: channels -- no
    mockConfirm.mockResolvedValueOnce(false);
    // Step 6: gateway -- no
    mockConfirm.mockResolvedValueOnce(false);
    // Step 7: data dir
    mockText.mockResolvedValueOnce("/tmp/test-comis");
    // Step 8: confirm
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runManualFlow("/tmp/test-comis");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.gatewayEnabled).toBe(false);
      expect(result.value.gatewayToken).toBeUndefined();
    }
  });

  it("custom model via __custom__ selection", async () => {
    // Step 1: provider
    mockSelect.mockResolvedValueOnce("anthropic");
    // Step 2: API key
    mockPassword.mockResolvedValueOnce("sk-test-key-1234567890abcdef");
    // Step 3: agent name
    mockText.mockResolvedValueOnce("TestBot");
    // Step 4: model selection -- custom
    mockSelect.mockResolvedValueOnce("__custom__");
    // Step 4b: custom model text
    mockText.mockResolvedValueOnce("my-custom-model-v1");
    // Step 5: channels -- no
    mockConfirm.mockResolvedValueOnce(false);
    // Step 6: gateway -- no
    mockConfirm.mockResolvedValueOnce(false);
    // Step 7: data dir
    mockText.mockResolvedValueOnce("/tmp/test-comis");
    // Step 8: confirm
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runManualFlow("/tmp/test-comis");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe("my-custom-model-v1");
    }
  });
});
