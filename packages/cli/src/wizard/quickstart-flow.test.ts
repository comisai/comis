/**
 * Tests for quickstart wizard flow.
 *
 * Verifies provider selection, API key handling, model catalog
 * fallback, and config write behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  log: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
  group: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(() => false),
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
    ]),
  })),
}));

import * as p from "@clack/prompts";
import { runQuickStartFlow } from "./quickstart-flow.js";
import { writeWizardConfig, writeWizardEnv } from "./config-writer.js";
import { createModelCatalog } from "@comis/agent";

describe("runQuickStartFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path -- Anthropic provider writes config and env", async () => {
    vi.mocked(p.group).mockResolvedValue({
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890abcdef",
      agentName: "TestBot",
    });

    const result = await runQuickStartFlow("/tmp/test-comis");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe("anthropic");
      expect(result.value.agentName).toBe("TestBot");
      expect(result.value.model).toBe("claude-sonnet-4-5-20250929");
    }
    expect(writeWizardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" }),
      "/tmp/test-comis",
    );
    expect(writeWizardEnv).toHaveBeenCalled();
  });

  it("happy path -- Ollama skips env write when no API key", async () => {
    vi.mocked(p.group).mockResolvedValue({
      provider: "ollama",
      apiKey: "",
      agentName: "LocalBot",
    });

    const result = await runQuickStartFlow("/tmp/test-comis");

    expect(result.ok).toBe(true);
    expect(writeWizardEnv).not.toHaveBeenCalled();
  });

  it("falls back to default model when catalog throws", async () => {
    vi.mocked(createModelCatalog).mockImplementation(() => {
      throw new Error("catalog load failed");
    });

    vi.mocked(p.group).mockResolvedValue({
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890abcdef",
      agentName: "TestBot",
    });

    const result = await runQuickStartFlow("/tmp/test-comis");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe("claude-sonnet-4-5-20250929");
    }
  });

  it("returns err when writeWizardConfig fails", async () => {
    vi.mocked(p.group).mockResolvedValue({
      provider: "anthropic",
      apiKey: "sk-test-key-1234567890abcdef",
      agentName: "TestBot",
    });
    vi.mocked(writeWizardConfig).mockReturnValue(err(new Error("disk full")));

    const result = await runQuickStartFlow("/tmp/test-comis");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("disk full");
    }
  });
});
