import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorkspaceHandlers, type WorkspaceHandlerDeps } from "./workspace-handlers.js";
import type { ComisLogger } from "@comis/infra";
import type { PerAgentConfig } from "@comis/core";
import { PathTraversalError } from "@comis/core";
import { ok, err } from "@comis/shared";
import { DEFAULT_TEMPLATES, WORKSPACE_FILE_NAMES, WORKSPACE_SUBDIRS } from "@comis/agent";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
let tmpDir: string;

function makeDeps(overrides?: Partial<WorkspaceHandlerDeps>): WorkspaceHandlerDeps {
  return {
    agents: { "test-agent": {} as PerAgentConfig },
    workspaceDirs: new Map([["test-agent", tmpDir]]),
    defaultWorkspaceDir: tmpDir,
    logger: createMockLogger(),
    execGit: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), "ws-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// workspace.status
// ---------------------------------------------------------------------------

describe("workspace.status", () => {
  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(handlers["workspace.status"]!({})).rejects.toThrow(
      "Missing required parameter: agentId",
    );
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.status"]!({ agentId: "unknown" }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("returns workspace status for a valid agent", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.status"]!({
      agentId: "test-agent",
    })) as Record<string, unknown>;

    expect(result).toHaveProperty("exists");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("hasGitRepo");
  });
});

// ---------------------------------------------------------------------------
// workspace.readFile
// ---------------------------------------------------------------------------

describe("workspace.readFile", () => {
  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.readFile"]!({ filePath: "test.txt" }),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.readFile"]!({ agentId: "unknown", filePath: "test.txt" }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("rejects when filePath is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.readFile"]!({ agentId: "test-agent" }),
    ).rejects.toThrow("Missing required parameter: filePath");
  });

  it("rejects path traversal attempts", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.readFile"]!({
        agentId: "test-agent",
        filePath: "../etc/passwd",
      }),
    ).rejects.toThrow(PathTraversalError);
  });

  it("rejects absolute paths", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.readFile"]!({
        agentId: "test-agent",
        filePath: "/etc/passwd",
      }),
    ).rejects.toThrow(PathTraversalError);
  });

  it("reads file content successfully", async () => {
    await fs.writeFile(join(tmpDir, "hello.txt"), "Hello, world!", "utf-8");
    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.readFile"]!({
      agentId: "test-agent",
      filePath: "hello.txt",
    })) as { content: string; sizeBytes: number };

    expect(result.content).toBe("Hello, world!");
    expect(result.sizeBytes).toBe(Buffer.byteLength("Hello, world!", "utf-8"));
  });

  it("rejects files over 1MB", async () => {
    // Create a file just over 1MB
    const bigContent = "x".repeat(1_048_577);
    await fs.writeFile(join(tmpDir, "big.txt"), bigContent, "utf-8");
    const handlers = createWorkspaceHandlers(makeDeps());

    await expect(
      handlers["workspace.readFile"]!({
        agentId: "test-agent",
        filePath: "big.txt",
      }),
    ).rejects.toThrow("exceeds 1MB read limit");
  });
});

// ---------------------------------------------------------------------------
// workspace.writeFile
// ---------------------------------------------------------------------------

