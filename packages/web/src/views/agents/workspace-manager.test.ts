import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcWorkspaceManager } from "./workspace-manager.js";
import type { RpcClient } from "../../api/rpc-client.js";

// Side-effect import to register custom element
import "./workspace-manager.js";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";

// --- Mock data ---

const mockStatus = {
  dir: "/home/user/.comis/workspace-default",
  exists: true,
  files: [
    { name: "SOUL.md", present: true, sizeBytes: 1234 },
    { name: "IDENTITY.md", present: true, sizeBytes: 567 },
    { name: "USER.md", present: false },
    { name: "AGENTS.md", present: true, sizeBytes: 2048 },
    { name: "TOOLS.md", present: false },
    { name: "HEARTBEAT.md", present: true, sizeBytes: 890 },
    { name: "BOOTSTRAP.md", present: true, sizeBytes: 345 },
    { name: "BOOT.md", present: false },
  ],
  hasGitRepo: true,
  isBootstrapped: true,
};

const mockNotInitialized = {
  dir: "/home/user/.comis/workspace-default",
  exists: false,
  files: [],
  hasGitRepo: false,
  isBootstrapped: false,
};

const mockFileContent = { content: "# Soul\nYou are a helpful agent.", sizeBytes: 35 };

const mockDirEntries = {
  entries: [
    { name: "report.txt", type: "file", sizeBytes: 4096, modifiedAt: Date.now() - 60000 },
    { name: "notes", type: "directory", modifiedAt: Date.now() - 120000 },
  ],
};

const mockGitStatus = {
  branch: "main",
  clean: false,
  entries: [
    { path: "SOUL.md", status: "modified" as const, staged: false },
    { path: "output/new.txt", status: "untracked" as const, staged: false },
    { path: "old-file.md", status: "deleted" as const, staged: false },
  ],
};

const mockGitStatusClean = {
  branch: "main",
  clean: true,
  entries: [],
};

