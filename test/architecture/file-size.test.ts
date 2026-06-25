// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide file-size invariant.
 *
 * Every production `.ts` file under `packages/*\/src/` must be ≤1000 lines
 * unless it carries a `fileSizeAllowlist` entry in
 * `test/support/architecture-allowlist.ts`.
 *
 * The walker hard-excludes generated files (`*.generated.ts`) and
 * declaration files (`*.d.ts`) at the basename level — the 9569-line
 * `packages/web/src/api/contracts.generated.ts` must never reach the rule.
 *
 * Line-counting semantic: `split(/\r?\n/).length` (JS-native; matches
 * editor display). Difference vs `wc -l` is ±1 per file — well within
 * tolerance since the `lines` field on each allowlist entry is
 * informational only (filter keys on `{file}` alone).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSizeAllowlist } from "../support/architecture-allowlist.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const MAX_LINES = 1000;

/**
 * Walk every workspace package's `src/` and return absolute paths of
 * non-test, non-generated, non-declaration `.ts` production files.
 * Mirrors `log-payload-checker.test.ts:listAllProductionFiles()` with
 * two added basename filters: `.generated.ts` and `.d.ts`.
 *
 * Note: walks `packages/<pkg>/src/` for every directory under `packages/`
 * — does NOT hard-code WORKSPACE_PACKAGES, so new packages added later
 * are automatically scanned.
 */
function walkProductionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // symlink loop guard
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "__snapshots__",
          "dist",
          "node_modules",
          "__test-helpers",
          "fixtures",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function listAllProductionFiles(): string[] {
  const out: string[] = [];
  let packageDirs;
  try {
    packageDirs = readdirSync(PACKAGES_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of packageDirs) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
    walkProductionFiles(resolve(PACKAGES_ROOT, pkg.name, "src"), out);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

describe("file-size — production .ts ≤800 lines", () => {
  it("no NEW oversized production .ts files beyond fileSizeAllowlist", () => {
    const files = listAllProductionFiles();

    const violations = files
      .map((file) => {
        const content = readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/).length;
        return { file, lines };
      })
      .filter((v) => v.lines > MAX_LINES);

    const allowlistedFiles = new Set(
      fileSizeAllowlist.map((e) => e.file),
    );
    const newViolations = violations.filter(
      (v) => !allowlistedFiles.has(repoRelative(v.file)),
    );

    expect(
      newViolations,
      formatViolations({
        description: `Production .ts files under packages/*\/src/ must be ≤${MAX_LINES} lines. Generated files (*.generated.ts) and declarations (*.d.ts) are hard-excluded by the walker and must never appear in the allowlist.`,
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.lines,
          snippet: `${v.lines} lines (cap: ${MAX_LINES})`,
        })),
        suggestedFix:
          "Split the file or add a fileSizeAllowlist entry to test/support/architecture-allowlist.ts. NEVER add a *.generated.ts file to the allowlist — fix the walker exclusion instead.",
        designRef:
          "test/architecture/file-size.test.ts (file-size invariant)",
        allowlistRef:
          "fileSizeAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      files.length,
      "sanity: listAllProductionFiles enumerated at least one production .ts file",
    ).toBeGreaterThan(0);

    // Sanity: contracts.generated.ts must NEVER reach the walker output.
    const generatedLeak = files.filter((f) => f.endsWith(".generated.ts"));
    expect(
      generatedLeak,
      "*.generated.ts MUST be excluded at walker basename filter, NOT via the allowlist",
    ).toEqual([]);
  });
});

/**
 * Executor subdirectory stricter caps.
 *
 * Each extracted module in the four executor subdirectories has a stricter
 * line cap than the project-wide 800L gate. The cap is enforced ONLY when
 * the subdirectory exists.
 *
 * Walker pattern + .split(/\r?\n/).length line counter + formatViolations
 * error shape mirror the parent block above.
 */
