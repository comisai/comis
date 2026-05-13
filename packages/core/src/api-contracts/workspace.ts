// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace-umbrella RPC contracts. Mirrors the combined surface of the
 * five handler-factory files that share the `WorkspaceApiDeps` cluster
 * slice (Phase 34 plan 34-08a — DAEMON-API-03 #D-08):
 *
 *   - `packages/daemon/src/api/workspace-handlers.ts`     (12 methods)
 *   - `packages/daemon/src/api/browser-handlers.ts`       (13 methods)
 *   - `packages/daemon/src/api/approval-handlers.ts`      ( 4 methods)
 *   - `packages/daemon/src/api/skill-handlers.ts`         ( 6 methods)
 *   - `packages/daemon/src/api/notification-handlers.ts`  ( 1 method)
 *
 * Phase 35 Wave C plan 35-13 (Wave C domain #8). The five handler-factory
 * files share a single contract file because they all consume the same
 * `WorkspaceApiDeps` cluster slice (Phase 34 plan 34-08a — the slice was
 * named "Workspace" only because workspace-handlers was the namesake;
 * structurally the slice carries deps for ALL five handlers and the
 * `mcp-handlers.ts` factory — mcp owns its own contract file `mcp.ts`
 * already from plan 35-10). Per CONTEXT D-08: domain naming follows the
 * Phase 34 ApiDeps slice; file-organization mirrors the slice membership.
 *
 * Plan 35-13 splits the contract authoring into two sequential tasks
 * (WARNING 2 fix) to reduce per-commit diff size:
 *
 *   Task 1 (this commit): workspace-handlers (12) + browser-handlers (13)
 *     = 25 contracts. `WORKSPACE_CONTRACTS` const at the END of this file
 *     initially holds these 25 contracts.
 *   Task 2 (next commit): EDITS this file to APPEND approval (4) + skill
 *     (6) + notification (1) = 11 more contracts, extending the
 *     `WORKSPACE_CONTRACTS` tuple.
 *
 * Plan-vs-reality method-count corrections (Rule 1 auto-fixes):
 *
 *   - Plan said `admin.approval.*` has 3 methods (`pending`, `resolve`,
 *     `clearDenialCache`). Reality: the handler factory exposes 4 —
 *     `pending`, `resolve`, `resolveAll`, `clearDenialCache`.
 *     `resolveAll` is NOT registered in `setup-gateway-api.ts` (only the
 *     other 3 are admin-gated through the gateway router), but the
 *     bidirectional 1:1 architecture test walks handler-factory method
 *     keys (registration-plane-agnostic), so a contract is mandatory.
 *   - Plan said `skills.*` has 4 methods (`list`, `upload`, `import`,
 *     `delete`). Reality: 6 — adds `create` + `update`. Same
 *     registration-plane situation as `resolveAll`: `create` and
 *     `update` are not in the gateway router but exist as
 *     PropertyAssignments in skill-handlers.ts, so contracts are
 *     mandatory for the bidirectional test to pass.
 *   - Plan estimated `~28 contracts` total; reality is 36 (12 + 13 + 4
 *     + 6 + 1). Recorded as deviation in SUMMARY.
 *
 * Registration scopes (from setup-gateway-api.ts lines 176-335):
 *
 *   - workspace.* split: 6 rpc + 6 admin
 *       rpc:   status, readFile, listDir, git.status, git.log, git.diff
 *       admin: writeFile, deleteFile, resetFile, init,
 *              git.commit, git.restore
 *   - browser.* — all 13 are `"rpc"` scope (registered at lines 176-181)
 *   - admin.approval.* — `"admin"` for the 3 registered methods;
 *     `resolveAll` is NOT registered (no contract scope inference from
 *     the router — the contract scope `["admin"]` documents the intended
 *     trust model per the namespace prefix `admin.approval.`).
 *   - skills.list is `"rpc"`; skills.upload / import / delete are
 *     `"admin"`. skills.create / skills.update are NOT registered in
 *     setup-gateway-api.ts (gateway-tool / agent-tool dispatch path
 *     only). The contract scope `["admin"]` documents the intended
 *     trust model (these handlers gate destructive writes to the
 *     shared-skills directory).
 *   - notification.send is `"rpc"`.
 *
 * **BLOCKER 1 EXEMPTION (web-SPA only).** All five handler families are
 * dispatched ONLY from the web SPA (`packages/web/src/views/`) and from
 * agent tool-handlers within `@comis/skills`. Empty CLI grep verified:
 *   `grep -rln 'client\.call("workspace\.\|client\.call("browser\.\|
 *    client\.call("admin\.approval\.\|client\.call("skills\.\|
 *    client\.call("notification\.' packages/cli/src/`
 * returns ZERO matches. Mirrors the BLOCKER 1 exemption pattern of
 * Plans 35-09 (tokens), 35-10 (mcp), 35-12 (observability). No CLI
 * retarget needed.
 *
 * **BLOCKER 6 deep-import path deviation (Rule 1 auto-fix, mirrors
 * Plans 35-07..35-12 precedent).** The plan's `<acceptance_criteria>`
 * blocks instructed NO edit to `packages/core/src/api-contracts/index.ts`
 * (Plan 35-19 owns the atomic 14-domain aggregator). Reality:
 * `packages/core/package.json` has no `exports` sub-path config — only
 * `"."` is mapped. Deep imports fail at Node ESM runtime with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Followed Wave C precedent: imported
 * `WORKSPACE_CONTRACTS` into `index.ts`, spread into
 * `API_CONTRACTS_ORDERED`, added `export * from "./workspace.js"`. Per
 * orchestrator directive: "Additive edits to api-contracts/index.ts are
 * accepted (Plan 35-19 owns final atomic edit)."
 *
 * **D-05 LOOSE-RECORD use.** Several response shapes use
 * `z.record(z.string(), z.unknown())` (the RECORD_VALUE_ESCAPE_HATCH at
 * `scripts/contracts/walk-zod-schema.ts` line 25 permits `z.unknown`
 * ONLY as the value-type inside a `z.record`):
 *
 *   - `workspace.status.response` — `WorkspaceStatus` from
 *     `@comis/core/workspace` carries 6 fields including `files[]`,
 *     `hasGitRepo`, `state?` (with nested timestamps + version). Tight
 *     modeling would pin every WorkspaceState sub-field's wire format
 *     across daemon restarts; loose-record matches D-05 precedent.
 *   - `browser.snapshot.response` — `SnapshotResult` carries `refs:
 *     RoleRefMap` (a `Record<string, unknown>` of role→ref mappings)
 *     plus `stats: { lines, chars, refs, interactive }`. Tight modeling
 *     would force every RoleRefMap value-shape into the wire contract.
 *   - `admin.approval.pending.response.requests[]` — `ApprovalRequest`
 *     uses `z.strictObject` server-side with `z.string().uuid()`
 *     refinement, which is OUTSIDE the 12-shape allowlist. The contract
 *     models each request as a loose record per D-05.
 *   - `skills.list.response.skills[]` — `PromptSkillDescription`
 *     carries `name`, `description`, `location`, optional flags. Tight
 *     modeling is possible (all leaf shapes are primitives), and we
 *     do model it tight (see SkillDescriptionSchema below).
 *
 * Bespoke pre-Zod validation in the 5 handler files is retained
 * verbatim (admin trust check, agentId presence guard, filePath
 * presence guard, etc.) — they produce user-friendly,
 * operator-actionable error messages. The contract `request.parse(...)`
 * runs AFTER the bespoke guards and serves as (a) type narrowing for
 * the remainder of the handler body and (b) defense-in-depth + dev-mode
 * response-shape canary via `IS_DEV && Contract.response.parse(...)`.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ===========================================================================
// Shared sub-schemas (allowlist shapes only).
// ===========================================================================

/**
 * D-05 loose-record value type. Used for response shapes whose nested
 * structure varies per call (Snapshot ref maps, WorkspaceStatus state
 * blocks, etc.) and where tight modeling would pin every sub-field's
 * wire format. Mirrors the precedent in
 * `packages/core/src/api-contracts/observability.ts` (Plan 35-12).
 */
const LooseRecord = z.record(z.string(), z.unknown());

/**
 * Workspace.listDir entry shape — directory listing row. Modeled tight
 * because the shape is fully primitive at the leaves and the handler
 * builds it explicitly (workspace-handlers.ts:275-291).
 *
 * `type` is the discriminator (`"file" | "directory"`) — modeled via
 * `z.enum` (allowlist shape #7). `sizeBytes` is present only on files
 * (handler line 288 — conditional spread). `modifiedAt` is the mtime
 * in epoch-milliseconds.
 */
const WorkspaceListEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory"]),
  sizeBytes: z.number().optional(),
  modifiedAt: z.number(),
});