describe("workspace.writeFile", () => {
  it("rejects non-admin callers", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.writeFile"]!({
        agentId: "test-agent",
        filePath: "file.txt",
        content: "hello",
      }),
    ).rejects.toThrow("Admin access required");
  });

  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.writeFile"]!({
        _trustLevel: "admin",
        filePath: "file.txt",
        content: "hello",
      }),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.writeFile"]!({
        _trustLevel: "admin",
        agentId: "unknown",
        filePath: "file.txt",
        content: "hello",
      }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("rejects content over 512KB", async () => {
    const bigContent = "x".repeat(524_289);
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.writeFile"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
        filePath: "big.txt",
        content: bigContent,
      }),
    ).rejects.toThrow("exceeds 512KB write limit");
  });

  it("rejects path traversal", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.writeFile"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
        filePath: "../../escape",
        content: "evil",
      }),
    ).rejects.toThrow(PathTraversalError);
  });

  it("writes file successfully", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.writeFile"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      filePath: "output.txt",
      content: "test content",
    })) as { written: boolean; sizeBytes: number };

    expect(result.written).toBe(true);
    expect(result.sizeBytes).toBe(Buffer.byteLength("test content", "utf-8"));

    const written = await fs.readFile(join(tmpDir, "output.txt"), "utf-8");
    expect(written).toBe("test content");
  });

  it("creates parent directories", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await handlers["workspace.writeFile"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      filePath: "subdir/nested/file.txt",
      content: "deep write",
    });

    const written = await fs.readFile(
      join(tmpDir, "subdir", "nested", "file.txt"),
      "utf-8",
    );
    expect(written).toBe("deep write");
  });
});

// ---------------------------------------------------------------------------
// workspace.deleteFile
// ---------------------------------------------------------------------------

describe("workspace.deleteFile", () => {
  it("rejects non-admin callers", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.deleteFile"]!({
        agentId: "test-agent",
        filePath: "file.txt",
      }),
    ).rejects.toThrow("Admin access required");
  });

  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.deleteFile"]!({ _trustLevel: "admin", filePath: "file.txt" }),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.deleteFile"]!({
        _trustLevel: "admin",
        agentId: "unknown",
        filePath: "file.txt",
      }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("deletes file successfully", async () => {
    const filePath = join(tmpDir, "doomed.txt");
    await fs.writeFile(filePath, "goodbye", "utf-8");

    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.deleteFile"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      filePath: "doomed.txt",
    })) as { deleted: boolean };

    expect(result.deleted).toBe(true);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("performs best-effort memory cleanup on success", async () => {
    const filePath = join(tmpDir, "cleanup.txt");
    await fs.writeFile(filePath, "content", "utf-8");

    const mockMemoryApi = {
      search: vi.fn().mockResolvedValue([
        { entry: { id: "mem-1", content: "references cleanup.txt here" }, score: 0.9 },
        { entry: { id: "mem-2", content: "unrelated" }, score: 0.5 },
      ]),
    };
    const mockMemoryAdapter = {
      delete: vi.fn().mockResolvedValue({ ok: true }),
    };

    const handlers = createWorkspaceHandlers(
      makeDeps({
        memoryApi: mockMemoryApi as unknown as WorkspaceHandlerDeps["memoryApi"],
        memoryAdapter: mockMemoryAdapter as unknown as WorkspaceHandlerDeps["memoryAdapter"],
        tenantId: "test-tenant",
      }),
    );

    await handlers["workspace.deleteFile"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      filePath: "cleanup.txt",
    });

    expect(mockMemoryApi.search).toHaveBeenCalledWith("cleanup.txt", {
      tenantId: "test-tenant",
      agentId: "test-agent",
      limit: 50,
    });
    // Only mem-1 includes the filePath in content
    expect(mockMemoryAdapter.delete).toHaveBeenCalledTimes(1);
    expect(mockMemoryAdapter.delete).toHaveBeenCalledWith("mem-1", "test-tenant");
  });

  it("memory cleanup failure does not block delete", async () => {
    const filePath = join(tmpDir, "cleanup-fail.txt");
    await fs.writeFile(filePath, "content", "utf-8");

    const mockLogger = createMockLogger();
    const mockMemoryApi = {
      search: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    };

    const handlers = createWorkspaceHandlers(
      makeDeps({
        logger: mockLogger,
        memoryApi: mockMemoryApi as unknown as WorkspaceHandlerDeps["memoryApi"],
        memoryAdapter: {} as unknown as WorkspaceHandlerDeps["memoryAdapter"],
        tenantId: "test-tenant",
      }),
    );

    const result = (await handlers["workspace.deleteFile"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      filePath: "cleanup-fail.txt",
    })) as { deleted: boolean };

    // File is still deleted
    expect(result.deleted).toBe(true);
    await expect(fs.access(filePath)).rejects.toThrow();

    // Warning logged with errorKind
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "test-agent",
        filePath: "cleanup-fail.txt",
        errorKind: "internal",
      }),
      expect.stringContaining("memory cleanup failed"),
    );
  });
});

