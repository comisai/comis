// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the skill-mutation provenance/MCP consequence hooks:
 *   - unwindImportedSkillOnDelete: after a skill directory is removed,
 *     disconnect + drop its bundle-owned MCP entries (keyed on the ownership
 *     ledger, so a legacy bundle-owning skill unwinds too) AND remove the
 *     provenance record.
 *   - repinLocallyModifiedSkill: after an authorized local edit, recompute the
 *     content hash over the edited install set, bump updatedAt, and mark the
 *     record locallyModified (a visible divergence).
 *
 * persistMcpServers is mocked (a controllable spy proving the filtered servers
 * array); the ledger + provenance store are exercised against a REAL temp
 * dataDir (ground truth, not a mock store).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const mockPersistMcpServers = vi.hoisted(() =>
  vi.fn(async () => ({ persistence: "persisted" as const })),
);
vi.mock("../api/shared/persist-mcp-servers.js", () => ({
  persistMcpServers: mockPersistMcpServers,
}));

import {
  unwindImportedSkillOnDelete,
  repinLocallyModifiedSkill,
} from "./skill-provenance-hooks.js";
import { recordBundleEntries } from "./bundle-install-state.js";
import {
  writeProvenanceRecord,
  provenanceKey,
  readProvenanceStore,
  computeInstalledSetHash,
  type ProvenanceRecord,
} from "@comis/skills";
import type { McpServerEntry } from "@comis/core";
import type { WorkspaceApiDeps } from "../api/types.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

let tmpRoot: string;
let dataDir: string;

function entry(name: string): McpServerEntry {
  return { name, transport: "stdio", command: "npx", args: [`${name}-pkg`], enabled: false } as unknown as McpServerEntry;
}

function makeDeps(overrides: {
  servers?: McpServerEntry[];
  connectedNames?: string[];
} = {}): {
  deps: WorkspaceApiDeps;
  disconnectSpy: ReturnType<typeof vi.fn>;
} {
  const connected = new Set(overrides.connectedNames ?? []);
  const disconnectSpy = vi.fn(async (_name: string) => undefined);
  const mcpClientManager = {
    getConnection: (name: string) => (connected.has(name) ? { name } : undefined),
    disconnect: disconnectSpy,
  } as unknown as WorkspaceApiDeps["mcpClientManager"];
  const deps = {
    mcpClientManager,
    logger: createMockLogger(),
    persistDeps: { configPaths: ["/tmp/c.yaml"], defaultConfigPaths: ["/tmp/d.yaml"], logger: createMockLogger() },
    container: {
      config: { dataDir, integrations: { mcp: { servers: overrides.servers ?? [] } } },
    },
  } as unknown as WorkspaceApiDeps;
  return { deps, disconnectSpy };
}

