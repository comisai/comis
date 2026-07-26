// SPDX-License-Identifier: Apache-2.0
/** Skills CLI registration and typed request routing. */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (client: object) => Promise<unknown>) => fn({})),
  callTyped: vi.fn(),
}));
vi.mock("./mcp-token.js", () => ({ ensureGatewayToken: vi.fn() }));
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_label: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../output/table.js", () => ({
  renderTable: vi.fn(),
  renderKeyValue: vi.fn(),
}));
vi.mock("../output/format.js", () => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  json: vi.fn(),
}));

const { registerSkillsCommand } = await import("./skills.js");
const { callTyped } = await import("../client/rpc-client.js");
const { renderTable, renderKeyValue } = await import("../output/table.js");

function program(): Command {
  const command = new Command();
  command.exitOverride();
  registerSkillsCommand(command);
  return command;
}

const listedSkill = {
  name: "summarize",
  description: "Summarizes documents",
  location: "/workspace/skills/summarize",
  discoverySource: "bundled",
  scope: "local",
  source: "registry",
  ref: "registry:summarize@1.2.3",
  contentHash: `sha256:${"a".repeat(64)}`,
  importedAt: "2026-07-26T12:00:00.000Z",
  importedBy: { agentId: "default" },
  trust: "community",
  verdict: "safe",
  findingCounts: { critical: 0, warn: 0 },
  evidence: { publisherHandle: "publisher_a", securityPassed: true },
};

describe("registerSkillsCommand", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skills-cli-"));
    vi.mocked(callTyped).mockReset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers list import remove and info subcommands", () => {
    const root = program();
    const skills = root.commands.find((candidate) => candidate.name() === "skills");

    expect(skills?.commands.map((candidate) => candidate.name())).toEqual([
      "list",
      "import",
      "remove",
      "info",
    ]);
  });

  it("lists provenance columns with a bounded content hash prefix", async () => {
    vi.mocked(callTyped).mockResolvedValue({ skills: [listedSkill] } as never);

    await program().parseAsync(["node", "comis", "skills", "list"]);

    expect(renderTable).toHaveBeenCalledWith(
      ["Name", "Scope", "Source", "Trust", "Verdict", "Hash"],
      [["summarize", "local", "registry", "community", "safe", "aaaaaaaaaaaa"]],
    );
  });

  it("routes a confirmed registry import through the typed import contract", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      ok: true,
      path: "/workspace/skills/summarize",
      name: "summarize",
      fileCount: 1,
    } as never);

    await program().parseAsync([
      "node",
      "comis",
      "skills",
      "import",
      "summarize@1.2.3",
      "--source",
      "registry",
      "--registry",
      "community-a",
      "--confirm",
    ]);

    expect(callTyped).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "skills.import" }),
      {
        source: "registry",
        registry: "community-a",
        ref: "summarize@1.2.3",
        scope: "local",
        force: true,
      },
    );
  });

  it("maps the explicit force flag to the typed import contract", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      ok: true,
      path: "/workspace/skills/summarize",
      name: "summarize",
      fileCount: 1,
      unchanged: false,
      trust: "community",
      verdict: "safe",
      contentHash: `sha256:${"a".repeat(64)}`,
      warnings: [],
    } as never);

    await program().parseAsync([
      "node",
      "comis",
      "skills",
      "import",
      "https://github.com/example/skills/tree/main/summarize",
      "--force",
    ]);

    expect(callTyped).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "skills.import" }),
      expect.objectContaining({ force: true }),
    );
  });

  it("renders the default import result as a table-style key-value view", async () => {
    vi.mocked(callTyped).mockResolvedValue({
      ok: true,
      path: "/workspace/skills/summarize",
      name: "summarize",
      fileCount: 1,
      unchanged: false,
      trust: "community",
      verdict: "safe",
      contentHash: `sha256:${"a".repeat(64)}`,
      warnings: [],
    } as never);

    await program().parseAsync([
      "node",
      "comis",
      "skills",
      "import",
      "https://github.com/example/skills/tree/main/summarize",
    ]);

    expect(renderKeyValue).toHaveBeenCalledWith(
      expect.arrayContaining([
        ["Status", "Imported"],
        ["Name", "summarize"],
        ["Trust", "community"],
        ["Verdict", "safe"],
      ]),
    );
  });

  it("reads a local skill archive and sends canonical base64 bytes", async () => {
    const archivePath = join(tempDir, "summarize.skill");
    writeFileSync(archivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    vi.mocked(callTyped).mockResolvedValue({
      ok: true,
      path: "/workspace/skills/summarize",
      name: "summarize",
      fileCount: 1,
    } as never);

    await program().parseAsync(["node", "comis", "skills", "import", archivePath]);

    expect(callTyped).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "skills.import" }),
      expect.objectContaining({
        source: "archive",
        archiveBase64: "UEsDBA==",
        scope: "local",
      }),
    );
  });

  it("renders installed provenance for one named skill", async () => {
    vi.mocked(callTyped).mockResolvedValue({ skills: [listedSkill] } as never);

    await program().parseAsync(["node", "comis", "skills", "info", "summarize"]);

    expect(renderKeyValue).toHaveBeenCalledWith(
      expect.arrayContaining([
        ["Name", "summarize"],
        ["Source", "registry"],
        ["Trust", "community"],
        ["Publisher", "publisher_a"],
        ["Content Hash", `sha256:${"a".repeat(64)}`],
      ]),
    );
  });

  it("maps remove to the typed skills delete contract", async () => {
    vi.mocked(callTyped).mockResolvedValue({ ok: true, deleted: "summarize" } as never);

    await program().parseAsync(["node", "comis", "skills", "remove", "summarize"]);

    expect(callTyped).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "skills.delete" }),
      { name: "summarize", scope: "local" },
    );
  });
});