// ---------------------------------------------------------------------------
// workspace.listDir
// ---------------------------------------------------------------------------

describe("workspace.listDir", () => {
  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.listDir"]!({}),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.listDir"]!({ agentId: "unknown" }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("lists root directory entries", async () => {
    await fs.writeFile(join(tmpDir, "root-file.txt"), "data", "utf-8");
    await fs.mkdir(join(tmpDir, "subdir"));

    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.listDir"]!({
      agentId: "test-agent",
    })) as { entries: Array<{ name: string; type: string; sizeBytes?: number; modifiedAt: number }> };

    const fileEntry = result.entries.find((e) => e.name === "root-file.txt");
    const dirEntry = result.entries.find((e) => e.name === "subdir");

    expect(fileEntry).toBeDefined();
    expect(fileEntry!.type).toBe("file");
    expect(fileEntry!.sizeBytes).toBe(4);
    expect(dirEntry).toBeDefined();
    expect(dirEntry!.type).toBe("directory");
  });

  it("lists allowlisted subdirectory", async () => {
    const projDir = join(tmpDir, "projects");
    await fs.mkdir(projDir);
    await fs.writeFile(join(projDir, "readme.md"), "hello", "utf-8");

    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.listDir"]!({
      agentId: "test-agent",
      subdir: "projects",
    })) as { entries: Array<{ name: string; type: string }> };

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe("readme.md");
    expect(result.entries[0]!.type).toBe("file");
  });

  it("rejects non-allowlisted subdirectory", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.listDir"]!({
        agentId: "test-agent",
        subdir: "secret",
      }),
    ).rejects.toThrow("not in allowlist");
  });
});

// ---------------------------------------------------------------------------
// workspace.resetFile
// ---------------------------------------------------------------------------

describe("workspace.resetFile", () => {
  it("rejects non-admin callers", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.resetFile"]!({
        agentId: "test-agent",
        fileName: "IDENTITY.md",
      }),
    ).rejects.toThrow("Admin access required");
  });

  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.resetFile"]!({
        _trustLevel: "admin",
        fileName: "IDENTITY.md",
      }),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.resetFile"]!({
        _trustLevel: "admin",
        agentId: "unknown",
        fileName: "IDENTITY.md",
      }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("rejects non-template filenames", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.resetFile"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
        fileName: "random.txt",
      }),
    ).rejects.toThrow("Not a template file: random.txt");
  });

  it("resets a template file to default content", async () => {
    const identityPath = join(tmpDir, "IDENTITY.md");
    await fs.writeFile(identityPath, "custom content that should be overwritten", "utf-8");

    const handlers = createWorkspaceHandlers(makeDeps());
    const result = (await handlers["workspace.resetFile"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      fileName: "IDENTITY.md",
    })) as { reset: boolean; fileName: string };

    expect(result.reset).toBe(true);
    expect(result.fileName).toBe("IDENTITY.md");

    const content = await fs.readFile(identityPath, "utf-8");
    expect(content).toBe(DEFAULT_TEMPLATES["IDENTITY.md"]);
  });
});

// ---------------------------------------------------------------------------
// workspace.init
// ---------------------------------------------------------------------------