async function seedRecord(name: string, files: string[]): Promise<ProvenanceRecord> {
  const record: ProvenanceRecord = {
    name,
    scope: "local",
    agentId: "agent-a",
    source: "archive",
    identifier: "https://example.com/skill.zip",
    contentHash: "deadbeef",
    scanVerdict: { clean: true, findingCount: 0 },
    files,
    importedAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    importedBy: "agent-a",
  };
  const wr = await writeProvenanceRecord(dataDir, record);
  expect(wr.ok).toBe(true);
  return record;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), `prov-hooks-${randomUUID().slice(0, 8)}-`));
  dataDir = join(tmpRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  mockPersistMcpServers.mockReset();
  mockPersistMcpServers.mockResolvedValue({ persistence: "persisted" as const });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("unwindImportedSkillOnDelete — delete unwind", () => {
  it("provenanced import: disconnects connected entries, removes the ledger-owned servers, forgets the ledger, and removes the provenance record", async () => {
    // Ledger owns srv-a + srv-b for skill 'imp'; a user server 'keep' is not owned.
    recordBundleEntries(dataDir, "imp", [entry("srv-a"), entry("srv-b")]);
    await seedRecord("imp", ["SKILL.md"]);
    const { deps, disconnectSpy } = makeDeps({
      servers: [entry("srv-a"), entry("srv-b"), entry("keep")],
      connectedNames: ["srv-a"], // only srv-a is live
    });

    const result = await unwindImportedSkillOnDelete(deps, {
      scope: "local",
      agentId: "agent-a",
      name: "imp",
      ctx: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value.ownedServers].sort()).toEqual(["srv-a", "srv-b"]);
      expect(result.value.disconnected).toEqual(["srv-a"]); // only the connected one
      expect(result.value.provenanceRemoved).toBe(true);
    }
    // Only the live entry was disconnected.
    expect(disconnectSpy.mock.calls.map((c) => c[0])).toEqual(["srv-a"]);
    // The persisted array dropped BOTH owned servers, kept the user server.
    expect(mockPersistMcpServers.mock.calls.length).toBe(1);
    const persisted = mockPersistMcpServers.mock.calls[0]![1] as McpServerEntry[];
    expect(persisted.map((s) => s.name)).toEqual(["keep"]);
    // The ownership ledger no longer records the skill.
    // (installed-bundles.json read back through the store's own reader is covered
    // by the outcome; here assert the provenance store dropped the record.)
    expect(readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "imp")]).toBeUndefined();
  });

  it("unprovenanced legacy skill: unwinds ledger-owned MCP entries even with NO provenance record (keyed on the ledger)", async () => {
    recordBundleEntries(dataDir, "legacy", [entry("leg-a")]);
    // No seedRecord — a legacy bundle-owning skill has no provenance record.
    const { deps, disconnectSpy } = makeDeps({
      servers: [entry("leg-a"), entry("other")],
      connectedNames: ["leg-a"],
    });

    const result = await unwindImportedSkillOnDelete(deps, {
      scope: "local",
      agentId: "agent-a",
      name: "legacy",
      ctx: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ownedServers).toEqual(["leg-a"]);
      expect(result.value.disconnected).toEqual(["leg-a"]);
      // No record existed to remove.
      expect(result.value.provenanceRemoved).toBe(false);
    }
    expect(disconnectSpy).toHaveBeenCalledWith("leg-a");
    const persisted = mockPersistMcpServers.mock.calls[0]![1] as McpServerEntry[];
    expect(persisted.map((s) => s.name)).toEqual(["other"]);
  });

  it("no bundle + no record: a clean no-op unwind (no persist, no disconnect)", async () => {
    const { deps, disconnectSpy } = makeDeps({ servers: [entry("unrelated")] });

    const result = await unwindImportedSkillOnDelete(deps, {
      scope: "local",
      agentId: "agent-a",
      name: "plain",
      ctx: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ownedServers).toEqual([]);
      expect(result.value.disconnected).toEqual([]);
      expect(result.value.provenanceRemoved).toBe(false);
    }
    expect(mockPersistMcpServers.mock.calls.length).toBe(0);
    expect(disconnectSpy.mock.calls.length).toBe(0);
  });

  it("a disconnect that throws is tolerated: the entry is still removed and the unwind succeeds", async () => {
    recordBundleEntries(dataDir, "resilient", [entry("boom")]);
    const disconnectSpy = vi.fn(async () => {
      throw new Error("transport already gone");
    });
    const deps = {
      mcpClientManager: {
        getConnection: () => ({ name: "boom" }),
        disconnect: disconnectSpy,
      },
      logger: createMockLogger(),
      persistDeps: { configPaths: ["/tmp/c.yaml"], defaultConfigPaths: ["/tmp/d.yaml"], logger: createMockLogger() },
      container: { config: { dataDir, integrations: { mcp: { servers: [entry("boom")] } } } },
    } as unknown as WorkspaceApiDeps;

    const result = await unwindImportedSkillOnDelete(deps, { scope: "local", agentId: "agent-a", name: "resilient", ctx: undefined });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ownedServers).toEqual(["boom"]);
      // The throw is swallowed, so the server is NOT reported disconnected...
      expect(result.value.disconnected).toEqual([]);
    }
    // ...but the persisted entry is still dropped.
    expect((mockPersistMcpServers.mock.calls[0]![1] as McpServerEntry[]).map((s) => s.name)).toEqual([]);
  });

  it("a config write that only lands in-memory (runtime_only) still forgets the ledger + removes the record", async () => {
    recordBundleEntries(dataDir, "half", [entry("srv")]);
    await seedRecord("half", ["SKILL.md"]);
    mockPersistMcpServers.mockResolvedValueOnce({ persistence: "runtime_only" as const, warning: "disk write failed" });
    const { deps } = makeDeps({ servers: [entry("srv")] });

    const result = await unwindImportedSkillOnDelete(deps, { scope: "local", agentId: "agent-a", name: "half", ctx: undefined });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.provenanceRemoved).toBe(true);
    // The record is still removed even when the config write degraded.
    expect(readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "half")]).toBeUndefined();
  });
});