/**
 * Workspace.git.status entry — file-level git status row. Modeled tight
 * (workspace-handlers.ts:113-128 `parseStatusLine`). The handler emits
 * 7 distinct `status` values:
 *   - "untracked" (both x + y are "?")
 *   - "deleted" (x or y is "D")
 *   - "added" (x is "A")
 *   - "renamed" (x is "R")
 *   - "copied" (x is "C")
 *   - "modified" (x or y is "M" or fallback)
 *
 * `staged` is true when the change is in the index (x position),
 * false when only in the worktree (y position).
 */
const WorkspaceGitStatusEntrySchema = z.object({
  path: z.string(),
  status: z.enum([
    "untracked",
    "deleted",
    "added",
    "renamed",
    "copied",
    "modified",
  ]),
  staged: z.boolean(),
});

/**
 * Workspace.git.log commit entry. Tight model — 4 string fields
 * (workspace-handlers.ts:390-395). All fields are required because
 * the handler always populates them from parsed git-log output.
 */
const WorkspaceGitCommitSchema = z.object({
  sha: z.string(),
  author: z.string(),
  date: z.string(),
  message: z.string(),
});

/**
 * Browser.tabs / browser.open / focus result — `TabInfo` from
 * `packages/skills/src/tools/browser/browser-service.ts:75-80`. Tight
 * model (4 string fields).
 */