describe("workspace.init", () => {
  it("rejects non-admin callers", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.init"]!({ agentId: "test-agent" }),
    ).rejects.toThrow("Admin access required");
  });

  it("rejects when agentId is missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.init"]!({ _trustLevel: "admin" }),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.init"]!({
        _trustLevel: "admin",
        agentId: "unknown",
      }),
    ).rejects.toThrow("Agent not found: unknown");
  });

  it("initializes workspace successfully", async () => {
    // Use a fresh subdir that doesn't exist yet
    const freshDir = join(tmpDir, "fresh-workspace");
    const handlers = createWorkspaceHandlers(
      makeDeps({
        workspaceDirs: new Map([["test-agent", freshDir]]),
        defaultWorkspaceDir: freshDir,
      }),
    );

    const result = (await handlers["workspace.init"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
    })) as { initialized: boolean; dir: string };

    expect(result.initialized).toBe(true);
    expect(result.dir).toBe(freshDir);

    // Verify workspace directories were created
    for (const subdir of WORKSPACE_SUBDIRS) {
      const stat = await fs.stat(join(freshDir, subdir));
      expect(stat.isDirectory()).toBe(true);
    }

    // Verify template files were created
    for (const name of WORKSPACE_FILE_NAMES) {
      const content = await fs.readFile(join(freshDir, name), "utf-8");
      expect(content).toBe(DEFAULT_TEMPLATES[name]);
    }
  });
});

// ===========================================================================
// Git handler tests
// ===========================================================================

/** Create .git directory so assertGitRepo passes. */
async function setupGitDir(): Promise<void> {
  await fs.mkdir(join(tmpDir, ".git"));
}

// ---------------------------------------------------------------------------
// assertGitRepo / cleanStaleLock helpers
// ---------------------------------------------------------------------------

describe("assertGitRepo / cleanStaleLock helpers", () => {
  it("rejects when .git directory is absent", async () => {
    const mockExecGit = vi.fn();
    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await expect(
      handlers["workspace.git.status"]!({ agentId: "test-agent" }),
    ).rejects.toThrow("No git repository in workspace");
  });

  it("cleans stale .git/index.lock older than 30s", async () => {
    await setupGitDir();
    const lockPath = join(tmpDir, ".git", "index.lock");
    await fs.writeFile(lockPath, "lock", "utf-8");
    // Set mtime to 60 seconds ago
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);

    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("main\n")) // branch
      .mockResolvedValueOnce(ok("")); // status

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.status"]!({ agentId: "test-agent" });

    // Lock file should be removed
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("leaves fresh .git/index.lock alone", async () => {
    await setupGitDir();
    const lockPath = join(tmpDir, ".git", "index.lock");
    await fs.writeFile(lockPath, "lock", "utf-8");
    // Fresh mtime (now)

    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("main\n")) // branch
      .mockResolvedValueOnce(ok("")); // status

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.status"]!({ agentId: "test-agent" });

    // Lock file should still exist
    const stat = await fs.stat(lockPath);
    expect(stat.isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// workspace.git.status
// ---------------------------------------------------------------------------

describe("workspace.git.status", () => {
  it("returns branch, clean flag, and entries for modified files", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("main\n")) // branch
      .mockResolvedValueOnce(ok(" M file.txt\n?? new.txt\n")); // status

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.status"]!({
      agentId: "test-agent",
    })) as { branch: string; clean: boolean; entries: Array<{ path: string; status: string; staged: boolean }> };

    expect(result.branch).toBe("main");
    expect(result.clean).toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({ path: "file.txt", status: "modified", staged: false });
    expect(result.entries[1]).toEqual({ path: "new.txt", status: "untracked", staged: false });
  });

  it("returns clean=true when no changes", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("main\n")) // branch
      .mockResolvedValueOnce(ok("")); // status (empty)

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.status"]!({
      agentId: "test-agent",
    })) as { branch: string; clean: boolean; entries: unknown[] };

    expect(result.clean).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("returns detached HEAD fallback", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("\n")) // empty branch
      .mockResolvedValueOnce(ok("")); // status

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.status"]!({
      agentId: "test-agent",
    })) as { branch: string };

    expect(result.branch).toBe("HEAD (detached)");
  });

  it("rejects when agentId missing", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.status"]!({}),
    ).rejects.toThrow("Missing required parameter: agentId");
  });

  it("rejects when agent not found", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.status"]!({ agentId: "unknown" }),
    ).rejects.toThrow("Agent not found: unknown");
  });
});

// ---------------------------------------------------------------------------
// workspace.git.log
// ---------------------------------------------------------------------------

