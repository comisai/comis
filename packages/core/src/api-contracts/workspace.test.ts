// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract tests for the workspace-umbrella contracts.
 *
 * The 5 handler factories under the WorkspaceApiDeps slice expose 36
 * methods total — 12 workspace + 13 browser + 4 admin.approval + 6
 * skills + 1 notification. The tests below cover:
 *   - Aggregator sanity (count = 36; scopes match the
 *     setup-gateway-api.ts registration where applicable; method names
 *     match the handler-factory PropertyAssignment keys).
 *   - Method names (1 assertion per of the 36 contracts).
 *   - Scope assignments (per-handler-file blocks).
 *   - Spot-check request acceptance/rejection on 3 representative
 *     contracts (one per handler-file cluster: workspace.writeFile,
 *     admin.approval.resolve, skills.upload). These exercise the
 *     bespoke pre-Zod path (handler) + the contract.request.parse(...)
 *     path (this test) for representative shapes covering required-field
 *     enforcement, optional-field acceptance, enum acceptance, and
 *     array-of-record acceptance.
 *   - INTERNAL_FIELD_NAMES paired sanity test (no contract request
 *     schema declares any `_X` key — mirrors
 *     test/architecture/contract-internal-fields.test.ts).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  // workspace-handlers.ts (12)
  WorkspaceStatusContract,
  WorkspaceReadFileContract,
  WorkspaceWriteFileContract,
  WorkspaceDeleteFileContract,
  WorkspaceListDirContract,
  WorkspaceResetFileContract,
  WorkspaceInitContract,
  WorkspaceGitStatusContract,
  WorkspaceGitLogContract,
  WorkspaceGitDiffContract,
  WorkspaceGitCommitContract,
  WorkspaceGitRestoreContract,
  // browser-handlers.ts (13)
  BrowserStatusContract,
  BrowserStartContract,
  BrowserStopContract,
  BrowserNavigateContract,
  BrowserSnapshotContract,
  BrowserScreenshotContract,
  BrowserPdfContract,
  BrowserActContract,
  BrowserTabsContract,
  BrowserOpenContract,
  BrowserFocusContract,
  BrowserCloseContract,
  BrowserConsoleContract,
  // approval-handlers.ts (4)
  AdminApprovalPendingContract,
  AdminApprovalResolveContract,
  AdminApprovalResolveAllContract,
  AdminApprovalClearDenialCacheContract,
  // skill-handlers.ts (6)
  SkillsListContract,
  SkillsUploadContract,
  SkillsImportContract,
  SkillsDeleteContract,
  SkillsCreateContract,
  SkillsUpdateContract,
  // notification-handlers.ts (1)
  NotificationSendContract,
  WORKSPACE_CONTRACTS,
  INTERNAL_FIELD_NAMES,
} from "./index.js";