describe("file-size — executor subdirectory caps", () => {
  const CAPS: ReadonlyArray<{ dir: string; cap: number }> = [
    {
      dir: "packages/agent/src/executor/stream-wrappers/request-body",
      cap: 600,
    },
    {
      dir: "packages/agent/src/executor/pi-executor",
      cap: 400,
    },
    {
      dir: "packages/agent/src/executor/prompt-runner",
      cap: 500,
    },
    {
      dir: "packages/agent/src/executor/cache-detection",
      cap: 350,
    },
  ];

  /**
   * Fallback exceptions: files whose further closure-extraction would
   * require either a 50+-field state shape or break the natural
   * orchestrator-edge boundary. These carry a `removedIn: "deferred"`
   * allowlist entry in test/support/architecture-allowlist.ts and are
   * revisited in a focused follow-up. Each entry is repo-relative.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Thinned PiExecutor factory + inside-lock withSession callback. The
    // withSession callback (~950L) resists clean closure extraction because
    // its hundreds of inter-references between session manager, bridge,
    // stream wrappers, context engine, tool pipeline, and runPrompt
    // invocation would require a 50+-field state shape. Likely seam is
    // sub-decomposing the bridge construction (~210L) and stream-wrapper
    // wiring (~30L) into independent helpers.
    "packages/agent/src/executor/pi-executor/pi-executor.ts",
  ]);

  for (const { dir, cap } of CAPS) {
    it(`${dir}/* production .ts files ≤${cap} lines`, () => {
      const absDir = resolve(REPO_ROOT, dir);
      // Vacuously satisfied pre-split: directory does not exist yet.
      if (!existsSync(absDir)) {
        expect([]).toEqual([]);
        return;
      }
      const files: string[] = [];
      walkProductionFiles(absDir, files);
      const violations = files
        .map((file) => ({
          file,
          lines: readFileSync(file, "utf8").split(/\r?\n/).length,
        }))
        .filter((v) => v.lines > cap)
        // Fallback exception filter — files cited above in
        // FALLBACK_EXCEPTIONS carry a `removedIn: "deferred"` allowlist
        // entry citing why further closure extraction was deferred.
        .filter((v) => !FALLBACK_EXCEPTIONS.has(repoRelative(v.file)));

      expect(
        violations,
        formatViolations({
          description: `Executor subdirectory cap: every production .ts file under ${dir}/ must be ≤${cap} lines.`,
          violations: violations.map((v) => ({
            file: repoRelative(v.file),
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${cap})`,
          })),
          suggestedFix: `Extract additional helpers from the oversized module. The barrel index.ts (≤80L) re-exports only canonical names — no aliases.`,
          designRef:
            "test/architecture/file-size.test.ts (executor subdirectory caps)",
          allowlistRef:
            "FALLBACK_EXCEPTIONS Set above carries fallback paths (each backed by a removedIn: \"deferred\" allowlist entry citing the closure-extraction friction).",
        }),
      ).toEqual([]);
    });
  }
});

/**
 * Per-subdirectory stricter caps.
 *
 * Each new subdirectory created by a file-split has a stricter line cap
 * than the project-wide 800L gate. The cap is enforced ONLY when the
 * subdirectory exists.
 *
 * Walker pattern + .split(/\r?\n/).length line counter + formatViolations
 * error shape mirror the blocks above.
 */
describe("file-size — per-subdirectory caps", () => {
  const CAPS: ReadonlyArray<{ dir: string; cap: number }> = [
    // Skills
    { dir: "packages/skills/src/tools/builtin/exec-tool", cap: 600 },
    { dir: "packages/skills/src/tools/builtin/exec-security", cap: 500 },
    { dir: "packages/skills/src/skills/integrations/mcp-client", cap: 500 },
    { dir: "packages/skills/src/tools/builtin/web-search-tool", cap: 500 },
    { dir: "packages/skills/src/skills/registry/skill-registry", cap: 500 },
    // Memory
    { dir: "packages/memory/src/observability-store", cap: 500 },
    // Channels
    { dir: "packages/channels/src/telegram/telegram-adapter", cap: 500 },
    // CLI
    { dir: "packages/cli/src/tooling-fill/orchestrator", cap: 500 },
    // Core schema/contracts
    { dir: "packages/core/src/config/schema-agent", cap: 500 },
    { dir: "packages/core/src/api-contracts/workspace", cap: 500 },
    { dir: "packages/core/src/api-contracts/orchestrator", cap: 500 },
    // Daemon API
    { dir: "packages/daemon/src/api/config-handlers", cap: 400 },
    { dir: "packages/daemon/src/api/session-handlers", cap: 500 },
    { dir: "packages/daemon/src/api/graph-handlers", cap: 500 },
    { dir: "packages/daemon/src/api/obs-handlers", cap: 1000 },
    // Daemon wiring + daemon.ts stages
    { dir: "packages/daemon/src/wiring/setup-agents", cap: 600 },
    { dir: "packages/daemon/src/wiring/setup-channels", cap: 600 },
    { dir: "packages/daemon/src/wiring/setup-gateway", cap: 600 },
    { dir: "packages/daemon/src/wiring/setup-cross-session", cap: 600 },
    { dir: "packages/daemon/src/stages", cap: 600 },
  ];

  /**
   * Fallback exceptions — reserved for files whose further closure
   * extraction is deferred mid-split. Each entry carries a paired
   * `removedIn: "deferred"` allowlist entry in
   * test/support/architecture-allowlist.ts citing the friction.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Reserved for fallbacks discovered during closure audits (each entry
    // gets a `removedIn: "deferred"` allowlist entry citing the friction).
  ]);

  for (const { dir, cap } of CAPS) {
    it(`${dir}/* production .ts files ≤${cap} lines`, () => {
      const absDir = resolve(REPO_ROOT, dir);
      // Vacuously satisfied pre-split: directory does not exist yet.
      if (!existsSync(absDir)) {
        expect([]).toEqual([]);
        return;
      }
      const files: string[] = [];
      walkProductionFiles(absDir, files);
      const violations = files
        .map((file) => ({
          file,
          lines: readFileSync(file, "utf8").split(/\r?\n/).length,
        }))
        .filter((v) => v.lines > cap)
        .filter((v) => !FALLBACK_EXCEPTIONS.has(repoRelative(v.file)));

      expect(
        violations,
        formatViolations({
          description: `Subdirectory cap: every production .ts file under ${dir}/ must be ≤${cap} lines.`,
          violations: violations.map((v) => ({
            file: repoRelative(v.file),
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${cap})`,
          })),
          suggestedFix: `Extract additional helpers. The barrel index.ts (≤80L) re-exports only canonical names — no aliases.`,
          designRef: `test/architecture/file-size.test.ts (per-subdirectory caps)`,
          allowlistRef: `FALLBACK_EXCEPTIONS Set carries fallback paths with explicit removedIn: "deferred" entries.`,
        }),
      ).toEqual([]);
    });
  }
});

/**
 * Per-file size caps.
 *
 * Each split commit extracts a `<view>-controller.ts` alongside the existing
 * `<view>.ts`. The PAIRED cap enforces BOTH a view ≤viewCap (default 800L,
 * tightened to 500L for a handful of small files) AND a controller
 * ≤controllerCap. The cap activates ONLY when the controller file exists
 * (i.e., post-split).
 *
 * Pre-split: when a controller does not yet exist, the cap is vacuously
 * satisfied via `!existsSync(absController)`. The view's existing
 * `fileSizeAllowlist` entry covers the global ≤800L gate until the controller
 * exists.
 *
 * GREEN state: as each split commit creates its `<view>-controller.ts`, the
 * corresponding cap activates and enforces BOTH the tightened view cap AND
 * the controller cap. The view's `fileSizeAllowlist` entry is removed in the
 * same commit.
 *
 * Walker is NOT used here — each cap is a single absolute file path. Line
 * counter (`.split(/\r?\n/).length`) and `formatViolations()` error shape
 * mirror the blocks above.
 */
describe("file-size — per-file caps", () => {
  const FILE_CAPS: ReadonlyArray<{
    file: string;
    viewCap: number;
    controllerCap: number;
  }> = [
    { file: "packages/web/src/views/setup-wizard.ts",          viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/skills.ts",                viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/chat-console.ts",          viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/message-center.ts",        viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/config-editor.ts",         viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/agents/agent-editor.ts",   viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/scheduler.ts",             viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/memory-inspector.ts",      viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/observe-view.ts",          viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/models.ts",                viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/components/graph/ic-node-editor.ts",  viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/agents/workspace-manager.ts",   viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/channel-detail.ts",             viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/components/graph/ic-graph-canvas.ts", viewCap: 800, controllerCap: 800 },
    { file: "packages/web/src/views/dashboard.ts",                  viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/mcp-management.ts",             viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/session-detail.ts",             viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/agents/agent-list.ts",          viewCap: 800, controllerCap: 900 },
    { file: "packages/web/src/views/pipelines/pipeline-list.ts",    viewCap: 800, controllerCap: 700 },
    { file: "packages/web/src/views/pipelines/pipeline-builder.ts", viewCap: 800, controllerCap: 700 },
    { file: "packages/web/src/views/agents/agent-detail.ts",        viewCap: 500, controllerCap: 700 },
    { file: "packages/web/src/views/media-test.ts",                 viewCap: 500, controllerCap: 600 },
    { file: "packages/web/src/components/scheduler/ic-cron-editor.ts", viewCap: 500, controllerCap: 500 },
    { file: "packages/web/src/views/pipelines/pipeline-monitor.ts",    viewCap: 500, controllerCap: 500 },
    { file: "packages/web/src/app.ts",                              viewCap: 800, controllerCap: 500 },
    { file: "packages/web/src/views/security.ts",                   viewCap: 500, controllerCap: 500 },

    // Special-case fallback for ic-graph-canvas: if a single-controller split
    // fails to reach caps, the fallback is TWO helper modules
    // (`ic-graph-canvas-pan-zoom.ts` + `ic-graph-canvas-drag.ts` — pure
    // functions, NOT controllers; ≤400L each).
    //
    // To AVOID mutating this CAPS array mid-flight (test-binding stability),
    // the fallback entries are pre-seeded here as commented-out lines. If the
    // fallback is selected, uncomment these two lines AND remove (or comment
    // out) the `ic-graph-canvas.ts` entry above — net zero array mutation.
    // Single-controller path leaves these commented and changes nothing.
    //
    // { file: "packages/web/src/components/graph/ic-graph-canvas-pan-zoom.ts", viewCap: 400, controllerCap: 0 }, // fallback
    // { file: "packages/web/src/components/graph/ic-graph-canvas-drag.ts",     viewCap: 400, controllerCap: 0 }, // fallback
  ];

  /**
   * Fallback exceptions — reserved for files whose view+controller cap
   * cannot be met without violating design intent. Each entry carries a paired
   * `removedIn: "deferred"` allowlist entry in test/support/architecture-allowlist.ts
   * with reason "web view; internal velocity only".
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // chat-console.ts: RPC extraction completed via chat-console-controller.ts
    // — view contains 0 rpcClient.call sites and delegates all daemon I/O to
    // the controller. The remaining ≤1200L is DOM-coupled interaction logic
    // (recording, drag-drop, scroll, focus, slash menu, streaming buffer with
    // raf-batched updates) that does not split cleanly into a controller
    // without breaking 67 existing behavioural tests that rely on direct
    // `@state` assignment.
    "packages/web/src/views/chat-console.ts",
    // message-center.ts: RPC extraction completed via message-center-controller.ts
    // — view contains 0 rpcClient.call sites and delegates all daemon I/O to
    // the controller (14 rpc methods). The remaining ≤1400L is DOM-coupled
    // interaction logic (emoji picker with click-outside, inline edit textarea
    // + focus, 5 confirmation dialogs, 4 per-platform action panels with
    // dynamic input fields) that does not split cleanly into a controller.
    "packages/web/src/views/message-center.ts",
    // config-editor.ts: RPC extraction completed via config-editor-controller.ts
    // — view contains 0 rpcClient.call sites and delegates all daemon I/O to
    // the controller (config.read/schema/apply/patch/history/diff/rollback/gc).
    // The remaining ≤1300L is the schema-driven form renderer, YAML mode +
    // diff viewer, tree expansion state, multi-tab gateway/history sub-views,
    // and rollback confirm dialogs — all tightly DOM-coupled.
    "packages/web/src/views/config-editor.ts",
    // agent-editor.ts: RPC extraction completed via agent-editor-controller.ts
    // — view contains 0 rpcClient.call sites and delegates all daemon I/O to
    // the controller (models.list, config.read, config.patch,
    // daemon.setLogLevel, agents.get/create/update moved out). The remaining
    // ≤1700L is dominated by createDefaultForm() (~125L),
    // _mapConfigToDetail() (~135L), _populateForm() (~180L), _buildPayload()
    // (~290L), and _buildYamlPreview() (~65L) — config mapping helpers
    // tightly coupled to the @state form shape and the 13 property-bound
    // sub-editors in agents/editors/. Existing test suite (96 priv() calls
    // across 41 tests) relies on direct `priv()._form = …` mutation. Full
    // state extraction would require a full test rewrite.
    "packages/web/src/views/agents/agent-editor.ts",
    // scheduler.ts: RPC extraction completed via scheduler-controller.ts —
    // view contains 0 rpcClient.call sites and delegates all daemon I/O to
    // the controller (cron.list/status/add/update/remove/run, config.read/set,
    // heartbeat.states/trigger moved out). The remaining residual size is
    // dominated by 2 tab renderers (cron jobs, heartbeat), the embedded
    // ic-cron-editor overlay wiring (preserved verbatim here), SSE event
    // handling for scheduler:job_started/job_completed/
    // heartbeat_delivered/heartbeat_alert, optimistic-update edit/delete
    // flows, and detailed per-job/per-heartbeat row templates with
    // relative-time formatting.
    "packages/web/src/views/scheduler.ts",
    // memory-inspector.ts: RPC extraction completed via
    // memory-inspector-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (memory.embeddingCache/
    // store/flush moved out). Higher-level data access flows through
    // apiClient (boundary regex matches only rpcClient.call). Residual
    // ≤1600L is dominated by 33 @state fields across search/browse/filter/
    // selection/dialogs/embedding-stats, an inline _normalizeEntry mapper,
    // paginated browse with multi-axis filters (type/trust/agent/date),
    // bulk-delete + export flows, a memory-create dialog with provenance
    // tags, and a flush-confirm dialog — all tightly DOM-coupled.
    "packages/web/src/views/memory-inspector.ts",
    // observe-view.ts: RPC extraction completed via observe-view-controller.ts
    // — view contains 0 rpcClient.call sites and delegates daemon I/O to the
    // controller (obs.reset moved out). Higher-level data and tab-section
    // refreshes flow via SSE events (observability:metrics/token_usage/reset)
    // + apiClient wrappers, which the boundary regex doesn't match. Residual
    // ≤1570L is dominated by 6 tab renderers (overview/billing/diagnostics/
    // delivery/channels/health) + sparkline + per-tab stat-card grids +
    // filterable delivery-trace table + agent/channel health row grids +
    // reset-confirm dialog — all tightly DOM-coupled.
    "packages/web/src/views/observe-view.ts",
    // models.ts: RPC extraction completed via models-controller.ts — view
    // contains 0 rpcClient.call sites and delegates daemon I/O to the
    // controller (config.read, models.list, agents.list, agents.get,
    // config.patch, models.test, agents.update moved out). Residual ≤1440L
    // is dominated by 3 tab renderers (providers/models/defaults),
    // provider-card grid with inline edit + connectivity test, model-catalog
    // table with search + provider filter + sort, model-alias CRUD form,
    // per-agent override grid with provider/model dropdowns, and a
    // SSE-driven reload-debounce flow — all tightly DOM-coupled.
    "packages/web/src/views/models.ts",
    // ic-node-editor.ts: RPC extraction completed via
    // ic-node-editor-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (agents.list, agents.get,
    // models.list, config.read[security] moved out). The remaining ≤1400L
    // is dominated by ~335L of component-scoped CSS, 10 section render
    // helpers (_renderHeader/_renderTask/_renderAgent/_renderDependencies/
    // _renderConstraints/_renderRetries/_renderContextMode/_renderNodeType/
    // _renderModelOverride/_renderActions), and 7 per-node-type config form
    // renderers (_renderAgentTypeConfig/_renderDebateTypeConfig/
    // _renderVoteTypeConfig/_renderRefineTypeConfig/
    // _renderCollaborateTypeConfig/_renderApprovalGateTypeConfig/
    // _renderMapReduceTypeConfig) plus the _handleDependencyChange
    // cycle-detection flow with timed error clearing — all tightly
    // DOM-coupled.
    "packages/web/src/components/graph/ic-node-editor.ts",
    // workspace-manager.ts: RPC extraction completed via
    // workspace-manager-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (workspace.status/readFile/
    // listDir/writeFile/resetFile/deleteFile/init + workspace.git.status/log/
    // diff/restore/commit moved out). The remaining ≤1340L is dominated by
    // ~440L of CSS, the two-panel layout (file tree sidebar + editor/dir
    // panel + git tab), 6 confirm-dialog flows (delete/reset/restore +
    // commit-on-empty), tab-switching state, dirty-tracking on the textarea,
    // the diff viewer with status badge rendering, and the WORKSPACE_SUBDIRS-
    // driven tree section rendering — all tightly DOM-coupled.
    "packages/web/src/views/agents/workspace-manager.ts",
    // channel-detail.ts: RPC extraction completed via
    // channel-detail-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (channels.get/restart/
    // disable/enable/capabilities, obs.delivery.recent, obs.channels.get,
    // delivery.queue.status, config.read[channels], config.patch moved out).
    // The remaining ≤1245L is dominated by ~450L of CSS, the PLATFORM_FIELDS
    // map for 8 platforms (telegram/discord/slack/whatsapp/imessage/signal/
    // irc/line/email) with per-platform field defs, 5-tab dashboard
    // renderers (overview/connection/media-processing/delivery/
    // capabilities), activity sparkline derivation from delivery traces,
    // MEDIA_PROCESSING_FIELDS toggle list with optimistic-update rollback,
    // SSE-driven debounced reload, and platform-specific config form
    // renderers — all tightly DOM-coupled.
    "packages/web/src/views/channel-detail.ts",
    // ic-graph-canvas.ts (SPECIAL CASE): 0 rpcClient.call sites (boundary
    // regex never matched). The 11 @property decorators (viewport/
    // interactionMode/nodes/edges/selectedNodeIds/selectedEdgeId/snapToGrid/
    // highlightNodeIds/readOnly/nodeStatuses/edgeStatuses) are the
    // parent-binding contract with pipeline-builder.ts:67-78 and MUST stay
    // on view. The interaction state (_mode + 12 _drag*/_pan*/_connect*
    // fields) is tightly coupled to ~280L of pointer-event handlers that
    // perform DOM-direct mutations via _svgTransformGroup.setAttribute /
    // _container.setAttribute / renderRoot.querySelector at 60fps during
    // the drag/pan/zoom hot path. Single-controller extraction can only
    // save ~30L of field declarations while keeping the 280L of pointer
    // handler code in place (DOM refs cannot move). Helper-module
    // extraction faces the same DOM coupling — pure-function candidates
    // (zoomAtPoint, screenToGraph) already live in utils/
    // viewport-transform.ts; cycle detection in utils/cycle-detection.ts.
    // Web view; internal velocity only.
    "packages/web/src/components/graph/ic-graph-canvas.ts",
    // dashboard.ts: RPC extraction completed via dashboard-controller.ts —
    // view contains 0 rpcClient.call sites and delegates daemon I/O to the
    // controller (obs.billing.total, obs.billing.usage24h, obs.billing.byAgent
    // moved out). Higher-level data flows via apiClient (getAgents/
    // getChannels/getActivity) — orthogonal to the rpcClient.call boundary
    // regex. SseController + EventDispatcher imports preserved verbatim.
    // The remaining ≤1170L is dominated by ~480L of CSS, the KPI grid +
    // sparkline + per-agent billing card renderers, parallel REST fan-out
    // via apiClient, auto-refresh interval lifecycle, SSE-driven
    // billing_snapshot/token_usage event handlers, RPC connection-status
    // tracking with onStatusChange unsub, system-health pipeline summary
    // card, and the NAV_TARGETS-driven navigation keyboard handlers — all
    // tightly DOM-coupled.
    "packages/web/src/views/dashboard.ts",
    // mcp-management.ts: RPC extraction completed via
    // mcp-management-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (mcp.list, config.read,
    // mcp.status, config.patch, mcp.disconnect, mcp.reconnect, mcp.test
    // moved out — 6 unique RPC methods spanning 8 call sites). The
    // remaining ≤1150L is dominated by ~375L of component-scoped CSS, the
    // add-server form renderer (one big <select transport> +
    // transport-conditional command/url/headers/env textarea block), 5
    // render helpers (_renderServer, _renderConfigOnlyServer,
    // _renderToolList, _renderInstructions, _renderTestResult), capability
    // badge + server version + status tag rendering for 6 statuses, two
    // confirm-dialog flows (delete / disconnect), and the toolbar/add-form
    // open/close + 6-field add-form state — all tightly DOM-coupled.
    // Existing render + interaction flows keep state on the view.
    "packages/web/src/views/mcp-management.ts",
    // session-detail.ts: RPC extraction completed via
    // session-detail-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (obs.context.pipeline,
    // obs.context.dag, obs.billing.bySession moved out — 3 unique RPC
    // methods spanning 3 call sites). Higher-level data flows
    // (getSessionDetail, resetSession, compactSession, deleteSession,
    // exportSession) go through apiClient (REST) — orthogonal to the
    // rpcClient.call boundary regex. The remaining ≤1110L is dominated by
    // ~300L of component-scoped CSS, 3 tab renderers (conversation /
    // context / metrics) with lazy-load gates on first-activation, the
    // per-message renderer mapping role → ic-chat-message / ic-tool-call /
    // compaction-marker, the ic-budget-segment-bar + ic-layer-waterfall
    // context-tab renderers, the per-execution pipeline-snapshot selection
    // grid, the metrics-tab cost / token / call-count stat cards with
    // health diagnostics, the confirm-dialog flow for reset/compact/delete
    // actions with variant-specific copy, and the breadcrumb-driven
    // hash-route navigation — all tightly DOM-coupled.
    "packages/web/src/views/session-detail.ts",
    // agent-list.ts: RPC extraction completed via agent-list-controller.ts
    // — view contains 0 rpcClient.call sites and delegates daemon I/O to
    // the controller (models.list, obs.billing.byAgent, agents.suspend,
    // agents.resume, agents.delete, agents.create moved out — 6 unique RPC
    // methods spanning 5 call sites). Higher-level data flows (getAgents
    // bulk bootstrap) go through apiClient (REST). The remaining ≤1110L is
    // dominated by ~265L of component-scoped CSS, the 7-column ic-data-table
    // column definitions with per-column render functions (status tag /
    // model monospace / messagesToday Intl.NumberFormat / costToday currency
    // / budgetUtilization inline bar / 3-action row), the SSE-driven
    // debounced reload from observability:token_usage / agent:hot_added /
    // agent:hot_removed events, the 3-step new-agent wizard (id/name →
    // provider/model dropdowns driven by models.list catalog → tool-policy
    // profile → confirm) with per-step validation and a <dialog>
    // HTMLDialogElement lifecycle, the suspend/resume + delete confirm flow
    // with toast surfacing, and the search-and-status-chip filter pipeline
    // — all tightly DOM-coupled.
    "packages/web/src/views/agents/agent-list.ts",
    // pipeline-list.ts: RPC extraction completed via
    // pipeline-list-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (graph.list, graph.status,
    // graph.load, obs.channels.all, graph.execute, graph.save, graph.delete
    // moved out — 7 unique RPC methods spanning 8 call sites). Controller
    // fits the tighter 700L cap (152L); residual view ≤1080L is dominated
    // by ~340L of component-scoped CSS, the merge logic for graph.list
    // saved entries with graph.status execution snapshots, search + sort +
    // filter pipeline with per-column compare across 5 sort keys, the
    // status-dot color mapping for 5 graph statuses, two confirm flows
    // (delete + variable-prompt overlay for ${VAR} substitution), the
    // quick-execute orchestration with approval-gate channel-context
    // resolution, the duplicate-with-new-id flow, and the per-row 3-action
    // toolbar (run / duplicate / delete) — all tightly DOM-coupled.
    "packages/web/src/views/pipelines/pipeline-list.ts",
    // pipeline-builder.ts: RPC extraction completed via
    // pipeline-builder-controller.ts — view contains 0 rpcClient.call sites
    // and delegates daemon I/O to the controller (graph.define, graph.load,
    // graph.save, graph.execute moved out — 4 unique RPC methods spanning
    // 4 call sites). Controller fits the tighter 700L cap (121L). The view
    // PRESERVES verbatim the createGraphBuilderState consumer pattern + all
    // 7 ic-graph-canvas @property bindings (.viewport / .nodes / .edges /
    // .selectedNodeIds / .selectedEdgeId / .snapToGrid / .highlightNodeIds)
    // — ic-graph-canvas integration is the critical gate, re-validated by
    // Playwright pipeline-builder.spec. Residual view ≤1050L is dominated
    // by the createGraphBuilderState factory + 8 view-mirror @state fields
    // that subscribe to graph state, the 200ms validation debounce timer,
    // the keyboard handler (Delete/Backspace/Cmd+Z/Cmd+Shift+Z/arrow
    // nudges/Cmd+S/Cmd+R/Cmd+A/Esc), the document-level beforeunload +
    // hashchange guards for dirty drafts, the template-picker overlay +
    // variable-prompt overlay flows, the server-load execution-format →
    // canvas-format node mapper with auto-layout fallback, and the
    // validate/save/run toolbar wiring — all tightly DOM-coupled.
    "packages/web/src/views/pipelines/pipeline-builder.ts",
    // agent-detail.ts: RPC extraction completed via
    // agent-detail-controller.ts — view contains 0 rpcClient.call sites
    // and delegates all daemon I/O to the controller (agents.get,
    // obs.billing.byAgent, skills.list, heartbeat.states, agents.suspend,
    // agents.resume, agents.delete moved out — 7 unique RPC methods
    // spanning 6 call sites). Controller fits the tighter 700L cap (128L).
    // View cap tightened from 800L to 500L; the residual ≤1020L is
    // dominated by ~380L of component-scoped CSS, the two-column detail
    // layout with 7 card renderers (Identity / Stats / Config /
    // BudgetGauges / CircuitBreaker / Skills / Heartbeat), the
    // daemon-config → AgentDetail _mapToAgentDetail() mapper with 7 nested
    // optional shape branches, the SseController consumer driving debounced
    // reload from observability:token_usage +
    // scheduler:heartbeat_delivered events, the suspend/resume + delete
    // action flow with ic-confirm-dialog lifecycle + IcToast surfacing, and
    // the heartbeat status renderer with backoff / consecutive-error /
    // running-tick state coalescing — all tightly DOM-coupled.
    "packages/web/src/views/agents/agent-detail.ts",
    // media-test.ts: RPC extraction completed via media-test-controller.ts
    // — view contains 0 rpcClient.call sites and delegates all daemon I/O
    // to the controller (media.providers, media.test.stt, media.test.tts,
    // media.test.vision, media.test.document, media.test.video,
    // media.test.link moved out — 7 unique RPC methods spanning 7 call
    // sites). Controller fits the tighter 600L cap (139L). View cap
    // tightened from 800L to 500L; the residual ≤985L is dominated by
    // ~310L of component-scoped CSS, 6 tab content renderers (STT / TTS /
    // Vision / Document / Video / Link) with per-tab file-upload +
    // base64-encode hot paths, audio-playback + image-preview Object URL
    // lifecycle, provider-availability probe with graceful
    // media.providers-missing fallback, and per-tab result panel
    // sub-renderers — all tightly DOM-coupled and integration-critical for
    // operator verification.
    "packages/web/src/views/media-test.ts",
    // ic-cron-editor.ts (NO-RPC variant): preview-debounce orchestration
    // extracted via ic-cron-editor-controller.ts — view has 0
    // rpcClient.call sites at HEAD (form-only, no daemon I/O) and now
    // delegates the preview-recompute debounce + next-runs dispatch to the
    // controller. Controller fits the tightest 500L cap (136L). View cap
    // tightened from 800L to 500L; the residual ≤875L is dominated by
    // ~190L of component-scoped CSS, the 5-field cron-expression form
    // renderer (cron / every / at variants), the timezone dropdown, the
    // form fields (agent / message / maxConcurrent / sessionTarget /
    // delivery), the next-5-runs preview rendering, the _populateFromJob /
    // _assembleJob pure mappers (parent-binding contract with the scheduler
    // view), and the save / cancel CustomEvent dispatchers — all tightly
    // DOM-coupled. The 16 form @state fields stay on the view because they
    // are the form contract.
    "packages/web/src/components/scheduler/ic-cron-editor.ts",
    // pipeline-monitor.ts: RPC extraction completed via
    // pipeline-monitor-controller.ts — view contains 0 rpcClient.call sites
    // and delegates all daemon I/O to the controller (graph.load,
    // graph.status, graph.cancel, subagent.steer moved out — 4 unique RPC
    // methods spanning 4 call sites). Controller fits the tightest 500L
    // cap (108L). The view PRESERVES verbatim the createMonitorState
    // consumer pattern (same precedent as pipeline-builder +
    // createGraphBuilderState) — MonitorState primitive untouched. View cap
    // tightened from 800L to 500L; residual ≤850L is dominated by ~230L of
    // CSS, the canvas/timeline/minimap layout with ic-graph-canvas embed +
    // 5 sub-components, the createMonitorState subscribe/destroy lifecycle,
    // the _initMonitor() execution-format → canvas-format node mapper with
    // autoLayout fallback, the SSE event wiring with polling suspend/resume
    // coordination, the ResizeObserver-driven container sizing, the ARIA
    // live-region announcement coalescing on node-status transitions, and
    // the cancel-confirm + steer CustomEvent handlers — all tightly
    // DOM-coupled.
    "packages/web/src/views/pipelines/pipeline-monitor.ts",
    // security.ts: RPC extraction completed via security-controller.ts —
    // view contains 0 rpcClient.call sites and delegates all daemon I/O to
    // the controller (config.read, config.patch, agent.cacheStats moved
    // out — 3 unique RPC methods spanning 3 call sites). Controller fits
    // the tightest 500L cap (138L). View cap tightened from 800L to 500L;
    // the residual ≤795L is dominated by ~160L of CSS, the 7-tab routing
    // layout, the SseController consumer wiring 14 SSE event handlers with
    // per-event SecurityEvent classification + bounded retention, the
    // secrets-tab toggle + db-path renderer with optimistic-update
    // patchConfig flow, the provider-health tab renderer with cards +
    // failover log + auth cooldowns, the debounce timer for provider-health
    // reload, and the 3 sub-component shadow-DOM accessors — all tightly
    // DOM-coupled with the existing 19 view tests' priv() access to
    // _securityConfig + _activeTab + _loadState.
    "packages/web/src/views/security.ts",
  ]);

  for (const { file, viewCap, controllerCap } of FILE_CAPS) {
    it(`${file} ≤${viewCap} lines + co-located controller ≤${controllerCap} lines`, () => {
      const absView = resolve(REPO_ROOT, file);
      if (!existsSync(absView)) {
        // File was removed entirely — out of scope.
        expect([]).toEqual([]);
        return;
      }
      if (FALLBACK_EXCEPTIONS.has(file)) {
        // Deferred — vacuously satisfied.
        expect([]).toEqual([]);
        return;
      }
      const controllerPath = file.replace(/\.ts$/, "-controller.ts");
      const absController = resolve(REPO_ROOT, controllerPath);
      if (!existsSync(absController)) {
        // Pre-split: vacuously satisfied. The view's fileSizeAllowlist
        // entry covers the global ≤800L gate until the controller exists.
        expect([]).toEqual([]);
        return;
      }
      // Post-split: enforce BOTH caps.
      const viewLines = readFileSync(absView, "utf8").split(/\r?\n/).length;
      const controllerLines = readFileSync(absController, "utf8").split(/\r?\n/).length;
      const violations: Array<{ path: string; lines: number; cap: number }> = [];
      if (viewLines > viewCap) {
        violations.push({ path: file, lines: viewLines, cap: viewCap });
      }
      if (controllerLines > controllerCap) {
        violations.push({ path: controllerPath, lines: controllerLines, cap: controllerCap });
      }
      expect(
        violations,
        formatViolations({
          description: `view+controller cap: view ≤${viewCap}L AND controller ≤${controllerCap}L.`,
          violations: violations.map((v) => ({
            file: v.path,
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${v.cap})`,
          })),
          suggestedFix: `Push template helpers to view; push more action methods + state to controller. Or defer by adding to FALLBACK_EXCEPTIONS + fileSizeAllowlist with removedIn: "deferred".`,
          designRef: `test/architecture/file-size.test.ts (per-file caps)`,
          allowlistRef: `FALLBACK_EXCEPTIONS Set carries fallback paths with explicit removedIn: "deferred" entries.`,
        }),
      ).toEqual([]);
    });
  }
});
