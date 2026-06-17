// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for memory query commands.
 *
 * Verifies command registration, subcommand structure, options,
 * and safety checks for the memory command group.
 */

import { Command } from "commander";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerMemoryCommand } from "./memory.js";

describe("registerMemoryCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
  });

  it("registers the memory command group", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    expect(memoryCmd).toBeDefined();
    expect(memoryCmd!.description()).toBe("Memory management");
  });

  it("registers search subcommand with options", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const searchCmd = memoryCmd!.commands.find((c) => c.name() === "search");
    expect(searchCmd).toBeDefined();
    expect(searchCmd!.description()).toBe("Search memory entries");

    const limitOpt = searchCmd!.options.find((o) => o.long === "--limit");
    expect(limitOpt).toBeDefined();
    const formatOpt = searchCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("registers inspect subcommand with format option", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const inspectCmd = memoryCmd!.commands.find((c) => c.name() === "inspect");
    expect(inspectCmd).toBeDefined();
    expect(inspectCmd!.description()).toBe("Display full details of a memory entry");

    const formatOpt = inspectCmd!.options.find((o) => o.long === "--format");
    expect(formatOpt).toBeDefined();
  });

  it("registers stats subcommand", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const statsCmd = memoryCmd!.commands.find((c) => c.name() === "stats");
    expect(statsCmd).toBeDefined();
    expect(statsCmd!.description()).toBe("Display memory statistics");
  });

  it("registers clear subcommand with safety options", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const clearCmd = memoryCmd!.commands.find((c) => c.name() === "clear");
    expect(clearCmd).toBeDefined();
    expect(clearCmd!.description()).toBe("Clear memory entries matching a filter");

    const filterOpt = clearCmd!.options.find((o) => o.long === "--filter");
    expect(filterOpt).toBeDefined();
    const tenantOpt = clearCmd!.options.find((o) => o.long === "--tenant");
    expect(tenantOpt).toBeDefined();
    const yesOpt = clearCmd!.options.find((o) => o.long === "--yes");
    expect(yesOpt).toBeDefined();
  });

  it("has all subcommands under memory (incl. diagnostics and portability)", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const subcommands = memoryCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual([
      "clear",
      "entities",
      "export",
      "import",
      "inspect",
      "learning",
      "observations",
      "pin",
      "recall-trace",
      "search",
      "stats",
      "unpin",
    ]);
  });

  it("shows help text for memory command", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const helpText = memoryCmd!.helpInformation();
    expect(helpText).toContain("memory");
    expect(helpText).toContain("search");
    expect(helpText).toContain("inspect");
    expect(helpText).toContain("stats");
    expect(helpText).toContain("clear");
  });

  // -------------------------------------------------------------------------
  // Diagnostic subcommands — structure + options.
  // -------------------------------------------------------------------------
  it("registers recall-trace <session> with --trace-id / --agent / --limit / --format", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const cmd = memoryCmd!.commands.find((c) => c.name() === "recall-trace");
    expect(cmd).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--trace-id")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--agent")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--limit")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--format")).toBeDefined();
  });

  it("registers observations with --agent / --limit / --format", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const cmd = memoryCmd!.commands.find((c) => c.name() === "observations");
    expect(cmd).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--agent")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--limit")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--format")).toBeDefined();
  });

  it("registers entities with --agent / --limit / --format", () => {
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const cmd = memoryCmd!.commands.find((c) => c.name() === "entities");
    expect(cmd).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--agent")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--limit")).toBeDefined();
    expect(cmd!.options.find((o) => o.long === "--format")).toBeDefined();
  });
});

