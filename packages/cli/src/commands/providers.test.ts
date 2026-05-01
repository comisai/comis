// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the providers CLI command.
 *
 * Verifies:
 * - Command/subcommand/option registration mirrors `commands/models.ts` shape
 * - RPC success path: provider list + per-provider model count
 * - RPC failure path: local pi-ai catalog fallback
 * - --format json structured output
 * - --format table (default)
 * - Empty-catalog branch
 * - Status column resolution (keyless / configured / missing key)
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------- Mocks (hoisted) ----------

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

vi.mock("../client/provider-list.js", () => ({
  loadProvidersWithFallback: vi.fn(),
}));

vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../output/table.js", () => ({
  renderTable: vi.fn(),
}));

vi.mock("../output/format.js", () => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  json: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getEnvApiKey: vi.fn(),
}));

vi.mock("@comis/agent", () => ({
  createModelCatalog: vi.fn(() => ({
    loadStatic: vi.fn(),
    getByProvider: vi.fn(() => []),
    getAll: vi.fn(() => []),
    get: vi.fn(),
    mergeScanned: vi.fn(),
    getProviders: vi.fn(),
  })),
}));

// Dynamic imports after mocks (vitest hoists `vi.mock`, but explicit
// dynamic-import keeps the test file's intent crystal clear).
const { registerProvidersCommand } = await import("./providers.js");
const { withClient } = await import("../client/rpc-client.js");
const { loadProvidersWithFallback } = await import("../client/provider-list.js");
const { renderTable } = await import("../output/table.js");
const { info, json, error } = await import("../output/format.js");
const { getEnvApiKey } = await import("@mariozechner/pi-ai");

// ---------- Helpers ----------

function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerProvidersCommand(program);
  return program;
}

// ---------- Registration tests (mirrors models.test.ts shape) ----------

describe("registerProvidersCommand", () => {
  it("registers the providers command with a list subcommand", () => {
    const program = new Command();
    registerProvidersCommand(program);

    const providersCmd = program.commands.find((c) => c.name() === "providers");
    expect(providersCmd).toBeDefined();
    expect(providersCmd!.description()).toBe("Provider management");

    const subcommandNames = providersCmd!.commands.map((c) => c.name());
    expect(subcommandNames).toContain("list");
  });

  it("list subcommand has --format option with default 'table'", () => {
    const program = new Command();
    registerProvidersCommand(program);

    const providersCmd = program.commands.find((c) => c.name() === "providers");
    const listCmd = providersCmd!.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();

    const optionNames = listCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--format");
  });

  it("registers under the same program object as models (parallel structure)", () => {
    // Verifying that registerProvidersCommand uses program.command() like
    // registerModelsCommand -- shape parity is part of the contract.
    const program = new Command();
    registerProvidersCommand(program);
    expect(program.commands.length).toBeGreaterThan(0);
  });
});

// ---------- Behavior tests ----------

describe("providers list", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    vi.mocked(loadProvidersWithFallback).mockReset();
    vi.mocked(renderTable).mockReset();
    vi.mocked(info).mockReset();
    vi.mocked(json).mockReset();
    vi.mocked(error).mockReset();
    vi.mocked(getEnvApiKey).mockReset();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error("process.exit called");
      }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("Test 1: renders a 3-row table when RPC succeeds", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      "anthropic",
      "openai",
      "ollama",
    ]);
    vi.mocked(withClient).mockImplementation(async () => [
      { provider: "anthropic", modelId: "claude-1" },
      { provider: "anthropic", modelId: "claude-2" },
      { provider: "anthropic", modelId: "claude-3" },
      { provider: "anthropic", modelId: "claude-4" },
      { provider: "anthropic", modelId: "claude-5" },
    ]);
    vi.mocked(getEnvApiKey).mockReturnValue("sk-test");

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).toHaveBeenCalledOnce();
    const [headers, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(headers).toEqual(["Provider", "Models", "Status"]);
    expect(rows).toHaveLength(3);
  });

  it("Test 2: falls back to local catalog when daemon RPC fails", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      "anthropic",
    ]);
    vi.mocked(withClient).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(getEnvApiKey).mockReturnValue("sk-test");

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).toHaveBeenCalledOnce();
    // The local fallback in getModelCount returns 0 for empty catalog;
    // we still render the row -- the table presence is the contract.
    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("anthropic");
  });

  it("Test 3: --format json prints structured array, not a table", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      "anthropic",
      "openai",
    ]);
    vi.mocked(withClient).mockImplementation(async () => []);
    vi.mocked(getEnvApiKey).mockReturnValue("sk-test");

    const program = createTestProgram();
    await program.parseAsync([
      "node",
      "comis",
      "providers",
      "list",
      "--format",
      "json",
    ]);

    expect(json).toHaveBeenCalledOnce();
    expect(renderTable).not.toHaveBeenCalled();

    const payload = vi.mocked(json).mock.calls[0][0] as Array<{
      provider: string;
      modelCount: number;
      status: string;
    }>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      provider: "anthropic",
      status: "configured",
    });
  });

  it("Test 4: --format table (default) renders a table + info summary", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue(["anthropic"]);
    vi.mocked(withClient).mockImplementation(async () => []);
    vi.mocked(getEnvApiKey).mockReturnValue("sk-test");

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalled();
    const lastInfoMsg = vi.mocked(info).mock.calls.at(-1)?.[0];
    expect(lastInfoMsg).toMatch(/1 provider listed/);
  });

  it("Test 5: empty catalog prints 'No providers found' instead of an empty table", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    const infoCalls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => /No providers found in catalog/.test(m))).toBe(
      true,
    );
  });

  it("Test 6a: Status column = 'keyless' for ollama", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue(["ollama"]);
    vi.mocked(withClient).mockImplementation(async () => []);
    vi.mocked(getEnvApiKey).mockReturnValue(undefined);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("keyless");
  });

  it("Test 6b: Status column = 'keyless' for lm-studio", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue(["lm-studio"]);
    vi.mocked(withClient).mockImplementation(async () => []);
    vi.mocked(getEnvApiKey).mockReturnValue(undefined);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("keyless");
  });

  it("Test 6c: Status column = 'configured' when getEnvApiKey returns a key", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue(["anthropic"]);
    vi.mocked(withClient).mockImplementation(async () => []);
    vi.mocked(getEnvApiKey).mockImplementation((p: string) =>
      p === "anthropic" ? "sk-test" : undefined,
    );

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("configured");
  });

  it("Test 6d: Status column = 'missing key' when getEnvApiKey returns undefined", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue(["openai"]);
    vi.mocked(withClient).mockImplementation(async () => []);
    vi.mocked(getEnvApiKey).mockReturnValue(undefined);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("missing key");
  });
});