describe("workspace.git.log", () => {
  it("returns parsed commit history", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("abc123\nAlice\n2026-03-20T10:00:00Z\nInitial commit\n"));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.log"]!({
      agentId: "test-agent",
    })) as { commits: Array<{ sha: string; author: string; date: string; message: string }> };

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]).toEqual({
      sha: "abc123",
      author: "Alice",
      date: "2026-03-20T10:00:00Z",
      message: "Initial commit",
    });
  });

  it("returns empty commits for fresh repo", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(err("fatal: your current branch 'main' does not have any commits yet"));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.log"]!({
      agentId: "test-agent",
    })) as { commits: unknown[] };

    expect(result.commits).toEqual([]);
  });

  it("clamps limit to range [1, 200]", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("")) // limit 999
      .mockResolvedValueOnce(ok("")); // limit -5

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));

    await handlers["workspace.git.log"]!({ agentId: "test-agent", limit: 999 });
    expect(mockExecGit).toHaveBeenCalledWith(
      ["log", "--format=%H%n%an%n%aI%n%s", "-n", "200"],
      expect.any(String),
    );

    await handlers["workspace.git.log"]!({ agentId: "test-agent", limit: -5 });
    expect(mockExecGit).toHaveBeenCalledWith(
      ["log", "--format=%H%n%an%n%aI%n%s", "-n", "1"],
      expect.any(String),
    );
  });

  it("defaults limit to 50", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn().mockResolvedValueOnce(ok(""));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.log"]!({ agentId: "test-agent" });

    expect(mockExecGit).toHaveBeenCalledWith(
      ["log", "--format=%H%n%an%n%aI%n%s", "-n", "50"],
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// workspace.git.diff
// ---------------------------------------------------------------------------

describe("workspace.git.diff", () => {
  it("returns full working tree diff", async () => {
    await setupGitDir();
    const diffOutput = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt";
    const mockExecGit = vi.fn().mockResolvedValueOnce(ok(diffOutput));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.diff"]!({
      agentId: "test-agent",
    })) as { diff: string };

    expect(result.diff).toBe(diffOutput);
    expect(mockExecGit).toHaveBeenCalledWith(["diff"], expect.any(String));
  });

  it("returns per-file diff with -- separator", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn().mockResolvedValueOnce(ok("diff content"));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.diff"]!({
      agentId: "test-agent",
      filePath: "file.txt",
    });

    expect(mockExecGit).toHaveBeenCalledWith(
      ["diff", "--", "file.txt"],
      expect.any(String),
    );
  });

  it("truncates diff exceeding 512KB", async () => {
    await setupGitDir();
    const bigDiff = "x".repeat(600_000);
    const mockExecGit = vi.fn().mockResolvedValueOnce(ok(bigDiff));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.diff"]!({
      agentId: "test-agent",
    })) as { diff: string };

    expect(result.diff).toContain("[Diff truncated at 512KB]");
    // The truncated diff should be around 524288 chars + the truncation message
    expect(result.diff.length).toBeLessThan(bigDiff.length);
  });

  it("rejects path traversal in filePath", async () => {
    await setupGitDir();
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.diff"]!({
        agentId: "test-agent",
        filePath: "../escape",
      }),
    ).rejects.toThrow(PathTraversalError);
  });
});

// ---------------------------------------------------------------------------
// workspace.git.commit
// ---------------------------------------------------------------------------