describe("memory search runs the contracted entry search (stub-era exit-1 removed, live finding 2026-06-11)", () => {
  it("renders the matched entries instead of the stale pipeline-era refusal", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const rpc = await import("../client/rpc-client.js");
    const callTypedSpy = vi.spyOn(rpc, "callTyped").mockResolvedValue({
      results: [
        { id: "8a6087cd-e867-43e4-9850-15be4f510598", content: "User has a golden retriever named Biscuit.", score: 0.97, tags: [], createdAt: 1 },
      ],
    } as never);
    const withClientSpy = vi.spyOn(rpc, "withClient").mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({}) as never);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "memory", "search", "dog name"]);
      const out = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("8a6087cd");
      expect(out).toContain("golden retriever");
    } finally {
      callTypedSpy.mockRestore();
      withClientSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe("memory clear safety checks", () => {
  it("requires at least one filter", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "memory", "clear", "--yes"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("At least one filter is required");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("requires --yes flag in non-TTY mode", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync([
        "node",
        "test",
        "memory",
        "clear",
        "--filter",
        "memoryType=conversation",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Confirmation required");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("memory inspect shows the entry detail (stub-era exit-1 removed, live finding 2026-06-11)", () => {
  it("finds the entry by id prefix via memory.browse and renders its fields", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const rpc = await import("../client/rpc-client.js");
    const callTypedSpy = vi.spyOn(rpc, "callTyped").mockResolvedValue({
      entries: [
        { id: "abc-123-full", content: "User prefers green tea.", trustLevel: "learned" },
      ],
      total: 1,
    } as never);
    const withClientSpy = vi.spyOn(rpc, "withClient").mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({}) as never);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await program.parseAsync(["node", "test", "memory", "inspect", "abc-123"]);
      const out = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(out).toContain("green tea");
      expect(out).toContain("learned");
    } finally {
      callTypedSpy.mockRestore();
      withClientSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe("memory stats error handling", () => {
  it("handles daemon not running gracefully", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync(["node", "test", "memory", "stats"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("Failed to fetch memory stats");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ============================================================================
// Export + import subcommand unit tests
// ============================================================================

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
  callTyped: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

import { withClient, callTyped } from "../client/rpc-client.js";
import * as fsPromises from "node:fs/promises";
import {
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
  MemoryPinContract,
  MemoryUnpinContract,
  type MemoryExportEnvelope,
} from "@comis/core";

const mockWithClient = vi.mocked(withClient);
const mockCallTyped = vi.mocked(callTyped);
const mockWriteFile = vi.mocked(fsPromises.writeFile);
const mockReadFile = vi.mocked(fsPromises.readFile);

const FAKE_ENVELOPE: MemoryExportEnvelope = {
  schemaVersion: "comis-memory-export-v1",
  exportedAt: 1748000000000,
  scope: { tenantId: "test", agentId: "test-agent" },
  entryCount: 1,
  entries: [
    {
      id: "entry-1",
      content: "Hello from test",
      trust_level: "learned",
      memory_type: "semantic",
      tags: ["test"],
      source_who: "test-user",
      source_channel: null,
      source_session_key: null,
      created_at: 1748000000000,
      occurred_at: null,
      proof_count: null,
      source_ids: null,
      confidence: null,
      observation_kind: null,
      pattern_type: null,
    },
  ],
};

describe("memory export subcommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithClient.mockImplementation(async (fn) => fn({ call: vi.fn(), close: vi.fn(), onNotification: vi.fn() }));
    mockCallTyped.mockResolvedValue(FAKE_ENVELOPE);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("registers the export subcommand under memory", () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const exportCmd = memoryCmd!.commands.find((c) => c.name() === "export");
    expect(exportCmd).toBeDefined();
    expect(exportCmd!.description()).toContain("Export");
  });

  it("calls callTyped with MemoryPortabilityExportContract and agent_id option", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node", "test", "memory", "export", "--agent", "test-agent",
      ]);
    } catch {
      // may throw from withClient/callTyped not being real
    } finally {
      consoleSpy.mockRestore();
    }

    expect(mockCallTyped).toHaveBeenCalledWith(
      expect.anything(),
      MemoryPortabilityExportContract,
      expect.objectContaining({ agent_id: "test-agent" }),
    );
  });

  it("writes the returned envelope to a file with mode 0o600 when --output is specified", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node", "test", "memory", "export", "--agent", "test-agent", "--output", "/tmp/test-export.json",
      ]);
    } catch {
      // spinner/process.exit noise
    } finally {
      consoleSpy.mockRestore();
    }

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/test-export.json",
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});

describe("memory import subcommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithClient.mockImplementation(async (fn) => fn({ call: vi.fn(), close: vi.fn(), onNotification: vi.fn() }));
    mockCallTyped.mockResolvedValue({
      imported: 1,
      blocked: 0,
      downgraded: 0,
      total: 1,
      dryRun: false,
    });
    mockReadFile.mockResolvedValue(JSON.stringify(FAKE_ENVELOPE));
  });

  it("registers the import subcommand under memory", () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const importCmd = memoryCmd!.commands.find((c) => c.name() === "import");
    expect(importCmd).toBeDefined();
    expect(importCmd!.description()).toContain("Import");
  });

  it("exits with error when envelope schemaVersion is invalid without calling callTyped", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ schemaVersion: "bad-version", entries: [] }));

    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync([
        "node", "test", "memory", "import", "bad-file.json", "--agent", "test-agent",
      ]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toContain("comis-memory-export-v1");
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(mockCallTyped).not.toHaveBeenCalled();
  });

  it("calls callTyped with MemoryPortabilityImportContract when envelope is valid", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node", "test", "memory", "import", "file.json", "--agent", "test-agent",
      ]);
    } catch {
      // ignore output noise
    } finally {
      consoleSpy.mockRestore();
    }

    expect(mockCallTyped).toHaveBeenCalledWith(
      expect.anything(),
      MemoryPortabilityImportContract,
      expect.objectContaining({ agent_id: "test-agent", entries: FAKE_ENVELOPE.entries }),
    );
  });

  it("passes dry_run true to callTyped when --dry-run flag is set", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node", "test", "memory", "import", "file.json", "--agent", "test-agent", "--dry-run",
      ]);
    } catch {
      // ignore output noise
    } finally {
      consoleSpy.mockRestore();
    }

    expect(mockCallTyped).toHaveBeenCalledWith(
      expect.anything(),
      MemoryPortabilityImportContract,
      expect.objectContaining({ dry_run: true }),
    );
  });
});