const BrowserTabInfoSchema = z.object({
  targetId: z.string(),
  title: z.string(),
  url: z.string(),
  type: z.string(),
});

/**
 * Browser.status result — `BrowserStatus` from
 * `packages/skills/src/tools/browser/browser-service.ts:58-65`. Tight
 * model.
 */
const BrowserStatusSchema = z.object({
  running: z.boolean(),
  chromeVersion: z.string().optional(),
  cdpPort: z.number(),
  activeTabs: z.number(),
  connected: z.boolean(),
});

// ===========================================================================
// --- workspace-handlers.ts ---
// ===========================================================================

/**
 * `workspace.status` — return the WorkspaceStatus for an agent's
 * workspace directory (existence, file presence list, git-repo flag,
 * bootstrap-state flag, optional state snapshot). RPC scope.
 *
 * Request: `{ agentId }`. The bespoke guard at workspace-handlers.ts:52-58
 * produces "Missing required parameter: agentId" / "Agent not found".
 *
 * Response: D-05 loose record. The underlying `WorkspaceStatus` shape
 * (`@comis/core/workspace/workspace-manager.ts:75-84`) carries 6 fields
 * including a nested optional `state` block; modeling tighter would pin
 * the WorkspaceState wire format across daemon restarts.
 */
export const WorkspaceStatusContract = defineContract({
  method: "workspace.status",
  request: z.object({
    agentId: z.string().min(1),
  }),
  response: LooseRecord,
  scopes: ["rpc"] as const,
});

/**
 * `workspace.readFile` — read a file from the agent's workspace,
 * cap-enforced (1 MiB). RPC scope. The bespoke guard at
 * workspace-handlers.ts:168-170 produces "Missing required parameter:
 * filePath"; `safePath(...)` rejects path traversal.
 *
 * Response: `{ content: string, sizeBytes: number }`.
 */
