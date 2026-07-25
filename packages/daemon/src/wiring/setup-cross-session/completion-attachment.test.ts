// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { safePath } from "@comis/core";
import {
  createCompletionAttachmentPreparer,
  prepareCompletionAttachment,
} from "./completion-attachment.js";

const roots: string[] = [];

async function makeLayout(): Promise<{
  root: string;
  dataDir: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(safePath(tmpdir(), "comis-completion-attachment-"));
  roots.push(root);
  const dataDir = safePath(root, "data");
  const workspaceDir = safePath(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  return { root, dataDir, workspaceDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("completion attachment preparation", () => {
  it("snapshots a bounded regular workspace file and preserves its delivery metadata", async () => {
    const { dataDir, workspaceDir } = await makeLayout();
    const reportsDir = safePath(workspaceDir, "reports");
    await mkdir(reportsDir);
    const sourcePath = safePath(reportsDir, "records.csv");
    await writeFile(sourcePath, "vehicle,distance\n1,42\n", { mode: 0o600 });

    const result = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      fileName: "records.csv",
      mimeType: "text/csv",
      sizeBytes: 22,
    });
    expect(result.value.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(result.value.path, "utf8")).resolves.toBe("vehicle,distance\n1,42\n");

    await result.value.cleanup();
    await expect(access(result.value.path)).rejects.toThrow();
  });

  it("resolves the producing agent workspace before preparing its output", async () => {
    const { dataDir } = await makeLayout();
    const workspaceDir = safePath(dataDir, "workspace-report-agent");
    await mkdir(workspaceDir);
    const sourcePath = safePath(workspaceDir, "records.csv");
    await writeFile(sourcePath, "id,status\n1,ready\n", { mode: 0o600 });
    const prepare = createCompletionAttachmentPreparer({
      dataDir,
      agents: { default: {} },
    });

    const result = await prepare({ sourceAgentId: "report-agent", path: sourcePath });

    expect(result.ok).toBe(true);
    if (result.ok) await result.value.cleanup();
  });

  it("rejects files outside the producing workspace and symbolic links", async () => {
    const { root, dataDir, workspaceDir } = await makeLayout();
    const outsidePath = safePath(root, "outside.csv");
    await writeFile(outsidePath, "private\n", { mode: 0o600 });
    const linkPath = safePath(workspaceDir, "linked.csv");
    await symlink(outsidePath, linkPath);

    const outside = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath: outsidePath,
    });
    const linked = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath: linkPath,
    });

    expect(outside.ok).toBe(false);
    expect(linked.ok).toBe(false);
  });

  it("rejects a regular file above the attachment byte limit", async () => {
    const { dataDir, workspaceDir } = await makeLayout();
    const sourcePath = safePath(workspaceDir, "large.csv");
    await writeFile(sourcePath, "12345", { mode: 0o600 });

    const result = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath,
      maxBytes: 4,
    });

    expect(result.ok).toBe(false);
  });
});