describe("workspace.git.commit", () => {
  it("rejects non-admin callers", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.commit"]!({
        agentId: "test-agent",
        message: "test",
      }),
    ).rejects.toThrow("Admin access required");
  });

  it("stages all and commits with sanitized message", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("M file.txt\n")) // status
      .mockResolvedValueOnce(ok("")) // add -A
      .mockResolvedValueOnce(ok("")) // commit
      .mockResolvedValueOnce(ok("sha1abc\nAuthor\n2026-01-01T00:00:00Z\nmy message\n")); // log

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.commit"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      message: "my message",
    })) as { sha: string; author: string; date: string; message: string };

    expect(result.sha).toBe("sha1abc");
    expect(result.author).toBe("Author");
    expect(result.date).toBe("2026-01-01T00:00:00Z");
    expect(result.message).toBe("my message");

    // Verify add -A was called
    expect(mockExecGit).toHaveBeenCalledWith(["add", "-A"], expect.any(String));
    // Verify commit -m was called
    expect(mockExecGit).toHaveBeenCalledWith(
      ["commit", "-m", "my message"],
      expect.any(String),
    );
  });

  it("stages selective paths with -- separator", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("M file.txt\n")) // status
      .mockResolvedValueOnce(ok("")) // add -- file.txt
      .mockResolvedValueOnce(ok("")) // commit
      .mockResolvedValueOnce(ok("sha2\nBob\n2026-01-02\ncommit msg\n")); // log

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.commit"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      message: "commit msg",
      paths: ["file.txt"],
    });

    expect(mockExecGit).toHaveBeenCalledWith(
      ["add", "--", "file.txt"],
      expect.any(String),
    );
  });

  it("throws Nothing to commit when workspace is clean", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn().mockResolvedValueOnce(ok("")); // status is empty

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await expect(
      handlers["workspace.git.commit"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
        message: "test",
      }),
    ).rejects.toThrow("Nothing to commit");
  });

  it("sanitizes commit message: strips control chars, truncates to 500", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("M file.txt\n")) // status
      .mockResolvedValueOnce(ok("")) // add
      .mockResolvedValueOnce(ok("")) // commit
      .mockResolvedValueOnce(ok("sha\nA\n2026-01-01\nmsg\n")); // log

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.commit"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      message: "Hello\x00World" + "x".repeat(600),
    });

    // Find the commit call (3rd call, index 2)
    const commitCall = mockExecGit.mock.calls.find(
      (c: string[][]) => c[0][0] === "commit",
    );
    expect(commitCall).toBeDefined();
    const commitMessage = commitCall![0][2] as string;
    // Control chars stripped
    expect(commitMessage).toMatch(/^HelloWorld/);
    // Truncated to 500
    expect(commitMessage.length).toBeLessThanOrEqual(500);
  });

  it("uses default message when message is empty", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("M file.txt\n")) // status
      .mockResolvedValueOnce(ok("")) // add
      .mockResolvedValueOnce(ok("")) // commit
      .mockResolvedValueOnce(ok("sha\nA\n2026-01-01\nmsg\n")); // log

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.commit"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      message: "",
    });

    const commitCall = mockExecGit.mock.calls.find(
      (c: string[][]) => c[0][0] === "commit",
    );
    expect(commitCall![0][2]).toBe("Operator commit via web console");
  });
});

// ---------------------------------------------------------------------------
// workspace.git.restore
// ---------------------------------------------------------------------------

describe("workspace.git.restore", () => {
  it("rejects non-admin callers", async () => {
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.restore"]!({
        agentId: "test-agent",
        filePath: "file.txt",
      }),
    ).rejects.toThrow("Admin access required");
  });

  it("rejects when filePath missing", async () => {
    await setupGitDir();
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.restore"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
      }),
    ).rejects.toThrow("Missing required parameter: filePath");
  });

  it("restores file to HEAD with -- separator", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn().mockResolvedValueOnce(ok(""));

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.restore"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      filePath: "file.txt",
    })) as { restored: boolean };

    expect(result.restored).toBe(true);
    expect(mockExecGit).toHaveBeenCalledWith(
      ["checkout", "HEAD", "--", "file.txt"],
      expect.any(String),
    );
  });

  it("returns clear error for untracked file", async () => {
    await setupGitDir();
    const mockExecGit = vi.fn().mockResolvedValueOnce(
      err("error: pathspec 'new.txt' did not match any file(s) known to git"),
    );

    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await expect(
      handlers["workspace.git.restore"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
        filePath: "new.txt",
      }),
    ).rejects.toThrow("File has no committed version");
  });

  it("rejects path traversal in filePath", async () => {
    await setupGitDir();
    const handlers = createWorkspaceHandlers(makeDeps());
    await expect(
      handlers["workspace.git.restore"]!({
        _trustLevel: "admin",
        agentId: "test-agent",
        filePath: "../escape",
      }),
    ).rejects.toThrow(PathTraversalError);
  });
});

