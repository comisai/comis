// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listSafeSessionDirectories,
  listSafeSessionFiles,
  listSessionWorkspaceTrees,
} from "./session-message-file-tree.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("listSessionWorkspaceTrees", () => {
  it("returns workspace directories and session files in deterministic lexical order", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-message-tree-"));
    tmpDirs.push(dataDir);
    const sessionsDir = path.join(dataDir, "workspace", "sessions");
    fs.mkdirSync(path.join(sessionsDir, "z-tenant"), { recursive: true });
    fs.mkdirSync(path.join(sessionsDir, "a-tenant"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "z.jsonl"), "");
    fs.writeFileSync(path.join(sessionsDir, "a.jsonl"), "");

    expect(listSafeSessionDirectories(sessionsDir, vi.fn()).map((entry) => entry.name))
      .toEqual(["a-tenant", "z-tenant"]);
    expect(listSafeSessionFiles(sessionsDir, vi.fn(), vi.fn()).map((entry) => entry.name))
      .toEqual(["a.jsonl", "z.jsonl"]);
  });

  it("reports encoded traversal directories and keeps the valid workspace", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-message-tree-"));
    tmpDirs.push(dataDir);
    fs.mkdirSync(path.join(dataDir, "workspace", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "%2e%2e"));
    const onUnreadable = vi.fn();

    const trees = listSessionWorkspaceTrees(dataDir, onUnreadable);

    expect(trees).toEqual([{
      agentId: "default",
      sessionsBase: path.join(dataDir, "workspace", "sessions"),
    }]);
    expect(onUnreadable).toHaveBeenCalledOnce();
  });

  it("reports symlinked workspace directories instead of following them silently", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-message-tree-"));
    tmpDirs.push(dataDir);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "session-message-target-"));
    tmpDirs.push(target);
    fs.mkdirSync(path.join(target, "sessions"), { recursive: true });
    fs.symlinkSync(target, path.join(dataDir, "workspace"), "dir");
    const onUnreadable = vi.fn();

    const trees = listSessionWorkspaceTrees(dataDir, onUnreadable);

    expect(trees).toEqual([]);
    expect(onUnreadable).toHaveBeenCalledOnce();
  });

  it("reports symlinked session files instead of omitting them from coverage", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-message-tree-"));
    tmpDirs.push(dataDir);
    const sessionsDir = path.join(dataDir, "sessions");
    fs.mkdirSync(sessionsDir);
    const target = path.join(dataDir, "target.jsonl");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, path.join(sessionsDir, "session.jsonl"));
    const onDirectoryUnreadable = vi.fn();
    const onFileUnreadable = vi.fn();

    const files = listSafeSessionFiles(
      sessionsDir,
      onDirectoryUnreadable,
      onFileUnreadable,
    );

    expect(files).toEqual([]);
    expect(onDirectoryUnreadable).not.toHaveBeenCalled();
    expect(onFileUnreadable).toHaveBeenCalledOnce();
  });
});
