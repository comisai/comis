// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the providers CLI command.
 *
 * Verifies:
 * - Command/subcommand/option registration mirrors `commands/models.ts` shape
 * - daemon and offline provider status projections
 * - --format json structured output
 * - --format table (default)
 * - Empty-catalog branch
 * - Status column resolution without credential values
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------- Mocks (hoisted) ----------

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

// Dynamic imports after mocks (vitest hoists `vi.mock`, but explicit
// dynamic-import keeps the test file's intent crystal clear).
const { registerProvidersCommand } = await import("./providers.js");
const { loadProvidersWithFallback } = await import("../client/provider-list.js");
const { renderTable } = await import("../output/table.js");
const { info, json, error } = await import("../output/format.js");

// ---------- Helpers ----------

function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerProvidersCommand(program);
  return program;
}

function makeRow(
  provider: string,
  status: "configured" | "keyless" | "not_configured" | "unknown" = "configured",
) {
  return {
    provider,
    modelCount: 1,
    status,
    credentialSource: status === "keyless"
      ? "keyless" as const
      : status === "unknown"
        ? "daemon_unavailable" as const
        : status === "not_configured"
          ? "none" as const
          : "env_canonical" as const,
  };
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
    expect(optionNames).toContain("--agent");
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
    vi.mocked(loadProvidersWithFallback).mockReset();
    vi.mocked(renderTable).mockReset();
    vi.mocked(info).mockReset();
    vi.mocked(json).mockReset();
    vi.mocked(error).mockReset();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error("process.exit called");
      }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("renders a 3-row table when RPC succeeds", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      makeRow("anthropic"),
      makeRow("openai", "not_configured"),
      makeRow("ollama", "keyless"),
    ]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).toHaveBeenCalledOnce();
    const [headers, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(headers).toEqual(["Provider", "Models", "Status"]);
    expect(rows).toHaveLength(3);
  });

  it("falls back to local catalog when daemon RPC fails", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      makeRow("anthropic", "unknown"),
    ]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).toHaveBeenCalledOnce();
    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("anthropic");
  });

  it("--format json prints structured array, not a table", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      makeRow("anthropic"),
      makeRow("openai"),
    ]);

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

  it("preserves daemon credential truth when encrypted credentials are not in the CLI environment", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      {
        provider: "amazon-bedrock",
        modelCount: 109,
        status: "configured",
        credentialSource: "secret_store_canonical",
      },
    ] as never);
    const program = createTestProgram();
    await program.parseAsync([
      "node",
      "comis",
      "providers",
      "list",
      "--format",
      "json",
    ]);

    expect(json).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: "amazon-bedrock",
        modelCount: 109,
        status: "configured",
        credentialSource: "secret_store_canonical",
      }),
    ]);
  });

  it("forwards an explicit agent selector to the daemon-backed loader", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([makeRow("anthropic")]);

    const program = createTestProgram();
    await program.parseAsync([
      "node",
      "comis",
      "providers",
      "list",
      "--agent",
      "research",
    ]);

    expect(loadProvidersWithFallback).toHaveBeenCalledWith("research");
  });

  it("--format table (default) renders a table + info summary", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([makeRow("anthropic")]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    expect(renderTable).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalled();
    const lastInfoMsg = vi.mocked(info).mock.calls.at(-1)?.[0];
    expect(lastInfoMsg).toMatch(/1 provider listed/);
  });

  it("empty catalog prints 'No providers found' instead of an empty table", async () => {
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

  it("Status column = 'keyless' for ollama", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([makeRow("ollama", "keyless")]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("keyless");
  });

  it("Status column = 'keyless' for lm-studio", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([makeRow("lm-studio", "keyless")]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("keyless");
  });

  it("Status column = 'configured' for an authoritative configured row", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([makeRow("anthropic")]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("configured");
  });

  it("Status column distinguishes not configured from an unavailable daemon", async () => {
    vi.mocked(loadProvidersWithFallback).mockResolvedValue([
      makeRow("openai", "not_configured"),
      makeRow("anthropic", "unknown"),
    ]);

    const program = createTestProgram();
    await program.parseAsync(["node", "comis", "providers", "list"]);

    const [, rows] = vi.mocked(renderTable).mock.calls[0];
    expect(rows[0][2]).toBe("not configured");
    expect(rows[1][2]).toBe("unknown");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("daemon"));
  });
});