const mockGitLog = [
  { sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", author: "Agent", date: "2026-03-20T10:00:00Z", message: "Initial commit" },
  { sha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3", author: "Agent", date: "2026-03-20T09:00:00Z", message: "Add SOUL.md" },
];

const mockDiffContent = "diff --git a/SOUL.md b/SOUL.md\n--- a/SOUL.md\n+++ b/SOUL.md\n@@ -1,3 +1,4 @@\n+new line\n existing content\n-removed line\n context line";

/** Workspace-specific mock that routes RPC methods to workspace test data. */
function createWorkspaceMockRpcClient(overrides?: Partial<import("../../api/rpc-client.js").RpcClient>): import("../../api/rpc-client.js").RpcClient {
  return createMockRpcClient(
    async (method: string) => {
      if (method === "workspace.status") return Promise.resolve(mockStatus);
      if (method === "workspace.readFile") return Promise.resolve(mockFileContent);
      if (method === "workspace.writeFile") return Promise.resolve({ written: true, sizeBytes: 35 });
      if (method === "workspace.deleteFile") return Promise.resolve({ deleted: true });
      if (method === "workspace.listDir") return Promise.resolve(mockDirEntries);
      if (method === "workspace.resetFile") return Promise.resolve({ reset: true, fileName: "SOUL.md" });
      if (method === "workspace.init") return Promise.resolve({ ...mockStatus, exists: true });
      if (method === "workspace.git.status") return Promise.resolve(mockGitStatus);
      if (method === "workspace.git.log") return Promise.resolve({ commits: mockGitLog });
      if (method === "workspace.git.diff") return Promise.resolve({ diff: mockDiffContent });
      if (method === "workspace.git.commit") return Promise.resolve({ sha: "abc1234", author: "Agent", date: "2026-03-20T10:05:00Z", message: "Operator commit" });
      if (method === "workspace.git.restore") return Promise.resolve({ restored: true });
      return Promise.resolve({});
    },
    overrides,
  );
}

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Type-safe access to private fields. */
function priv(el: IcWorkspaceManager) {
  return el as unknown as {
    _status: typeof mockStatus | null;
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _activeTab: "files" | "git";
    _selectedFile: string | null;
    _selectedSubdir: string | null;
    _fileContent: string;
    _editedContent: string;
    _dirEntries: Array<{ name: string; type: string; sizeBytes?: number; modifiedAt?: number }>;
    _saving: boolean;
    _dirty: boolean;
    _confirmAction: "delete" | "reset" | "restore" | null;
    _actionPending: boolean;
    _loadStatus(): Promise<void>;
    _selectFile(name: string): Promise<void>;
    _selectSubdir(name: string): Promise<void>;
    _handleSave(): Promise<void>;
    _handleReset(): Promise<void>;
    _handleDelete(): Promise<void>;
    _handleInit(): Promise<void>;
    _onEditorInput(e: Event): void;
    // Git tab state
    _gitStatus: typeof mockGitStatus | null;
    _gitLog: Array<{ sha: string; author: string; date: string; message: string }>;
    _gitDiff: string;
    _gitDiffFile: string | null;
    _commitMessage: string;
    _committing: boolean;
    _restoreTarget: string | null;
    _commitDisabled: boolean;
    // Git tab methods
    _loadGitData(): Promise<void>;
    _handleCommit(): Promise<void>;
    _handleRestore(): Promise<void>;
    _loadFileDiff(filePath: string): Promise<void>;
    _requestRestore(filePath: string): void;
    _switchToGitTab(): void;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcWorkspaceManager", () => {
  it("renders loading skeleton initially", async () => {
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager");

    const skeleton = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(skeleton).toBeTruthy();
  });

  it("renders file tree with 8 template files after load", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Template files section has 8 items
    const treeItems = el.shadowRoot?.querySelectorAll(".tree-item");
    // 8 template files + 6 subdirectories = 14 total tree items
    expect(treeItems!.length).toBe(14);

    // Check presence dots: 5 present (green), 3 absent (red)
    const presentDots = el.shadowRoot?.querySelectorAll(".presence-dot--present");
    const absentDots = el.shadowRoot?.querySelectorAll(".presence-dot--absent");
    expect(presentDots!.length).toBe(5);
    expect(absentDots!.length).toBe(3);
  });

  it("renders 6 subdirectory items in file tree", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Subdirectory items have folder icons
    const folderIcons = el.shadowRoot?.querySelectorAll(".folder-icon");
    expect(folderIcons!.length).toBe(6);

    // Verify directory names
    const dirButtons = Array.from(el.shadowRoot?.querySelectorAll(".tree-item") ?? [])
      .filter((btn) => btn.querySelector(".folder-icon"));
    const dirNames = dirButtons.map((b) => b.querySelector(".file-name")?.textContent);
    expect(dirNames).toContain("projects");
    expect(dirNames).toContain("scripts");
    expect(dirNames).toContain("documents");
    expect(dirNames).toContain("media");
    expect(dirNames).toContain("data");
    expect(dirNames).toContain("output");
  });

  it("clicking a file loads content into editor", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Click the first file (SOUL.md)
    await priv(el)._selectFile("SOUL.md");
    await el.updateComplete;

    // Verify RPC was called with correct params
    expect(mockRpc.call).toHaveBeenCalledWith("workspace.readFile", {
      agentId: "default",
      filePath: "SOUL.md",
    });

    // Verify editor shows content
    const textarea = el.shadowRoot?.querySelector(".editor-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe("# Soul\nYou are a helpful agent.");

    // Verify filename displayed
    const filename = el.shadowRoot?.querySelector(".editor-filename");
    expect(filename?.textContent).toBe("SOUL.md");
  });

  it("editor tracks dirty state on input", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Load a file first
    await priv(el)._selectFile("SOUL.md");
    await el.updateComplete;

    // Simulate editing via the internal handler
    priv(el)._onEditorInput({ target: { value: "modified content" } } as unknown as Event);
    await el.updateComplete;

    expect(priv(el)._dirty).toBe(true);

    // Check unsaved indicator appears
    const dirtyIndicator = el.shadowRoot?.querySelector(".dirty-indicator");
    expect(dirtyIndicator).toBeTruthy();
    expect(dirtyIndicator!.textContent).toContain("unsaved");
  });

  it("save button calls workspace.writeFile and clears dirty state", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Load and edit a file
    await priv(el)._selectFile("SOUL.md");
    await el.updateComplete;

    priv(el)._onEditorInput({ target: { value: "new content" } } as unknown as Event);
    await el.updateComplete;

    expect(priv(el)._dirty).toBe(true);

    // Trigger save
    await priv(el)._handleSave();
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("workspace.writeFile", {
      agentId: "default",
      filePath: "SOUL.md",
      content: "new content",
    });

    expect(priv(el)._dirty).toBe(false);
  });

  it("delete shows confirm dialog before calling RPC", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Load a file first
    await priv(el)._selectFile("SOUL.md");
    await el.updateComplete;

    // Click delete to open confirm dialog
    const deleteBtn = el.shadowRoot?.querySelector(".btn--danger");
    expect(deleteBtn).toBeTruthy();
    (deleteBtn as HTMLElement)?.click();
    await el.updateComplete;

    // Confirm dialog should be open
    expect(priv(el)._confirmAction).toBe("delete");

    const confirmDialogs = el.shadowRoot?.querySelectorAll("ic-confirm-dialog");
    const deleteDialog = Array.from(confirmDialogs ?? []).find(
      (d) => (d as any).title === "Delete File",
    );
    expect(deleteDialog).toBeTruthy();
    expect((deleteDialog as any).open).toBe(true);

    // Simulate @confirm event from dialog
    await priv(el)._handleDelete();
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("workspace.deleteFile", {
      agentId: "default",
      filePath: "SOUL.md",
    });
  });

  it("reset shows confirm dialog before calling RPC", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Load a file first
    await priv(el)._selectFile("SOUL.md");
    await el.updateComplete;

    // Find the "Reset to Default" button (secondary)
    const allSecondary = el.shadowRoot?.querySelectorAll(".btn--secondary");
    const resetBtn = Array.from(allSecondary ?? []).find(
      (b) => b.textContent?.trim() === "Reset to Default",
    );
    expect(resetBtn).toBeTruthy();
    (resetBtn as HTMLElement)?.click();
    await el.updateComplete;

    // Confirm dialog should be open
    expect(priv(el)._confirmAction).toBe("reset");

    // Simulate @confirm event from dialog
    await priv(el)._handleReset();
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("workspace.resetFile", {
      agentId: "default",
      fileName: "SOUL.md",
    });
  });

  it("renders init workspace state when workspace does not exist", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "workspace.status") return Promise.resolve(mockNotInitialized);
        if (method === "workspace.init") return Promise.resolve({ ...mockStatus, exists: true });
        return Promise.resolve({});
      }),
    });
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Empty state with init button should be shown
    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();

    const initBtn = el.shadowRoot?.querySelector(".btn--primary");
    expect(initBtn).toBeTruthy();
    expect(initBtn!.textContent?.trim()).toBe("Init Workspace");

    // Click init
    await priv(el)._handleInit();
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("workspace.init", { agentId: "default" });
  });

  it("renders breadcrumb with agent workspace path", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    const breadcrumb = el.shadowRoot?.querySelector("ic-breadcrumb");
    expect(breadcrumb).toBeTruthy();

    const items = (breadcrumb as any).items;
    expect(items).toHaveLength(3);
    expect(items[0].label).toBe("Agents");
    expect(items[0].route).toBe("agents");
    expect(items[1].label).toBe("default");
    expect(items[1].route).toBe("agents/default");
    expect(items[2].label).toBe("Workspace");
  });

  it("status bar shows workspace path and tags", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    const statusBar = el.shadowRoot?.querySelector(".status-bar");
    expect(statusBar).toBeTruthy();

    // Dir path displayed in code element
    const code = statusBar!.querySelector("code");
    expect(code?.textContent).toBe("/home/user/.comis/workspace-default");

    // Tags for git repo and bootstrapped
    const tags = statusBar!.querySelectorAll("ic-tag");
    expect(tags.length).toBe(2);

    const tagTexts = Array.from(tags).map((t) => t.textContent?.trim());
    expect(tagTexts).toContain("git repo");
    expect(tagTexts).toContain("bootstrapped");
  });

  it("clicking subdirectory loads directory listing", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    // Select a subdirectory
    await priv(el)._selectSubdir("projects");
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("workspace.listDir", {
      agentId: "default",
      subdir: "projects",
    });

    // Should render directory table
    const dirTable = el.shadowRoot?.querySelector(".dir-table");
    expect(dirTable).toBeTruthy();

    // Should have 2 rows (from mockDirEntries)
    const rows = dirTable!.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);

    const cellTexts = Array.from(rows[0].querySelectorAll("td")).map((td) => td.textContent?.trim());
    expect(cellTexts[0]).toBe("report.txt");
    expect(cellTexts[1]).toBe("file");
  });

  it("handles RPC errors gracefully", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;

    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.textContent).toContain("Network error");

    const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
    expect(retryBtn).toBeTruthy();
  });

  // --- Git tab tests ---

  it("git tab renders status with branch name and changed files", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // Branch name displayed
    const branch = el.shadowRoot?.querySelector(".git-branch");
    expect(branch).toBeTruthy();
    expect(branch!.textContent).toBe("main");

    // Change count displayed
    const changeCount = el.shadowRoot?.querySelector(".git-change-count");
    expect(changeCount).toBeTruthy();
    expect(changeCount!.textContent).toContain("3");

    // 3 changed file entries
    const changedFiles = el.shadowRoot?.querySelectorAll(".changed-file");
    expect(changedFiles!.length).toBe(3);

    // Status badges: M, ??, D
    const badges = el.shadowRoot?.querySelectorAll(".status-badge");
    expect(badges![0].textContent).toBe("M");
    expect(badges![1].textContent).toBe("??");
    expect(badges![2].textContent).toBe("D");
  });

  it("git tab shows no-repo empty state when hasGitRepo is false", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "workspace.status") return Promise.resolve({ ...mockStatus, hasGitRepo: false });
        return Promise.resolve({});
      }),
    });
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // Empty state shown
    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
    expect((emptyState as any).message).toBe("No git repository");

    // No git sections present
    const gitSections = el.shadowRoot?.querySelectorAll(".git-section");
    expect(gitSections!.length).toBe(0);
  });

  it("clicking a changed file loads its diff", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // Click the first changed file (SOUL.md) -- use direct method call to await the async load
    await priv(el)._loadFileDiff("SOUL.md");
    await el.updateComplete;

    // Verify diff file set
    expect(priv(el)._gitDiffFile).toBe("SOUL.md");

    // Diff viewer rendered
    const diffViewer = el.shadowRoot?.querySelector(".diff-viewer");
    expect(diffViewer).toBeTruthy();

    // Diff content has colored spans
    const diffContent = el.shadowRoot?.querySelector(".diff-content");
    expect(diffContent).toBeTruthy();
    const addLines = diffContent!.querySelectorAll(".diff-add");
    expect(addLines.length).toBeGreaterThan(0);
    const delLines = diffContent!.querySelectorAll(".diff-del");
    expect(delLines.length).toBeGreaterThan(0);
    const hunkLines = diffContent!.querySelectorAll(".diff-hunk");
    expect(hunkLines.length).toBeGreaterThan(0);

    // RPC called with correct params
    expect(mockRpc.call).toHaveBeenCalledWith("workspace.git.diff", {
      agentId: "default",
      filePath: "SOUL.md",
    });
  });

  it("commit form calls workspace.git.commit and refreshes data", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // Set commit message and trigger commit
    priv(el)._commitMessage = "Test commit";
    await priv(el)._handleCommit();
    await el.updateComplete;

    // RPC called with correct params
    expect(mockRpc.call).toHaveBeenCalledWith("workspace.git.commit", {
      agentId: "default",
      message: "Test commit",
    });

    // Message cleared after commit
    expect(priv(el)._commitMessage).toBe("");

    // Data refreshed: git.status called again after commit
    const statusCalls = (mockRpc.call as any).mock.calls.filter(
      (c: unknown[]) => c[0] === "workspace.git.status",
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("restore confirmation calls workspace.git.restore", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // Request restore
    priv(el)._requestRestore("SOUL.md");
    expect(priv(el)._confirmAction).toBe("restore");
    expect(priv(el)._restoreTarget).toBe("SOUL.md");

    // Confirm restore
    await priv(el)._handleRestore();
    await el.updateComplete;

    // RPC called with correct params
    expect(mockRpc.call).toHaveBeenCalledWith("workspace.git.restore", {
      agentId: "default",
      filePath: "SOUL.md",
    });

    // State cleared
    expect(priv(el)._restoreTarget).toBeNull();
    expect(priv(el)._confirmAction).toBeNull();
  });

  it("restore button hidden for untracked and added files", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    const changedFiles = el.shadowRoot?.querySelectorAll(".changed-file");
    expect(changedFiles!.length).toBe(3);

    // First (modified) has restore button
    const firstRestore = changedFiles![0].querySelector(".restore-btn");
    expect(firstRestore).toBeTruthy();

    // Second (untracked) does NOT have restore button
    const secondRestore = changedFiles![1].querySelector(".restore-btn");
    expect(secondRestore).toBeNull();

    // Third (deleted) has restore button
    const thirdRestore = changedFiles![2].querySelector(".restore-btn");
    expect(thirdRestore).toBeTruthy();
  });

  it("commit button disabled when status is clean", async () => {
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockImplementation((method: string) => {
        if (method === "workspace.status") return Promise.resolve(mockStatus);
        if (method === "workspace.git.status") return Promise.resolve(mockGitStatusClean);
        if (method === "workspace.git.log") return Promise.resolve({ commits: mockGitLog });
        return Promise.resolve({});
      }),
    });
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // Commit button is disabled
    const commitBtn = el.shadowRoot?.querySelector(".commit-form .btn--primary") as HTMLButtonElement;
    expect(commitBtn).toBeTruthy();
    expect(commitBtn.disabled).toBe(true);

    // _commitDisabled getter is true
    expect(priv(el)._commitDisabled).toBe(true);
  });

  it("commit log shows truncated SHA and commit messages", async () => {
    const mockRpc = createWorkspaceMockRpcClient();
    const el = await createElement<IcWorkspaceManager>("ic-workspace-manager", {
      rpcClient: mockRpc,
      agentId: "default",
    });

    await priv(el)._loadStatus();
    await el.updateComplete;
    priv(el)._switchToGitTab();
    await priv(el)._loadGitData();
    await el.updateComplete;

    // 2 commit entries
    const commitEntries = el.shadowRoot?.querySelectorAll(".commit-entry");
    expect(commitEntries!.length).toBe(2);

    // First commit: truncated SHA and message
    const firstSha = commitEntries![0].querySelector(".commit-sha");
    expect(firstSha!.textContent).toBe("a1b2c3d");
    const firstMsg = commitEntries![0].querySelector(".commit-message");
    expect(firstMsg!.textContent).toBe("Initial commit");

    // Each entry has an ic-relative-time element
    const relTimes = commitEntries![0].querySelectorAll("ic-relative-time");
    expect(relTimes.length).toBe(1);
    const relTimes2 = commitEntries![1].querySelectorAll("ic-relative-time");
    expect(relTimes2.length).toBe(1);
  });
});
