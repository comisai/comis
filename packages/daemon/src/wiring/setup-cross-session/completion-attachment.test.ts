// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { safePath } from "@comis/core";
import { ok } from "@comis/shared";
import {
  createCompletionAttachmentPreparer,
  prepareCompletionAttachment,
  reconcileCompletionAttachmentSnapshots,
  verifyCompletionAttachmentSnapshot,
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

  it("syncs the snapshot directory and its parent before admitting the file", async () => {
    const { dataDir, workspaceDir } = await makeLayout();
    const sourcePath = safePath(workspaceDir, "durable.txt");
    await writeFile(sourcePath, "durable", { mode: 0o600 });
    const syncDirectory = vi.fn(async () => ok(undefined));

    const result = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath,
      syncDirectory,
    });

    expect(result.ok).toBe(true);
    expect(syncDirectory.mock.calls.map(([path]) => path)).toEqual([
      safePath(dataDir, "completion-attachments"),
      dataDir,
    ]);
    if (result.ok) await result.value.cleanup();
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

    const result = await prepare({
      kind: "source",
      sourceAgentId: "report-agent",
      path: sourcePath,
    });

    expect(result.ok).toBe(true);
    if (result.ok) await result.value.cleanup();
  });

  it("keeps admitted bytes stable and rejects a changed snapshot", async () => {
    const { dataDir, workspaceDir } = await makeLayout();
    const sourcePath = safePath(workspaceDir, "report.txt");
    await writeFile(sourcePath, "admitted", { mode: 0o600 });
    const prepared = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath,
      sourceAgentId: "worker-a",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await writeFile(sourcePath, "replaced", { mode: 0o600 });
    await expect(readFile(prepared.value.path, "utf8")).resolves.toBe("admitted");
    await expect(verifyCompletionAttachmentSnapshot(dataDir, prepared.value))
      .resolves.toEqual(ok(prepared.value));

    await chmod(prepared.value.path, 0o600);
    await writeFile(prepared.value.path, "tampered", { mode: 0o600 });
    const verified = await verifyCompletionAttachmentSnapshot(dataDir, prepared.value);
    expect(verified.ok).toBe(false);
    await prepared.value.cleanup();
  });

  it("removes crash-orphaned snapshots while preserving every durable reference", async () => {
    const { dataDir, workspaceDir } = await makeLayout();
    const firstSource = safePath(workspaceDir, "referenced.txt");
    const secondSource = safePath(workspaceDir, "orphaned.txt");
    await writeFile(firstSource, "referenced", { mode: 0o600 });
    await writeFile(secondSource, "orphaned", { mode: 0o600 });
    const referenced = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath: firstSource,
    });
    const orphaned = await prepareCompletionAttachment({
      dataDir,
      workspaceDir,
      sourcePath: secondSource,
    });
    expect(referenced.ok && orphaned.ok).toBe(true);
    if (!referenced.ok || !orphaned.ok) return;

    await expect(reconcileCompletionAttachmentSnapshots(
      dataDir,
      [referenced.value.path],
    )).resolves.toEqual(ok(undefined));

    await expect(readFile(referenced.value.path, "utf8")).resolves.toBe("referenced");
    await expect(access(orphaned.value.path)).rejects.toThrow();
    await referenced.value.cleanup();
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