// ============================================================================
// WR-02: export --limit NaN guard
// RED: passing --limit abc calls callTyped with NaN (no guard before RPC)
// GREEN: CLI exits with clear error message before invoking callTyped
// ============================================================================

describe("memory export --limit NaN guard (WR-02)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithClient.mockImplementation(async (fn) => fn({ call: vi.fn(), close: vi.fn(), onNotification: vi.fn() }));
    mockCallTyped.mockResolvedValue(FAKE_ENVELOPE);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("exits with a clear error message when --limit is non-numeric, before calling callTyped", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await program.parseAsync([
        "node", "test", "memory", "export", "--agent", "test-agent", "--limit", "abc",
      ]);
    } catch (e) {
      // RED: no guard → callTyped called with NaN; process.exit never triggered.
      // GREEN: process.exit called with error message before callTyped.
      expect((e as Error).message).toBe("process.exit called");
      const errOutput = consoleErrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(errOutput).toMatch(/[Ii]nvalid.*limit|limit.*invalid|positive integer/i);
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(mockCallTyped).not.toHaveBeenCalled();
  });
});

// ============================================================================
// memory pin + unpin subcommand behavioral tests (W4)
// ============================================================================

describe("memory pin subcommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithClient.mockImplementation(async (fn) => fn({ call: vi.fn(), close: vi.fn(), onNotification: vi.fn() }));
    mockCallTyped.mockResolvedValue({ pinned: true, id: "mem-test-001" });
  });

  it("memory pin subcommand calls MemoryPinContract via callTyped", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node", "test", "memory", "pin", "mem-test-001",
      ]);
    } catch {
      // ignore spinner/output noise
    } finally {
      consoleSpy.mockRestore();
    }

    expect(mockCallTyped).toHaveBeenCalledWith(
      expect.anything(),
      MemoryPinContract,
      expect.objectContaining({ id: "mem-test-001" }),
    );
  });

  it("memory pin subcommand registers with --agent and --tenant options", () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const pinCmd = memoryCmd!.commands.find((c) => c.name() === "pin");
    expect(pinCmd).toBeDefined();
    expect(pinCmd!.options.find((o) => o.long === "--agent")).toBeDefined();
    expect(pinCmd!.options.find((o) => o.long === "--tenant")).toBeDefined();
  });
});

describe("memory unpin subcommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithClient.mockImplementation(async (fn) => fn({ call: vi.fn(), close: vi.fn(), onNotification: vi.fn() }));
    mockCallTyped.mockResolvedValue({ unpinned: true, id: "mem-test-002" });
  });

  it("memory unpin subcommand calls MemoryUnpinContract via callTyped", async () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "node", "test", "memory", "unpin", "mem-test-002",
      ]);
    } catch {
      // ignore spinner/output noise
    } finally {
      consoleSpy.mockRestore();
    }

    expect(mockCallTyped).toHaveBeenCalledWith(
      expect.anything(),
      MemoryUnpinContract,
      expect.objectContaining({ id: "mem-test-002" }),
    );
  });

  it("memory unpin subcommand registers with --agent and --tenant options", () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
    const memoryCmd = program.commands.find((c) => c.name() === "memory");
    const unpinCmd = memoryCmd!.commands.find((c) => c.name() === "unpin");
    expect(unpinCmd).toBeDefined();
    expect(unpinCmd!.options.find((o) => o.long === "--agent")).toBeDefined();
    expect(unpinCmd!.options.find((o) => o.long === "--tenant")).toBeDefined();
  });
});
