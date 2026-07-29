// SPDX-License-Identifier: Apache-2.0
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { safePath } from "@comis/core";
import { describe, expect, it } from "vitest";
import { removeManagedAgentWorkspace } from "./agent-workspace-cleanup.js";

describe("removeManagedAgentWorkspace", () => {
  it("removes the actual nested managed workspace layout", async () => {
    const dataDir = await mkdtemp(safePath(tmpdir(), "comis-managed-workspace-"));
    const workspaceDir = safePath(dataDir, "workspace-research");
    const sessionDir = safePath(
      safePath(safePath(workspaceDir, "sessions"), "tenant"),
      "telegram",
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(safePath(sessionDir, "conversation.jsonl"), "{}\n");

    try {
      const result = await removeManagedAgentWorkspace({
        agentId: "research",
        workspaceDir,
        dataDir,
      });

      expect(result).toEqual({
        ok: true,
        value: { disposition: "removed" },
      });
      await expect(access(workspaceDir)).rejects.toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves an operator supplied external workspace", async () => {
    const dataDir = await mkdtemp(safePath(tmpdir(), "comis-managed-root-"));
    const externalRoot = await mkdtemp(safePath(tmpdir(), "comis-external-workspace-"));
    const markerPath = safePath(externalRoot, "operator-data.txt");
    await writeFile(markerPath, "keep");

    try {
      const result = await removeManagedAgentWorkspace({
        agentId: "research",
        workspaceDir: externalRoot,
        dataDir,
      });

      expect(result).toEqual({
        ok: true,
        value: { disposition: "preserved_external" },
      });
      await expect(access(markerPath)).resolves.toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
