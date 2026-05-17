// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import { createWorkspaceManagerController } from "./workspace-manager-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("WorkspaceManagerController", () => {
  it("getStatus: invokes workspace.status with agentId + returns dto", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {
        dir: "/wks/alpha",
        exists: true,
        files: [{ name: "system.md", present: true }],
        hasGitRepo: true,
        isBootstrapped: true,
      };
    });
    const controller = createWorkspaceManagerController(host, rpc);
    const result = await controller.getStatus("alpha");
    expect((seen[0] as unknown[])[0]).toBe("workspace.status");
    expect((seen[0] as unknown[])[1]).toEqual({ agentId: "alpha" });
    expect(result.dir).toBe("/wks/alpha");
    expect(result.files.length).toBe(1);
  });

  it("readFile + listDir: forward agentId+path params and return content/entries", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      const method = args[0] as string;
      if (method === "workspace.readFile") return { content: "hello" };
      if (method === "workspace.listDir")
        return {
          entries: [{ name: "a.txt", type: "file" as const, sizeBytes: 12 }],
        };
      return {};
    });
    const controller = createWorkspaceManagerController(host, rpc);
    const fileResult = await controller.readFile("alpha", "system.md");
    const dirResult = await controller.listDir("alpha", "projects");
    expect((seen[0] as unknown[])[1]).toEqual({
      agentId: "alpha",
      filePath: "system.md",
    });
    expect(fileResult.content).toBe("hello");
    expect((seen[1] as unknown[])[1]).toEqual({
      agentId: "alpha",
      subdir: "projects",
    });
    expect(dirResult.entries[0]!.name).toBe("a.txt");
  });

  it("getGitStatus + getGitLog + getFileDiff: forward params for git read methods", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      const method = args[0] as string;
      if (method === "workspace.git.status")
        return { branch: "main", clean: true, entries: [] };
      if (method === "workspace.git.log") return { commits: [] };
      if (method === "workspace.git.diff") return { diff: "@@ -1 +1 @@" };
      return {};
    });
    const controller = createWorkspaceManagerController(host, rpc);
    await controller.getGitStatus("alpha");
    await controller.getGitLog("alpha", 20);
    await controller.getFileDiff("alpha", "system.md");
    expect((seen[0] as unknown[])[0]).toBe("workspace.git.status");
    expect((seen[1] as unknown[])[1]).toEqual({ agentId: "alpha", limit: 20 });
    expect((seen[2] as unknown[])[1]).toEqual({
      agentId: "alpha",
      filePath: "system.md",
    });
  });

  it("writeFile + resetFile + deleteFile: invoke mutating workspace endpoints with awaited fail-closed semantics", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createWorkspaceManagerController(host, rpc);
    await controller.writeFile("alpha", "system.md", "new content");
    await controller.resetFile("alpha", "system.md");
    await controller.deleteFile("alpha", "system.md");
    expect((seen[0] as unknown[])[0]).toBe("workspace.writeFile");
    expect((seen[0] as unknown[])[1]).toEqual({
      agentId: "alpha",
      filePath: "system.md",
      content: "new content",
    });
    expect((seen[1] as unknown[])[0]).toBe("workspace.resetFile");
    expect((seen[1] as unknown[])[1]).toEqual({
      agentId: "alpha",
      fileName: "system.md",
    });
    expect((seen[2] as unknown[])[0]).toBe("workspace.deleteFile");
  });

  it("initWorkspace + restoreFile + commitChanges: invoke workspace init/git mutations", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createWorkspaceManagerController(host, rpc);
    await controller.initWorkspace("alpha");
    await controller.restoreFile("alpha", "system.md");
    await controller.commitChanges("alpha", "wip");
    expect((seen[0] as unknown[])[0]).toBe("workspace.init");
    expect((seen[1] as unknown[])[0]).toBe("workspace.git.restore");
    expect((seen[2] as unknown[])[1]).toEqual({
      agentId: "alpha",
      message: "wip",
    });
  });

  it("commitChanges with undefined message forwards undefined verbatim (no fallback)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createWorkspaceManagerController(host, rpc);
    await controller.commitChanges("alpha", undefined);
    expect((seen[0] as unknown[])[1]).toEqual({
      agentId: "alpha",
      message: undefined,
    });
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("workspace locked");
    });
    const controller = createWorkspaceManagerController(host, rpc);
    await expect(controller.getStatus("alpha")).rejects.toThrow(
      "workspace locked",
    );
    await expect(
      controller.writeFile("alpha", "f.md", "c"),
    ).rejects.toThrow("workspace locked");
    await expect(controller.commitChanges("alpha", "m")).rejects.toThrow(
      "workspace locked",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createWorkspaceManagerController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });
});