export const WorkspaceReadFileContract = defineContract({
  method: "workspace.readFile",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
  }),
  response: z.object({
    content: z.string(),
    sizeBytes: z.number(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.writeFile` — write a file within the agent's workspace,
 * cap-enforced (512 KiB). ADMIN scope. The bespoke guards
 * (workspace-handlers.ts:191-203) produce operator-friendly errors;
 * `safePath(...)` rejects path traversal.
 *
 * Response: `{ written: true, sizeBytes: number }`.
 */
export const WorkspaceWriteFileContract = defineContract({
  method: "workspace.writeFile",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
    content: z.string(),
  }),
  response: z.object({
    written: z.literal(true),
    sizeBytes: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.deleteFile` — delete a file from the workspace. Triggers
 * a best-effort memory cleanup pass to remove stale entries that
 * referenced the deleted file. ADMIN scope.
 *
 * Response: `{ deleted: true }`.
 */
export const WorkspaceDeleteFileContract = defineContract({
  method: "workspace.deleteFile",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
  }),
  response: z.object({
    deleted: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.listDir` — list entries within the workspace root OR a
 * named subdirectory (allowlisted via WORKSPACE_SUBDIRS). RPC scope.
 *
 * Request: `{ agentId, subdir? }`. When `subdir` is absent or empty
 * the handler lists the root workspace dir.
 *
 * Response: `{ entries: WorkspaceListEntry[] }`.
 */
export const WorkspaceListDirContract = defineContract({
  method: "workspace.listDir",
  request: z.object({
    agentId: z.string().min(1),
    subdir: z.string().optional(),
  }),
  response: z.object({
    entries: z.array(WorkspaceListEntrySchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.resetFile` — restore a workspace template file to its
 * default content. ADMIN scope. `fileName` must be in
 * `WORKSPACE_FILE_NAMES` (BOOTSTRAP.md, CLAUDE.md, etc.).
 *
 * Response: `{ reset: true, fileName }`.
 */
export const WorkspaceResetFileContract = defineContract({
  method: "workspace.resetFile",
  request: z.object({
    agentId: z.string().min(1),
    fileName: z.string().min(1),
  }),
  response: z.object({
    reset: z.literal(true),
    fileName: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.init` — ensure the workspace directory tree exists and
 * is populated with default templates. ADMIN scope. Idempotent
 * (write-if-missing semantics).
 *
 * Response: `{ initialized: true, dir }`.
 */
export const WorkspaceInitContract = defineContract({
  method: "workspace.init",
  request: z.object({
    agentId: z.string().min(1),
  }),
  response: z.object({
    initialized: z.literal(true),
    dir: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `workspace.git.status` — branch + porcelain status list for the
 * workspace's git repo. RPC scope. Requires `.git/` to exist
 * (assertGitRepo at workspace-handlers.ts:82-87).
 *
 * Response: `{ branch, clean, entries[] }`. `branch` is the current
 * branch name OR `"HEAD (detached)"` when not on a branch.
 */
export const WorkspaceGitStatusContract = defineContract({
  method: "workspace.git.status",
  request: z.object({
    agentId: z.string().min(1),
  }),
  response: z.object({
    branch: z.string(),
    clean: z.boolean(),
    entries: z.array(WorkspaceGitStatusEntrySchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.git.log` — git log of the workspace repo, capped at 200
 * commits, default 50. RPC scope. Returns `{ commits: [] }` when the
 * repo has no commits (graceful, handler:378-380).
 *
 * Response: `{ commits: WorkspaceGitCommit[] }`.
 */
export const WorkspaceGitLogContract = defineContract({
  method: "workspace.git.log",
  request: z.object({
    agentId: z.string().min(1),
    limit: z.number().optional(),
  }),
  response: z.object({
    commits: z.array(WorkspaceGitCommitSchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.git.diff` — git diff of the workspace working tree
 * (optionally scoped to a file path). Output capped at 512 KiB; a
 * truncation banner is appended when the diff exceeds the cap. RPC
 * scope.
 *
 * Response: `{ diff: string }`.
 */
export const WorkspaceGitDiffContract = defineContract({
  method: "workspace.git.diff",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().optional(),
  }),
  response: z.object({
    diff: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `workspace.git.commit` — stage + commit changes in the workspace
 * repo. ADMIN scope. `message` is sanitized (control chars stripped,
 * truncated to 500 chars). When `paths` is omitted, stages everything
 * with `git add -A`. Throws "Nothing to commit" when the working tree
 * is clean.
 *
 * Response: `{ sha, author, date, message }`.
 */
export const WorkspaceGitCommitContract = defineContract({
  method: "workspace.git.commit",
  request: z.object({
    agentId: z.string().min(1),
    message: z.string().optional(),
    paths: z.array(z.string()).optional(),
  }),
  response: WorkspaceGitCommitSchema,
  scopes: ["admin"] as const,
});

/**
 * `workspace.git.restore` — restore a file to its HEAD-committed
 * version. ADMIN scope. Throws "File has no committed version" when
 * the file is not tracked.
 *
 * Response: `{ restored: true }`.
 */
export const WorkspaceGitRestoreContract = defineContract({
  method: "workspace.git.restore",
  request: z.object({
    agentId: z.string().min(1),
    filePath: z.string().min(1),
  }),
  response: z.object({
    restored: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- browser-handlers.ts ---
// ===========================================================================

/**
 * `browser.status` — query the browser service status (running flag,
 * chrome version, CDP port, active tab count, connection state). RPC
 * scope. Read-only.
 *
 * Request: `{}` (no params). The handler resolves `_agentId` from the
 * dispatcher-injected internals and routes via `getAgentBrowserService`.
 *
 * Response: `BrowserStatus` shape.
 */
export const BrowserStatusContract = defineContract({
  method: "browser.status",
  request: z.object({}),
  response: BrowserStatusSchema,
  scopes: ["rpc"] as const,
});

/**
 * `browser.start` — launch the per-agent Chrome instance and connect
 * Playwright via CDP. RPC scope. Idempotent (returns success when
 * already running).
 *
 * Response: `{ started: true }`.
 */
export const BrowserStartContract = defineContract({
  method: "browser.start",
  request: z.object({}),
  response: z.object({
    started: z.literal(true),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.stop` — disconnect Playwright and stop the Chrome instance.
 * RPC scope. Idempotent.
 *
 * Response: `{ stopped: true }`.
 */
export const BrowserStopContract = defineContract({
  method: "browser.stop",
  request: z.object({}),
  response: z.object({
    stopped: z.literal(true),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.navigate` — navigate the current (or specified) tab to a
 * URL. RPC scope. The handler passes `{ url, targetId? }` to the
 * BrowserService; the service-layer enforces ALLOWED_NAV_PROTOCOLS
 * (http: / https: / about:).
 *
 * Plan-vs-reality (Rule 1): the handler reads `params.targetUrl` (NOT
 * `params.url`) — the dispatcher accepts the agent-tool param name
 * `targetUrl` and forwards it through. Contract models the
 * handler-read name verbatim per D-08.
 *
 * Response: `NavigateResult = { url, title, targetId: string | null }`.
 * `targetId` is nullable (the underlying playwright session may not
 * have a stable id for the new page).
 */
export const BrowserNavigateContract = defineContract({
  method: "browser.navigate",
  request: z.object({
    targetUrl: z.string().min(1),
    targetId: z.string().optional(),
  }),
  response: z.object({
    url: z.string(),
    title: z.string(),
    targetId: z.string().nullable(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.snapshot` — accessibility-tree snapshot of the current or
 * specified tab. RPC scope. Several optional knobs control snapshot
 * shape (interactive-only, max-depth, compact filter, CSS selector
 * scope, max-chars cap).
 *
 * Response: D-05 loose record. The underlying `SnapshotResult`
 * (`packages/skills/src/tools/browser/playwright-snapshots.ts:49-56`)
 * carries `refs: RoleRefMap` (a `Record<string, unknown>` of role→ref
 * mappings) plus `stats: { lines, chars, refs, interactive }`. Tight
 * modeling would force every RoleRefMap value-shape into the wire
 * contract.
 */
export const BrowserSnapshotContract = defineContract({
  method: "browser.snapshot",
  request: z.object({
    targetId: z.string().optional(),
    interactive: z.boolean().optional(),
    depth: z.number().optional(),
    compact: z.boolean().optional(),
    selector: z.string().optional(),
    maxChars: z.number().optional(),
  }),
  response: LooseRecord,
  scopes: ["rpc"] as const,
});

/**
 * `browser.screenshot` — capture a screenshot of the current or
 * specified tab. RPC scope. The handler base64-encodes the buffer
 * before returning (browser-handlers.ts:82). Optional `fullPage`,
 * `ref`/`element` (snapshot-ref-scoped capture), and `type` (png |
 * jpeg) knobs.
 *
 * Response: `{ base64: string, mimeType: string }`.
 */
export const BrowserScreenshotContract = defineContract({
  method: "browser.screenshot",
  request: z.object({
    targetId: z.string().optional(),
    fullPage: z.boolean().optional(),
    ref: z.string().optional(),
    element: z.string().optional(),
    type: z.enum(["png", "jpeg"]).optional(),
  }),
  response: z.object({
    base64: z.string(),
    mimeType: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.pdf` — render the current or specified tab to PDF. RPC
 * scope. Base64-encoded buffer return.
 *
 * Response: `{ base64: string, mimeType: string }`.
 */
export const BrowserPdfContract = defineContract({
  method: "browser.pdf",
  request: z.object({
    targetId: z.string().optional(),
  }),
  response: z.object({
    base64: z.string(),
    mimeType: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.act` — execute a UI action (click, type, press, hover,
 * drag, select, fill, close) on the current page. RPC scope. The
 * `request` field is a `BrowserAction` (`ActParams`) — a discriminated
 * union over the 8 action shapes whose discriminator is `action`. The
 * contract models it as a loose record per D-05 (the union is large
 * and the handler's bespoke pre-Zod guard at browser-handlers.ts:95-98
 * produces the user-facing error for missing `request`).
 *
 * Response: D-05 loose record (`ActionResult = { ok, action, error? }`
 * but the handler returns the result directly; modeling as a loose
 * record matches the snapshot-result precedent for browser handlers).
 */
export const BrowserActContract = defineContract({
  method: "browser.act",
  request: z.object({
    request: LooseRecord,
  }),
  response: LooseRecord,
  scopes: ["rpc"] as const,
});

/**
 * `browser.tabs` — list all open tabs. RPC scope. Read-only.
 *
 * Response: `{ tabs: BrowserTabInfo[] }`.
 */
export const BrowserTabsContract = defineContract({
  method: "browser.tabs",
  request: z.object({}),
  response: z.object({
    tabs: z.array(BrowserTabInfoSchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.open` — open a new tab. RPC scope. `targetUrl` defaults to
 * `"about:blank"` when omitted (browser-handlers.ts:109).
 *
 * Response: `BrowserTabInfo`.
 */
export const BrowserOpenContract = defineContract({
  method: "browser.open",
  request: z.object({
    targetUrl: z.string().optional(),
  }),
  response: BrowserTabInfoSchema,
  scopes: ["rpc"] as const,
});

/**
 * `browser.focus` — focus an existing tab by `targetId`. RPC scope.
 * The bespoke guard at browser-handlers.ts:117 produces "targetId is
 * required for browser.focus".
 *
 * Response: `{ focused: true, targetId }`.
 */
export const BrowserFocusContract = defineContract({
  method: "browser.focus",
  request: z.object({
    targetId: z.string().min(1),
  }),
  response: z.object({
    focused: z.literal(true),
    targetId: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.close` — close a tab (specified by `targetId`, or the
 * active tab when omitted). RPC scope.
 *
 * Response: `{ closed: true }`.
 */
export const BrowserCloseContract = defineContract({
  method: "browser.close",
  request: z.object({
    targetId: z.string().optional(),
  }),
  response: z.object({
    closed: z.literal(true),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.console` — read console messages from the current or
 * specified tab. RPC scope. Optional `level` filter.
 *
 * Response: `{ messages: ConsoleEntry[] }`. D-05 loose-record for the
 * entry shape — `BrowserConsoleMessage` carries a `location` block
 * with file/line/column nested fields that we don't pin in the wire
 * contract.
 */
export const BrowserConsoleContract = defineContract({
  method: "browser.console",
  request: z.object({
    level: z.string().optional(),
    targetId: z.string().optional(),
  }),
  response: z.object({
    messages: z.array(LooseRecord),
  }),
  scopes: ["rpc"] as const,
});

// ===========================================================================
// --- approval-handlers.ts ---
// ===========================================================================

/**
 * Approval-request projection for the `admin.approval.pending` listing.
 * D-05 loose record — the server-side `ApprovalRequest` schema uses
 * `z.strictObject` plus `z.string().uuid()` refinement which is OUTSIDE
 * the 12-shape allowlist. Modeling each pending request as a loose
 * record preserves the wire shape (the gate emits the full
 * ApprovalRequest object) without dragging refinements into the
 * contract surface.
 */
const ApprovalRequestSchema = LooseRecord;

/**
 * `admin.approval.pending` — list all pending approval requests
 * awaiting operator decision. ADMIN scope. Read-only.
 *
 * Request: `{}` (no params).
 *
 * Response: `{ requests: ApprovalRequest[], total: number }`. The
 * handler returns `requests: deps.approvalGate.pending()` directly
 * plus a derived `total` count.
 */
export const AdminApprovalPendingContract = defineContract({
  method: "admin.approval.pending",
  request: z.object({}),
  response: z.object({
    requests: z.array(ApprovalRequestSchema),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `admin.approval.resolve` — resolve a single pending request (approve
 * or deny, with optional reason). ADMIN scope. Bespoke pre-Zod guards
 * (approval-handlers.ts:45-56) produce operator-friendly errors for
 * missing `requestId`, missing/non-boolean `approved`, and unknown
 * `requestId`.
 *
 * Request: `{ requestId, approved, approvedBy?, reason? }`.
 * `approvedBy` defaults to `"operator"` (handler:50).
 *
 * Response: `{ requestId, approved, approvedBy, reason }`. `reason` is
 * nullable (when omitted the handler passes through `null` per
 * handler:65) — modeled as `z.string().nullable()`.
 */
export const AdminApprovalResolveContract = defineContract({
  method: "admin.approval.resolve",
  request: z.object({
    requestId: z.string().min(1),
    approved: z.boolean(),
    approvedBy: z.string().optional(),
    reason: z.string().optional(),
  }),
  response: z.object({
    requestId: z.string(),
    approved: z.boolean(),
    approvedBy: z.string(),
    reason: z.string().nullable(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `admin.approval.resolveAll` — bulk-resolve all pending requests
 * (optionally filtered to a single session). ADMIN scope.
 *
 * **Plan-vs-reality (Rule 1).** Plan 35-13 inventoried 3 admin.approval
 * methods (pending, resolve, clearDenialCache); reality is 4 — the
 * handler factory at approval-handlers.ts:69-89 exposes `resolveAll`
 * which is NOT registered in setup-gateway-api.ts (the gateway router
 * only registers pending/resolve/clearDenialCache at line 199-201).
 * The bidirectional 1:1 architecture test walks handler-factory
 * PropertyAssignment keys (registration-plane-agnostic — comment
 * inside the test header lines 32-41), so a contract is MANDATORY
 * for the 1:1 mapping to pass.
 *
 * The contract scope `["admin"]` reflects the namespace prefix
 * (`admin.approval.`) — every admin.approval.* handler is admin-gated
 * by intent regardless of router registration.
 *
 * Request: `{ sessionKey?, approved, approvedBy?, reason? }`. When
 * `sessionKey` is provided, only requests with that sessionKey are
 * resolved; otherwise all pending requests are.
 *
 * Response: `{ resolved: number, requestIds: string[] }`.
 */
export const AdminApprovalResolveAllContract = defineContract({
  method: "admin.approval.resolveAll",
  request: z.object({
    sessionKey: z.string().optional(),
    approved: z.boolean(),
    approvedBy: z.string().optional(),
    reason: z.string().optional(),
  }),
  response: z.object({
    resolved: z.number(),
    requestIds: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

/**
 * `admin.approval.clearDenialCache` — clear cached denial entries
 * (optionally scoped to one sessionKey). ADMIN scope.
 *
 * Request: `{ sessionKey? }`. When absent, the entire denial cache
 * is flushed.
 *
 * Response: `{ cleared: true }`.
 */
export const AdminApprovalClearDenialCacheContract = defineContract({
  method: "admin.approval.clearDenialCache",
  request: z.object({
    sessionKey: z.string().optional(),
  }),
  response: z.object({
    cleared: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- skill-handlers.ts ---
// ===========================================================================

/**
 * PromptSkillDescription wire shape. Tight model — the source type at
 * `packages/skills/src/skills/prompt/processor.ts:19-28` is fully
 * allowlist-shaped (5 primitive fields, no nested records). The
 * `source` enum mirrors the source-tag emitted by the registry.
 */
const SkillDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  disableModelInvocation: z.boolean().optional(),
  source: z.enum(["bundled", "workspace", "local"]).optional(),
});

/**
 * Uploaded-file entry for `skills.upload`. The handler reads
 * `path: string` (relative within the skill folder) + `content: string`
 * (skill-handlers.ts:182-193).
 */
const SkillUploadFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

/**
 * Skill scope literal — `local` (agent's own workspace) or `shared`
 * (default-agent-only data-dir global skills directory). Modeled as
 * `z.enum` (allowlist).
 */
const SkillScopeSchema = z.enum(["local", "shared"]);

/**
 * `skills.list` — list prompt-skill descriptions for an agent (or the
 * default agent's registry when `agentId` is omitted). RPC scope.
 *
 * Request: `{ agentId? }`. The handler also reads `_agentId` from
 * internals as a fallback (skill-handlers.ts:96-98) — the contract
 * models only the user-facing `agentId` per D-04 (internals are
 * stripped before parse).
 *
 * Response: `{ skills: PromptSkillDescription[] }`.
 */
export const SkillsListContract = defineContract({
  method: "skills.list",
  request: z.object({
    agentId: z.string().optional(),
  }),
  response: z.object({
    skills: z.array(SkillDescriptionSchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `skills.upload` — create a skill folder from operator-uploaded
 * files. ADMIN scope (gateway router registers at line 295). Bespoke
 * guards (skill-handlers.ts:130-148) enforce name format, file count,
 * SKILL.md presence, and the shared-scope default-agent guard.
 *
 * Request: `{ name, scope?, files[], agentId? }`. `scope` defaults to
 * `"local"` when absent or invalid (skill-handlers.ts:117). `agentId`
 * falls back to `_agentId` then errors with "Agent ID is required..."
 * when both are missing.
 *
 * Response: `{ ok: true, path: string }`.
 */
export const SkillsUploadContract = defineContract({
  method: "skills.upload",
  request: z.object({
    name: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    files: z.array(SkillUploadFileSchema),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `skills.import` — import a skill from a GitHub directory URL. ADMIN
 * scope. The handler fetches the directory tree from the GitHub
 * Contents API and writes each file into the resolved skill folder.
 *
 * Request: `{ url, scope?, agentId? }`.
 *
 * Response: `{ ok: true, path, name, fileCount }`.
 */
export const SkillsImportContract = defineContract({
  method: "skills.import",
  request: z.object({
    url: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
    name: z.string(),
    fileCount: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `skills.delete` — remove a skill folder. ADMIN scope. Performs
 * scope-aware containment checks against the agent's workspace skills
 * directory + the shared skills directory (skill-handlers.ts:354-367).
 *
 * Request: `{ name, scope?, agentId? }`.
 *
 * Response: `{ ok: true }`.
 */
export const SkillsDeleteContract = defineContract({
  method: "skills.delete",
  request: z.object({
    name: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
  }),
  scopes: ["admin"] as const,
});

/**
 * `skills.create` — create a new skill from operator-supplied
 * SKILL.md content. ADMIN scope (by intent; the handler is NOT
 * registered in setup-gateway-api.ts — same registration-plane
 * exception as admin.approval.resolveAll). Bespoke guards
 * (skill-handlers.ts:399-419) enforce name format + content scan
 * (rejects CRITICAL `scanSkillContent` findings).
 *
 * **Plan-vs-reality (Rule 1).** Plan 35-13 inventoried 4 skills.*
 * methods (list, upload, import, delete); reality is 6 — the handler
 * factory adds `create` and `update` (skill-handlers.ts:387 + 462).
 * These two are NOT registered in setup-gateway-api.ts (gateway-tool /
 * agent-tool dispatch path only), but the bidirectional 1:1
 * architecture test walks handler-factory PropertyAssignment keys
 * (registration-plane-agnostic), so contracts are MANDATORY for the
 * 1:1 mapping to pass.
 *
 * Request: `{ name, content, scope?, agentId? }`.
 *
 * Response: `{ ok: true, path, name }`.
 */
export const SkillsCreateContract = defineContract({
  method: "skills.create",
  request: z.object({
    name: z.string().min(1),
    content: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    path: z.string(),
    name: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * `skills.update` — overwrite a skill's SKILL.md content. ADMIN
 * scope (by intent; same registration-plane exception as
 * `skills.create`). Re-runs the security scan before writing.
 *
 * Request: `{ name, content, scope?, agentId? }`.
 *
 * Response: `{ ok: true, name }`.
 */
export const SkillsUpdateContract = defineContract({
  method: "skills.update",
  request: z.object({
    name: z.string().min(1),
    content: z.string().min(1),
    scope: SkillScopeSchema.optional(),
    agentId: z.string().optional(),
  }),
  response: z.object({
    ok: z.literal(true),
    name: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ===========================================================================
// --- notification-handlers.ts ---
// ===========================================================================

/**
 * `notification.send` — bridge from the agent tool to the
 * NotificationService. RPC scope. The handler resolves `_agentId`
 * from internals, validates the chain-depth guard (rejects calls
 * where `origin === "notification"` to prevent recursive notification
 * chains), and maps tool-param names (`channel_type`, `channel_id`)
 * to NotifyUserOptions (`channelType`, `channelId`).
 *
 * Request: `{ message, priority?, channel_type?, channel_id?, origin? }`.
 * The contract uses the snake_case names the handler reads
 * (notification-handlers.ts:65-66 — `channel_type` / `channel_id`)
 * because tools call into the daemon with snake_case keys; the
 * handler is responsible for the camelCase mapping at the service
 * boundary. `priority` is `z.enum(["low","normal","high","critical"])`
 * — the handler casts directly without validation, but the enum here
 * documents the intended set + lets the dev-mode response parse catch
 * future drift.
 *
 * Response: `{ success: boolean, entryId?: string, error?: string }`
 * — modeled as a union of the success shape and the error shape via
 * separate optional fields so it stays inside the 12-shape allowlist.
 * The handler returns one of:
 *   - `{ success: true, entryId }` on `notifyUser` returning `ok`.
 *   - `{ success: false, error }` on missing `message`, on the
 *     chain-depth guard, or on `notifyUser` returning `err`.
 */
export const NotificationSendContract = defineContract({
  method: "notification.send",
  request: z.object({
    message: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    channel_type: z.string().optional(),
    channel_id: z.string().optional(),
    origin: z.string().optional(),
  }),
  response: z.object({
    success: z.boolean(),
    entryId: z.string().optional(),
    error: z.string().optional(),
  }),
  scopes: ["rpc"] as const,
});

// ===========================================================================
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ===========================================================================

/**
 * Workspace-umbrella contract array. Plan 35-13 Task 1 initialized this
 * with 25 contracts (workspace 12 + browser 13). Plan 35-13 Task 2
 * (this commit) APPENDED 11 more (approval 4 + skill 6 + notification 1)
 * to reach 36 total. Plan 35-19 (Wave C closure) supersedes the
 * placeholder aggregation in `index.ts` with the final alphabetical
 * aggregation across all 14 domains — this array remains unchanged.
 *
 * Order: grouped by handler-file in the order they appear in this file,
 * with method-order within each block matching the handler-factory's
 * PropertyAssignment order. The bidirectional 1:1 architecture test
 * treats this array as an unordered set, so ordering is documentation
 * only.
 */
export const WORKSPACE_CONTRACTS = [
  // workspace-handlers.ts (12 methods):
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
  // browser-handlers.ts (13 methods):
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
  // approval-handlers.ts (4 methods):
  AdminApprovalPendingContract,
  AdminApprovalResolveContract,
  AdminApprovalResolveAllContract,
  AdminApprovalClearDenialCacheContract,
  // skill-handlers.ts (6 methods):
  SkillsListContract,
  SkillsUploadContract,
  SkillsImportContract,
  SkillsDeleteContract,
  SkillsCreateContract,
  SkillsUpdateContract,
  // notification-handlers.ts (1 method):
  NotificationSendContract,
] as const;