// ---------------------------------------------------------------------------
// parseStatusLine (tested via workspace.git.status)
// ---------------------------------------------------------------------------

describe("parseStatusLine (via workspace.git.status)", () => {
  async function getEntries(porcelain: string) {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("main\n")) // branch
      .mockResolvedValueOnce(ok(porcelain)); // status
    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    const result = (await handlers["workspace.git.status"]!({
      agentId: "test-agent",
    })) as { entries: Array<{ path: string; status: string; staged: boolean }> };
    return result.entries;
  }

  it("parses untracked files", async () => {
    const entries = await getEntries("?? untracked.txt\n");
    expect(entries[0]).toEqual({ path: "untracked.txt", status: "untracked", staged: false });
  });

  it("parses staged modified files", async () => {
    const entries = await getEntries("M  staged.txt\n");
    expect(entries[0]).toEqual({ path: "staged.txt", status: "modified", staged: true });
  });

  it("parses unstaged modified files", async () => {
    const entries = await getEntries(" M unstaged.txt\n");
    expect(entries[0]).toEqual({ path: "unstaged.txt", status: "modified", staged: false });
  });

  it("parses added files", async () => {
    const entries = await getEntries("A  added.txt\n");
    expect(entries[0]).toEqual({ path: "added.txt", status: "added", staged: true });
  });

  it("parses staged deleted files", async () => {
    const entries = await getEntries("D  deleted.txt\n");
    expect(entries[0]).toEqual({ path: "deleted.txt", status: "deleted", staged: true });
  });

  it("parses unstaged deleted files", async () => {
    const entries = await getEntries(" D deleted2.txt\n");
    expect(entries[0]).toEqual({ path: "deleted2.txt", status: "deleted", staged: false });
  });

  it("parses renamed files with arrow", async () => {
    const entries = await getEntries("R  old.txt -> new.txt\n");
    expect(entries[0]).toEqual({ path: "new.txt", status: "renamed", staged: true });
  });
});

// ---------------------------------------------------------------------------
// sanitizeCommitMessage (tested via workspace.git.commit)
// ---------------------------------------------------------------------------

describe("sanitizeCommitMessage (via workspace.git.commit)", () => {
  async function getCommitMessage(message: unknown) {
    await setupGitDir();
    const mockExecGit = vi.fn()
      .mockResolvedValueOnce(ok("M file.txt\n")) // status
      .mockResolvedValueOnce(ok("")) // add
      .mockResolvedValueOnce(ok("")) // commit
      .mockResolvedValueOnce(ok("sha\nA\n2026-01-01\nmsg\n")); // log
    const handlers = createWorkspaceHandlers(makeDeps({ execGit: mockExecGit }));
    await handlers["workspace.git.commit"]!({
      _trustLevel: "admin",
      agentId: "test-agent",
      message,
    });
    const commitCall = mockExecGit.mock.calls.find(
      (c: string[][]) => c[0][0] === "commit",
    );
    return commitCall![0][2] as string;
  }

  it("uses default for undefined message", async () => {
    const msg = await getCommitMessage(undefined);
    expect(msg).toBe("Operator commit via web console");
  });

  it("uses default for empty string", async () => {
    const msg = await getCommitMessage("");
    expect(msg).toBe("Operator commit via web console");
  });

  it("strips control chars but preserves newlines", async () => {
    const msg = await getCommitMessage("line1\nline2\x00\x01\x7f");
    expect(msg).toBe("line1\nline2");
  });

  it("truncates at 500 chars", async () => {
    const msg = await getCommitMessage("a".repeat(600));
    expect(msg.length).toBe(500);
  });
});
