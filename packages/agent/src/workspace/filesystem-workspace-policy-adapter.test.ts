// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEMPLATES } from "@comis/core";
import { createFilesystemWorkspacePolicyAdapter } from "./filesystem-workspace-policy-adapter.js";

const dirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comis-workspace-policy-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createFilesystemWorkspacePolicyAdapter", () => {
  it("omits untouched starter templates from the operator policy snapshot", async () => {
    const dir = await makeWorkspace();
    await Promise.all(Object.entries(DEFAULT_TEMPLATES).map(([name, content]) => (
      writeFile(join(dir, name), content, "utf-8")
    )));
    const adapter = createFilesystemWorkspacePolicyAdapter({
      resolveWorkspaceDir: (agentId) => agentId === "agent_a" ? dir : undefined,
    });

    const result = await adapter.load("agent_a");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sections).toEqual([]);
      expect(result.value.combinedHash).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("classifies operator edits as trusted and BOOTSTRAP.md as untrusted agent state", async () => {
    const dir = await makeWorkspace();
    await writeFile(join(dir, "ROLE.md"), "# Role\n\nHandle only configured operations.\n", "utf-8");
    await writeFile(join(dir, "BOOTSTRAP.md"), "- [ ] Collect missing setup state\n", "utf-8");
    const adapter = createFilesystemWorkspacePolicyAdapter({ resolveWorkspaceDir: () => dir });

    const result = await adapter.load("agent_a");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sections).toEqual([
        expect.objectContaining({
          id: "workspace:role",
          sourceKind: "operator",
          trust: "trusted",
          stability: "stable",
        }),
        expect.objectContaining({
          id: "workspace:bootstrap",
          sourceKind: "agent_state",
          trust: "untrusted",
          stability: "turn",
        }),
      ]);
    }
  });

  it("returns byte-stable hashes and snapshots workspace content only once per load", async () => {
    const dir = await makeWorkspace();
    const rolePath = join(dir, "ROLE.md");
    await writeFile(rolePath, "# Role\n\nFirst policy.\n", "utf-8");
    const adapter = createFilesystemWorkspacePolicyAdapter({ resolveWorkspaceDir: () => dir });

    const first = await adapter.load("agent_a");
    const same = await adapter.load("agent_a");
    await writeFile(rolePath, "# Role\n\nSecond policy.\n", "utf-8");
    const nextTurn = await adapter.load("agent_a");

    expect(first.ok && same.ok && nextTurn.ok).toBe(true);
    if (first.ok && same.ok && nextTurn.ok) {
      expect(same.value).toEqual(first.value);
      expect(nextTurn.value.combinedHash).not.toBe(first.value.combinedHash);
      expect(first.value.sections[0]?.content).toContain("First policy");
      expect(nextTurn.value.sections[0]?.content).toContain("Second policy");
      expect(adapter.get(first.value.combinedHash)).toEqual(first);
      expect(adapter.get(nextTurn.value.combinedHash)).toEqual(nextTurn);
    }
  });

  it("returns a typed error for a policy hash that was not loaded this process", () => {
    const adapter = createFilesystemWorkspacePolicyAdapter({ resolveWorkspaceDir: () => undefined });
    expect(adapter.get("a".repeat(64))).toEqual({
      ok: false,
      error: { kind: "snapshot_not_found", policyHash: "a".repeat(64) },
    });
  });

  it("returns a typed error when the agent workspace is not registered", async () => {
    const adapter = createFilesystemWorkspacePolicyAdapter({ resolveWorkspaceDir: () => undefined });
    const result = await adapter.load("missing_agent");
    expect(result).toEqual({ ok: false, error: { kind: "agent_not_found", agentId: "missing_agent" } });
  });
});
