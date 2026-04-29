// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs/promises before any imports trigger module load.
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
}));

// Mock @comis/core: preserve all real exports, override safePath so we can
// drive PathTraversalError from a test override.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: vi.fn((base: string, ...segments: string[]) => `${base}/${segments.join("/")}`),
  };
});

import { writeFile } from "node:fs/promises";
import { safePath, PathTraversalError } from "@comis/core";
import {
  writeInlineWorkspaceFiles,
  type AgentInlineWorkspaceDeps,
} from "./agent-inline-workspace.js";
import type { ComisLogger } from "@comis/infra";

const mockWriteFile = vi.mocked(writeFile);
const mockSafePath = vi.mocked(safePath);

function makeMockLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return logger as typeof logger & ComisLogger;
}

function makeDeps(): AgentInlineWorkspaceDeps & { logger: ReturnType<typeof makeMockLogger> } {
  const logger = makeMockLogger();
  return { logger };
}

describe("writeInlineWorkspaceFiles", () => {
  beforeEach(() => {
    mockWriteFile.mockReset();
    mockWriteFile.mockResolvedValue(undefined);
    mockSafePath.mockReset();
    mockSafePath.mockImplementation((base: string, ...segments: string[]) =>
      `${base}/${segments.join("/")}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 1: success — both files
  // -------------------------------------------------------------------------
  it("writes ROLE.md and IDENTITY.md when both contents provided", async () => {
    const deps = makeDeps();
    const role = "ROLE-CONTENT";
    const identity = "IDENTITY-CONTENT";

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-foo",
      agentId: "foo",
      role,
      identity,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        roleWritten: true,
        identityWritten: true,
        bytesWritten: role.length + identity.length,
      });
    }
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenNthCalledWith(
      1,
      "/tmp/workspace-foo/ROLE.md",
      role,
      { encoding: "utf8" },
    );
    expect(mockWriteFile).toHaveBeenNthCalledWith(
      2,
      "/tmp/workspace-foo/IDENTITY.md",
      identity,
      { encoding: "utf8" },
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: success — role only
  // -------------------------------------------------------------------------
  it("writes only ROLE.md when identity omitted", async () => {
    const deps = makeDeps();
    const role = "R";

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-bar",
      agentId: "bar",
      role,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        roleWritten: true,
        identityWritten: false,
        bytesWritten: role.length,
      });
    }
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/workspace-bar/ROLE.md",
      role,
      { encoding: "utf8" },
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: success — identity only
  // -------------------------------------------------------------------------
  it("writes only IDENTITY.md when role omitted", async () => {
    const deps = makeDeps();
    const identity = "I";

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-baz",
      agentId: "baz",
      identity,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        roleWritten: false,
        identityWritten: true,
        bytesWritten: identity.length,
      });
    }
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/workspace-baz/IDENTITY.md",
      identity,
      { encoding: "utf8" },
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: success — neither (no-op)
  // -------------------------------------------------------------------------
  it("returns ok with zero bytes and writes nothing when both omitted", async () => {
    const deps = makeDeps();

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-none",
      agentId: "none",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        roleWritten: false,
        identityWritten: false,
        bytesWritten: 0,
      });
    }
    expect(mockWriteFile).not.toHaveBeenCalled();
    // No INFO log when neither file written (it's a no-op).
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: oversize defense in depth
  // -------------------------------------------------------------------------
  it("returns oversize err when role exceeds 16384 chars", async () => {
    const deps = makeDeps();
    const role = "x".repeat(16385);

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-big",
      agentId: "big",
      role,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "oversize",
        file: "ROLE.md",
        limit: 16384,
        actual: 16385,
      });
    }
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns oversize err when identity exceeds 4096 chars", async () => {
    const deps = makeDeps();
    const identity = "y".repeat(4097);

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-big",
      agentId: "big",
      identity,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "oversize",
        file: "IDENTITY.md",
        limit: 4096,
        actual: 4097,
      });
    }
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: path traversal — safePath throws PathTraversalError
  // -------------------------------------------------------------------------
  it("returns path_traversal err when safePath throws PathTraversalError on ROLE.md", async () => {
    const deps = makeDeps();
    mockSafePath.mockImplementationOnce((base: string, _segment: string) => {
      throw new PathTraversalError(base, `${base}/../escape/ROLE.md`);
    });

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-evil",
      agentId: "evil",
      role: "R",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("path_traversal");
      expect(result.error.file).toBe("ROLE.md");
      expect((result.error as { kind: "path_traversal"; message: string }).message).toMatch(/Path traversal blocked/);
    }
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: fs.writeFile rejection
  // -------------------------------------------------------------------------
  it("returns io err and emits canonical WARN when writeFile rejects on ROLE.md", async () => {
    const deps = makeDeps();
    mockWriteFile.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    const result = await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-acl",
      agentId: "acl",
      role: "R",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io");
      expect(result.error.file).toBe("ROLE.md");
      expect((result.error as { kind: "io"; message: string }).message).toMatch(/EACCES/);
    }
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        module: "daemon.rpc.agent-handlers",
        agentId: "acl",
        file: "ROLE.md",
        errorKind: "resource",
        hint: expect.stringMatching(/Inline ROLE\.md\/IDENTITY\.md write failed/),
      }),
      expect.stringMatching(/Inline workspace file write failed/),
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: canonical INFO log on full success
  // -------------------------------------------------------------------------
  it("emits canonical INFO log once when at least one file written", async () => {
    const deps = makeDeps();
    const role = "ROLE-X";
    const identity = "IDENT-X";

    await writeInlineWorkspaceFiles(deps, {
      workspaceDir: "/tmp/workspace-info",
      agentId: "info-bot",
      role,
      identity,
    });

    expect(deps.logger.info).toHaveBeenCalledTimes(1);
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        module: "daemon.rpc.agent-handlers",
        agentId: "info-bot",
        roleBytes: role.length,
        identityBytes: identity.length,
        hint: expect.stringMatching(/customized inline workspace ROLE\.md\+IDENTITY\.md/),
      }),
      "Wrote inline workspace files (ROLE.md + IDENTITY.md) on agents.create",
    );
  });
});