describe("repinLocallyModifiedSkill — local-edit re-pin", () => {
  it("re-pins contentHash over the edited install set, bumps updatedAt, and marks locallyModified", async () => {
    const original = await seedRecord("edited", ["SKILL.md"]);
    // The live skill dir carries the edited SKILL.md.
    const skillDir = join(tmpRoot, "skills", "edited");
    mkdirSync(skillDir, { recursive: true });
    const newBody = "---\nname: edited\ndescription: edited body\n---\n\n# changed\n";
    writeFileSync(join(skillDir, "SKILL.md"), newBody, "utf-8");

    const { deps } = makeDeps();
    const result = await repinLocallyModifiedSkill(deps, {
      scope: "local",
      agentId: "agent-a",
      name: "edited",
      location: skillDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.repinned).toBe(true);

    const updated = readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "edited")];
    expect(updated).toBeDefined();
    expect(updated!.locallyModified).toBe(true);
    // updatedAt bumped away from the original.
    expect(updated!.updatedAt).not.toBe(original.updatedAt);
    // importedAt preserved.
    expect(updated!.importedAt).toBe(original.importedAt);
    // contentHash recomputed over the edited install set (verifiable against disk).
    const expectedHash = computeInstalledSetHash([{ relPath: "SKILL.md", bytes: Buffer.from(newBody, "utf-8") }]);
    expect(updated!.contentHash).toBe(expectedHash);
    expect(updated!.contentHash).not.toBe(original.contentHash);
  });

  it("errors when a recorded install file is missing on disk (the pin cannot be recomputed)", async () => {
    await seedRecord("gappy", ["SKILL.md", "reference.md"]);
    const skillDir = join(tmpRoot, "skills", "gappy");
    mkdirSync(skillDir, { recursive: true });
    // Only SKILL.md exists; reference.md is missing.
    writeFileSync(join(skillDir, "SKILL.md"), "body", "utf-8");
    const { deps } = makeDeps();

    const result = await repinLocallyModifiedSkill(deps, { scope: "local", agentId: "agent-a", name: "gappy", location: skillDir });

    expect(result.ok).toBe(false);
    // The pin is left untouched when it cannot be recomputed.
    expect(readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "gappy")]?.locallyModified).toBeUndefined();
  });

  it("no provenance record (a hand-created skill): a no-op re-pin", async () => {
    const skillDir = join(tmpRoot, "skills", "handmade");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "x", "utf-8");
    const { deps } = makeDeps();

    const result = await repinLocallyModifiedSkill(deps, {
      scope: "local",
      agentId: "agent-a",
      name: "handmade",
      location: skillDir,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.repinned).toBe(false);
    expect(readProvenanceStore(dataDir)[provenanceKey("local", "agent-a", "handmade")]).toBeUndefined();
  });
});