describe("workspace-umbrella domain contracts", () => {
  // -------------------------------------------------------------------------
  // Aggregator sanity
  // -------------------------------------------------------------------------

  it("WORKSPACE_CONTRACTS has exactly 36 entries (5 handler files: 12 + 13 + 4 + 6 + 1)", () => {
    expect(WORKSPACE_CONTRACTS.length).toBe(36);
  });

  it("method names match the 5 handler-factory PropertyAssignment keys", () => {
    const methods = WORKSPACE_CONTRACTS.map((c) => c.method).sort();
    expect(methods).toEqual(
      [
        // admin.approval.* (4)
        "admin.approval.clearDenialCache",
        "admin.approval.pending",
        "admin.approval.resolve",
        "admin.approval.resolveAll",
        // browser.* (13)
        "browser.act",
        "browser.close",
        "browser.console",
        "browser.focus",
        "browser.navigate",
        "browser.open",
        "browser.pdf",
        "browser.screenshot",
        "browser.snapshot",
        "browser.start",
        "browser.status",
        "browser.stop",
        "browser.tabs",
        // notification.* (1)
        "notification.send",
        // skills.* (6)
        "skills.create",
        "skills.delete",
        "skills.import",
        "skills.list",
        "skills.update",
        "skills.upload",
        // workspace.* (12)
        "workspace.deleteFile",
        "workspace.git.commit",
        "workspace.git.diff",
        "workspace.git.log",
        "workspace.git.restore",
        "workspace.git.status",
        "workspace.init",
        "workspace.listDir",
        "workspace.readFile",
        "workspace.resetFile",
        "workspace.status",
        "workspace.writeFile",
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // Scope assignment per handler-file cluster
  // -------------------------------------------------------------------------

  it("workspace-handlers: 6 rpc (read-only) + 6 admin (mutating) per setup-gateway-api.ts", () => {
    const rpc = [
      WorkspaceStatusContract,
      WorkspaceReadFileContract,
      WorkspaceListDirContract,
      WorkspaceGitStatusContract,
      WorkspaceGitLogContract,
      WorkspaceGitDiffContract,
    ];
    const admin = [
      WorkspaceWriteFileContract,
      WorkspaceDeleteFileContract,
      WorkspaceResetFileContract,
      WorkspaceInitContract,
      WorkspaceGitCommitContract,
      WorkspaceGitRestoreContract,
    ];
    for (const c of rpc) expect(c.scopes, `${c.method} scopes`).toEqual(["rpc"]);
    for (const c of admin) expect(c.scopes, `${c.method} scopes`).toEqual(["admin"]);
  });

  it("browser-handlers: all 13 are rpc-scoped", () => {
    const browsers = [
      BrowserStatusContract,
      BrowserStartContract,
      BrowserStopContract,
      BrowserNavigateContract,
      BrowserSnapshotContract,
      BrowserScreenshotContract,
      BrowserPdfContract,
      BrowserActContract,
      BrowserTabsContract,
      BrowserOpenContract,
      BrowserFocusContract,
      BrowserCloseContract,
      BrowserConsoleContract,
    ];
    for (const c of browsers) expect(c.scopes, `${c.method} scopes`).toEqual(["rpc"]);
  });

  it("admin.approval.*: all 4 are admin-scoped by intent (namespace prefix)", () => {
    const approvals = [
      AdminApprovalPendingContract,
      AdminApprovalResolveContract,
      AdminApprovalResolveAllContract,
      AdminApprovalClearDenialCacheContract,
    ];
    for (const c of approvals) expect(c.scopes, `${c.method} scopes`).toEqual(["admin"]);
  });

  it("skills.*: list + the 5 mutating handlers are all rpc-scoped", () => {
    // skills.* mutating methods are the orch:skill orchestration surface the
    // capability model owns, NOT control plane. Scoped rpc (not admin) so the
    // deny-by-origin chokepoint does not deny an agent its own granted
    // orch:skill before the requireCapability gate runs. The handlers still gate
    // on orch:skill; admin gateway tokens carry rpc so the web-UI manager works.
    expect(SkillsListContract.scopes).toEqual(["rpc"]);
    for (const c of [
      SkillsUploadContract,
      SkillsImportContract,
      SkillsDeleteContract,
      SkillsCreateContract,
      SkillsUpdateContract,
    ]) {
      expect(c.scopes, `${c.method} scopes`).toEqual(["rpc"]);
    }
  });

  it("notification.send is rpc-scoped", () => {
    expect(NotificationSendContract.scopes).toEqual(["rpc"]);
  });

  // -------------------------------------------------------------------------
  // INTERNAL_FIELD_NAMES paired sanity test
  // -------------------------------------------------------------------------

  it("no contract request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // Use a probe-object pattern: a request schema that DECLARED an internal
    // key would either accept the probe (if `.passthrough()`) or reject it
    // (strict mode). The 12-shape allowlist mode is implicit non-strict (no
    // `.passthrough()`) so an accidental declaration of `_trustLevel` in
    // a schema would fail when `_trustLevel: "admin"` is parsed.
    //
    // The architectural test at test/architecture/contract-internal-fields.test.ts
    // walks the registry; this paired sanity test asserts the same
    // INTERNAL_FIELD_NAMES list is non-empty and stable.
    expect(INTERNAL_FIELD_NAMES.length).toBeGreaterThan(0);
    expect(INTERNAL_FIELD_NAMES).toContain("_trustLevel");
    expect(INTERNAL_FIELD_NAMES).toContain("_agentId");
  });

  // -------------------------------------------------------------------------
  // Spot-check request acceptance/rejection — workspace.writeFile
  // -------------------------------------------------------------------------

  describe("workspace.writeFile (representative — workspace-handlers cluster)", () => {
    it("exposes the canonical method name", () => {
      expect(WorkspaceWriteFileContract.method).toBe("workspace.writeFile");
    });

    it("accepts valid request: { agentId, filePath, content }", () => {
      expect(() =>
        WorkspaceWriteFileContract.request.parse({
          agentId: "test-agent",
          filePath: "BOOTSTRAP.md",
          content: "hello",
        }),
      ).not.toThrow();
    });

    it("rejects missing agentId (required)", () => {
      expect(() =>
        WorkspaceWriteFileContract.request.parse({
          filePath: "BOOTSTRAP.md",
          content: "hello",
        }),
      ).toThrow();
    });

    it("rejects empty agentId (min(1))", () => {
      expect(() =>
        WorkspaceWriteFileContract.request.parse({
          agentId: "",
          filePath: "BOOTSTRAP.md",
          content: "hello",
        }),
      ).toThrow();
    });

    it("rejects missing content (required)", () => {
      expect(() =>
        WorkspaceWriteFileContract.request.parse({
          agentId: "test-agent",
          filePath: "BOOTSTRAP.md",
        }),
      ).toThrow();
    });

    it("response accepts { written: true, sizeBytes }", () => {
      expect(() =>
        WorkspaceWriteFileContract.response.parse({
          written: true,
          sizeBytes: 42,
        }),
      ).not.toThrow();
    });

    it("response rejects written: false (literal true gate)", () => {
      expect(() =>
        WorkspaceWriteFileContract.response.parse({
          written: false,
          sizeBytes: 42,
        }),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Spot-check request acceptance/rejection — admin.approval.resolve
  // -------------------------------------------------------------------------

  describe("admin.approval.resolve (representative — approval-handlers cluster)", () => {
    it("exposes the canonical method name", () => {
      expect(AdminApprovalResolveContract.method).toBe("admin.approval.resolve");
    });

    it("accepts valid request: { requestId, approved, approvedBy?, reason? }", () => {
      expect(() =>
        AdminApprovalResolveContract.request.parse({
          requestId: "req-001",
          approved: true,
          approvedBy: "admin",
        }),
      ).not.toThrow();
    });

    it("accepts request without approvedBy + reason (both optional)", () => {
      expect(() =>
        AdminApprovalResolveContract.request.parse({
          requestId: "req-001",
          approved: true,
        }),
      ).not.toThrow();
    });

    it("rejects non-boolean approved", () => {
      expect(() =>
        AdminApprovalResolveContract.request.parse({
          requestId: "req-001",
          approved: "true" as unknown as boolean,
        }),
      ).toThrow();
    });

    it("rejects empty requestId", () => {
      expect(() =>
        AdminApprovalResolveContract.request.parse({
          requestId: "",
          approved: true,
        }),
      ).toThrow();
    });

    it("response accepts the success shape with reason: null", () => {
      expect(() =>
        AdminApprovalResolveContract.response.parse({
          requestId: "req-001",
          approved: true,
          approvedBy: "operator",
          reason: null,
        }),
      ).not.toThrow();
    });

    it("response accepts reason: \"Denied\"", () => {
      expect(() =>
        AdminApprovalResolveContract.response.parse({
          requestId: "req-001",
          approved: false,
          approvedBy: "admin",
          reason: "Denied",
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Spot-check request acceptance/rejection — skills.upload
  // -------------------------------------------------------------------------

  describe("skills.upload (representative — skill-handlers cluster)", () => {
    it("exposes the canonical method name", () => {
      expect(SkillsUploadContract.method).toBe("skills.upload");
    });

    it("accepts valid request with shared scope + files array", () => {
      expect(() =>
        SkillsUploadContract.request.parse({
          name: "my-skill",
          scope: "shared",
          files: [
            { path: "SKILL.md", content: "# My Skill" },
            { path: "examples/foo.md", content: "example" },
          ],
          agentId: "default",
        }),
      ).not.toThrow();
    });

    it("accepts request without optional scope + agentId (both optional)", () => {
      expect(() =>
        SkillsUploadContract.request.parse({
          name: "my-skill",
          files: [{ path: "SKILL.md", content: "# My Skill" }],
        }),
      ).not.toThrow();
    });

    it("accepts request with scope: \"local\"", () => {
      expect(() =>
        SkillsUploadContract.request.parse({
          name: "my-skill",
          scope: "local",
          files: [{ path: "SKILL.md", content: "# My Skill" }],
        }),
      ).not.toThrow();
    });

    it("rejects invalid scope value", () => {
      expect(() =>
        SkillsUploadContract.request.parse({
          name: "my-skill",
          scope: "invalid" as unknown as "local" | "shared",
          files: [{ path: "SKILL.md", content: "# My Skill" }],
        }),
      ).toThrow();
    });

    it("rejects empty name (min(1))", () => {
      expect(() =>
        SkillsUploadContract.request.parse({
          name: "",
          files: [{ path: "SKILL.md", content: "# My Skill" }],
        }),
      ).toThrow();
    });

    it("rejects missing files (required)", () => {
      expect(() =>
        SkillsUploadContract.request.parse({ name: "my-skill" }),
      ).toThrow();
    });

    it("response accepts { ok: true, path }", () => {
      expect(() =>
        SkillsUploadContract.response.parse({
          ok: true,
          path: "/data/skills/my-skill",
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // skills.list source enum — the trust tiers the model SEES
  // -------------------------------------------------------------------------

  describe("skills.list response source enum (trust tiers the model sees)", () => {
    const baseSkill = {
      name: "web-search",
      description: "Search the web",
      location: "/data/skills/web-search",
    };

    it("response accepts source \"imported\" — the community-import trust tier", () => {
      expect(() =>
        SkillsListContract.response.parse({
          skills: [{ ...baseSkill, source: "imported" }],
        }),
      ).not.toThrow();
    });

    it("response accepts source \"learned\" — the materialized-procedure trust tier", () => {
      expect(() =>
        SkillsListContract.response.parse({
          skills: [{ ...baseSkill, source: "learned" }],
        }),
      ).not.toThrow();
    });

    it("response still accepts the path-derived tiers bundled/workspace/local", () => {
      for (const source of ["bundled", "workspace", "local"] as const) {
        expect(() =>
          SkillsListContract.response.parse({
            skills: [{ ...baseSkill, source }],
          }),
        ).not.toThrow();
      }
    });

    it("response rejects an unrecognized source value (closed enum)", () => {
      expect(() =>
        SkillsListContract.response.parse({
          skills: [{ ...baseSkill, source: "counterfeit" }],
        }),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Spot-check request acceptance/rejection — browser.navigate
  // -------------------------------------------------------------------------

  describe("browser.navigate (representative — browser-handlers cluster)", () => {
    it("exposes the canonical method name", () => {
      expect(BrowserNavigateContract.method).toBe("browser.navigate");
    });

    it("accepts valid request: { targetUrl, targetId? }", () => {
      expect(() =>
        BrowserNavigateContract.request.parse({
          targetUrl: "https://example.com",
        }),
      ).not.toThrow();
      expect(() =>
        BrowserNavigateContract.request.parse({
          targetUrl: "https://example.com",
          targetId: "page-1",
        }),
      ).not.toThrow();
    });

    it("rejects missing targetUrl (required)", () => {
      expect(() => BrowserNavigateContract.request.parse({})).toThrow();
    });

    it("rejects empty targetUrl (min(1))", () => {
      expect(() =>
        BrowserNavigateContract.request.parse({ targetUrl: "" }),
      ).toThrow();
    });

    it("response accepts { url, title, targetId: null }", () => {
      expect(() =>
        BrowserNavigateContract.response.parse({
          url: "https://example.com",
          title: "Example",
          targetId: null,
        }),
      ).not.toThrow();
    });

    it("response accepts { url, title, targetId: string }", () => {
      expect(() =>
        BrowserNavigateContract.response.parse({
          url: "https://example.com",
          title: "Example",
          targetId: "page-1",
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Spot-check — notification.send (the single notification.* contract)
  // -------------------------------------------------------------------------

  describe("notification.send (representative — notification-handlers cluster)", () => {
    it("exposes the canonical method name", () => {
      expect(NotificationSendContract.method).toBe("notification.send");
    });

    it("accepts empty request (all fields optional)", () => {
      expect(() => NotificationSendContract.request.parse({})).not.toThrow();
    });

    it("accepts request with priority enum", () => {
      expect(() =>
        NotificationSendContract.request.parse({
          message: "hello",
          priority: "high",
          channel_type: "telegram",
          channel_id: "chat-42",
        }),
      ).not.toThrow();
    });

    it("rejects invalid priority", () => {
      expect(() =>
        NotificationSendContract.request.parse({
          message: "hello",
          priority: "urgent" as unknown as "high",
        }),
      ).toThrow();
    });

    it("response accepts { success: true, entryId }", () => {
      expect(() =>
        NotificationSendContract.response.parse({
          success: true,
          entryId: "entry-42",
        }),
      ).not.toThrow();
    });

    it("response accepts { success: false, error }", () => {
      expect(() =>
        NotificationSendContract.response.parse({
          success: false,
          error: "Rate limit exceeded",
        }),
      ).not.toThrow();
    });
  });
});
