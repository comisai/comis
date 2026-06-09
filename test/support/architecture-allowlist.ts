// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture-test allowlist for the `@comis/*` monorepo.
 *
 * Each entry corresponds to a known source/boundary violation. The allowlist
 * is SHRINK-ONLY: removing entries is encouraged; adding entries is
 * forbidden. `allowlist-shrink.test.ts` gates this programmatically via a
 * base..head git-ref comparison.
 *
 * The `removedIn` template-literal type forces a compile error if a
 * stale reference is left behind. This is load-bearing -- do NOT loosen
 * the type to `string`.
 *
 * Current state: the ALLOWLIST array is the EMPTY closed set. Every
 * historically-seeded violation has been closed; reintroducing a
 * non-empty allowlist requires a fresh L-ID and a corresponding
 * test/architecture/allowlist-shrink.test.ts shrink violation
 * (the shrink-only gate is forward-only).
 *
 * @module
 */

/**
 * One allowlist entry. Every field is required and immutable. Stale
 * refs in `removedIn` fail tsc; missing fields fail tsc.
 */
export interface AllowlistEntry {
  readonly id: `L${number}`;
  readonly area: string;
  readonly reason: string;
  readonly removedIn: `phase-${number}` | "permanent";
  readonly evidence: readonly string[];
}

/**
 * Re-extending this array (adding entries that did not exist on
 * `origin/main`) is rejected by the shrink-test gate. Removing entries
 * is encouraged and is the normal way violations close.
 */
export const ALLOWLIST: readonly AllowlistEntry[] = [
  // Every historically-seeded violation has closed. The empty closed
  // set is forward-only: any new L-violation requires a fresh L-ID and
  // an explicit shrink-test allowance.
] as const;

// ============================================================================
// Code-Quality Allowlist Schema
// ============================================================================

/**
 * Letter-tagged code-quality phase identifiers, distinct from
 * `AllowlistEntry.removedIn` (which uses numeric phases). This union
 * exists because the template-literal type `'phase-${number}'`
 * structurally rejects letter-tagged phases at type-check time — a stale
 * `removedIn: "phase-Z"` fails `tsc --noEmit`.
 *
 * "deferred" indicates an entry deliberately taken out of the closure
 * path. Valid terminal state, not a temporary tag.
 */
export type CodeQualityPhase =
  | "phase-A"
  | "phase-B"
  | "phase-C"
  | "phase-D"
  | "phase-E"
  | "phase-F"
  | "phase-G"
  | "phase-H"
  | "deferred";

/** File-size violation: file exceeds 800-line cap. Closed by file splits. */
export interface FileSizeAllowlistEntry {
  readonly file: string; // path relative to repo root
  readonly lines: number; // line count at allowlist-creation date (informational)
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/** Raw-throw violation: `throw new Error(...)` / `throw err;` outside boundary modules. */
export interface RawThrowAllowlistEntry {
  readonly file: string;
  readonly lineRanges: ReadonlyArray<readonly [number, number]>; // tolerant of ±1 line drift
  readonly reason: string;
  readonly removedIn: CodeQualityPhase | "permanent"; // "permanent" reserved for @allow-throw boundary adapters
}

/** Untyped SQLite cast: `.all(...) as Type[]` or `.get(...) as Type` outside the row-mapper module. */
export interface UntypedSqliteAllowlistEntry {
  readonly file: string;
  readonly symbol: string; // e.g., "TokenUsageDbRow"
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/** Optional-field bloat: interface/type literal with >12 optional fields lacking an audit-stamp. */
export interface OptionalFieldAllowlistEntry {
  readonly file: string;
  readonly typeName: string;
  readonly optionalCount: number;
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/** Direct global call outside sanctioned bootstrap/runtime adapter roots. */
export interface GlobalsAllowlistEntry {
  readonly file: string;
  readonly line: number;
  readonly global:
    | "Date.now"
    | "new Date"
    | "process.env"
    | "setTimeout"
    | "setInterval"
    | "clearTimeout"
    | "clearInterval";
  readonly reason: string;
  readonly removedIn: CodeQualityPhase;
}

/**
 * Production-source historical-reference markers permitted to mention
 * compatibility / legacy text. Permanent — no removedIn field.
 * Maximum 2-3 entries.
 */
export interface NoBackwardCompatAllowlistEntry {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * Files genuinely test-impractical. Permanent — no removedIn field.
 * Entries cite a permanent reason.
 */
export interface CoverageWaiverEntry {
  readonly file: string;
  readonly reason: string;
}

/**
 * Per-(file,line) exemption from the test-naming gate's predicate 2
 * (≥20 chars) and predicate 3 (use-case shape). Captures the current
 * state of legacy short descriptions and heuristic-misclassified noun
 * phrases. Each entry MUST cite the concrete violation (min-length or
 * shape) + a deferral target. The shrink-only ratchet
 * (allowlist-shrink.test.ts) enforces this list SHRINKS over time —
 * future work removes entries by renaming legacy descriptions to
 * verbose use-case statements (predicate 2) or by extending VERB_FORMS /
 * heuristic regex (predicate 3).
 */
export interface TestNamingAllowlistEntry {
  readonly file: string;
  readonly line: number;
  readonly kind: "describe" | "it" | "test";
  readonly text: string;
  readonly reason: string;
}

/**
 * The 7 code-quality allowlists: fileSizeAllowlist, optionalFieldAllowlist,
 * untypedSqliteAllowlist, rawThrowAllowlist, globalsAllowlist,
 * noBackwardCompatAllowlist, and coverageWaiver.
 *
 * Shrink-only ratchet: test/architecture/allowlist-shrink.test.ts covers
 * all arrays and compares base..head, rejecting any entry addition.
 */
export const fileSizeAllowlist: readonly FileSizeAllowlistEntry[] = [
  // ============================================================================
  // Web view + component decomposition (26 files)
  // ============================================================================
  {
    file: "packages/web/src/views/chat-console.ts",
    lines: 1163,
    reason: "Lit web view; ~9 rpcClient.call sites inlined (formerly via chat-console-controller.ts before inlining; session.list / session.history / obs.context.pipeline / audio.transcribe / session.reset / session.export / session.compact). Residual DOM-coupled interaction logic (recording, drag-drop, scroll/focus, slash menu, raf-batched streaming) does not split into a controller without breaking 67 existing @state-driven tests.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/message-center.ts",
    lines: 1338,
    reason: "Lit web view; 14 rpcClient.call sites inlined (formerly via message-center-controller.ts before inlining; channels.list / channels.capabilities / channels.get / obs.channels.all / message.fetch / session.list / session.history / message.{send,reply,edit,delete,react,attach} / per-platform action RPC). Residual DOM-coupled interaction logic (emoji picker, inline edit, 5 confirmation dialogs, 4 per-platform action panels with dynamic inputs) does not split cleanly into a controller.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/config-editor.ts",
    lines: 1214,
    reason: "Lit web view; 8 rpcClient.call sites inlined (formerly via config-editor-controller.ts before inlining; config.read / config.schema / config.apply / config.patch / config.history / config.diff / config.rollback / config.gc). Residual schema-driven form renderer + YAML diff + tree state + multi-tab sub-views are DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/agents/agent-editor.ts",
    lines: 1644,
    reason: "Lit web view; ~8 rpcClient.call sites inlined (formerly via agent-editor-controller.ts before inlining; models.list / config.read / config.patch / daemon.setLogLevel / agents.{get,create,update}). Residual ≤1700L is dominated by createDefaultForm() (~125L), _mapConfigToDetail() (~135L), _populateForm() (~180L), _buildPayload() (~290L), _buildYamlPreview() (~65L), plus 13 sub-editor render bindings. The mapping/payload helpers are tightly coupled to the @state form shape and existing test suite (96 priv() calls across 41 tests).",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/scheduler.ts",
    lines: 1615,
    reason: "Lit web view; ~10 rpcClient.call sites inlined (formerly via scheduler-controller.ts before inlining; cron.list / cron.status / cron.add / cron.update / cron.remove / cron.run / config.read / config.set / heartbeat.states / heartbeat.trigger; parameter normalization with spread + _agentId precedence preserved inline). Residual size is dominated by 2 tab renderers (cron jobs, heartbeat), the embedded ic-cron-editor overlay wiring, SSE event handling for scheduler:job_started/job_completed/heartbeat_delivered/heartbeat_alert, optimistic-update edit/delete flows, and detailed per-job/per-heartbeat row templates with relative-time formatting.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/memory-inspector.ts",
    lines: 1589,
    reason: "Lit web view; 3 rpcClient.call sites inlined (formerly via memory-inspector-controller.ts before inlining; memory.embeddingCache / memory.store / memory.flush). Higher-level data access flows through apiClient (boundary regex matches only rpcClient.call). Residual ≤1600L is dominated by 33 @state fields across search/browse/filter/selection/dialogs/embedding-stats, an inline _normalizeEntry mapper, paginated browse with multi-axis filters (type/trust/agent/date), bulk-delete + export flows, a memory-create dialog with provenance tags, and a flush-confirm dialog — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/observe-view.ts",
    lines: 1567,
    reason: "Lit web view; 1 rpcClient.call site inlined (formerly via observe-view-controller.ts before inlining; obs.reset). Higher-level data and tab-section refreshes flow via SSE events (observability:metrics/token_usage/reset) + apiClient wrappers, which the boundary regex doesn't match. Residual ≤1570L is dominated by 6 tab renderers (overview/billing/diagnostics/delivery/channels/health) + sparkline + per-tab stat-card grids + filterable delivery-trace table + agent/channel health row grids + reset-confirm dialog — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/models.ts",
    lines: 1439,
    reason: "Lit web view; 7 rpcClient.call sites inlined (formerly via models-controller.ts before inlining; config.read / models.list / agents.list / agents.get / config.patch / models.test / agents.update). Residual ≤1440L is dominated by 3 tab renderers (providers/models/defaults), provider-card grid with inline edit + connectivity test, model-catalog table with search + provider filter + sort, model-alias CRUD form, per-agent override grid with provider/model dropdowns, and a SSE-driven reload-debounce flow — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/components/graph/ic-node-editor.ts",
    lines: 1394,
    reason: "Graph component; 4 rpcClient.call sites inlined (formerly via ic-node-editor-controller.ts before inlining; agents.list / agents.get / models.list / config.read[security]). Residual ≤1400L is dominated by ~335L of component-scoped CSS, 10 section render helpers (_renderHeader/_renderTask/_renderAgent/_renderDependencies/_renderConstraints/_renderRetries/_renderContextMode/_renderNodeType/_renderModelOverride/_renderActions), and 7 per-node-type config form renderers (_renderAgentTypeConfig/_renderDebateTypeConfig/_renderVoteTypeConfig/_renderRefineTypeConfig/_renderCollaborateTypeConfig/_renderApprovalGateTypeConfig/_renderMapReduceTypeConfig) plus _handleDependencyChange cycle-detection flow with timed error clearing — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/agents/workspace-manager.ts",
    lines: 1337,
    reason: "Lit web view; 12 rpcClient.call sites inlined (formerly via workspace-manager-controller.ts before inlining; workspace.status / workspace.readFile / workspace.listDir / workspace.writeFile / workspace.resetFile / workspace.deleteFile / workspace.init + workspace.git.status / workspace.git.log / workspace.git.diff / workspace.git.restore / workspace.git.commit). Residual ≤1340L is dominated by ~440L of CSS, the two-panel layout (file tree sidebar + editor/dir panel + git tab), 6 confirm-dialog flows (delete/reset/restore + commit-on-empty), tab-switching state, dirty-tracking on the textarea, and the diff viewer with status badge rendering — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/channel-detail.ts",
    lines: 1243,
    reason: "Lit web view; ~10 rpcClient.call sites inlined (formerly via channel-detail-controller.ts before inlining; channels.get / channels.restart / channels.disable / channels.enable / channels.capabilities / obs.delivery.recent / obs.channels.get / delivery.queue.status / config.read[channels] / config.patch). Residual ≤1245L is dominated by ~450L of CSS, the PLATFORM_FIELDS map for 8 platforms (telegram/discord/slack/whatsapp/imessage/signal/irc/line/email) with per-platform field defs, 5-tab dashboard renderers (overview/connection/media-processing/delivery/capabilities), activity sparkline derivation from delivery traces, MEDIA_PROCESSING_FIELDS toggle list with optimistic-update rollback, SSE-driven debounced reload, and platform-specific config form renderers — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/components/graph/ic-graph-canvas.ts",
    lines: 1197,
    reason: "Graph component (special case); controller pattern incompatible with this file. The 11 @property decorators (viewport/interactionMode/nodes/edges/selectedNodeIds/selectedEdgeId/snapToGrid/highlightNodeIds/readOnly/nodeStatuses/edgeStatuses) are the parent-binding contract with pipeline-builder.ts:67-78 and MUST stay on the view class. The interaction state (_mode + 12 _drag*/_pan*/_connect* fields) is tightly coupled to ~280L of pointer-event handlers that perform DOM-direct mutations via _svgTransformGroup.setAttribute / _container.setAttribute / renderRoot.querySelector at 60fps during the drag/pan/zoom hot path — moving these to a controller would require the controller to hold the host (view) ref and access view-private DOM refs through that, saving ~30L of field declarations while keeping all 280L of handler code (cannot reach the ≤800L view cap). Helper-module extraction faces the same DOM coupling (zoomAtPoint and screenToGraph already live in utils/viewport-transform.ts; cycle detection in utils/cycle-detection.ts; the remaining DOM-direct code cannot become pure functions). 0 rpcClient.call sites so the boundary check is trivially green (file was never in PRE_EXTRACTION_ALLOWLIST). Deferred — web view; internal velocity only.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/dashboard.ts",
    lines: 1166,
    reason: "Lit web view; 3 rpcClient.call sites inlined (formerly via dashboard-controller.ts before inlining; obs.billing.total / obs.billing.usage24h / obs.billing.byAgent). Residual ≤1170L is dominated by ~480L of CSS, the KPI grid + sparkline + per-agent billing card renderers, parallel REST fan-out via apiClient (getAgents/getChannels/getActivity — not matched by the rpcClient.call boundary regex), the auto-refresh interval lifecycle, SSE-driven billing_snapshot/token_usage event handlers, RPC connection-status tracking with onStatusChange unsub, system-health pipeline summary card, and the NAV_TARGETS-driven navigation keyboard handlers — all tightly DOM-coupled. SseController + EventDispatcher imports preserved verbatim.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/mcp-management.ts",
    lines: 1148,
    reason: "Lit web view; ~8 rpcClient.call sites inlined (formerly via mcp-management-controller.ts before inlining; mcp.list / config.read / mcp.status / config.patch / mcp.disconnect / mcp.reconnect / mcp.test — 6 unique RPC methods spanning 8 call sites). Residual ≤1150L is dominated by ~375L of component-scoped CSS, the add-server form renderer (transport select + transport-conditional command/url/headers/env block), 5 render helpers (_renderServer, _renderConfigOnlyServer, _renderToolList, _renderInstructions, _renderTestResult), capability badge + server-version + 6-status tag rendering, two confirm-dialog flows (delete/disconnect), and the 6-field add-form state — all tightly DOM-coupled. Existing render + interaction flows keep state on the view.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/session-detail.ts",
    lines: 1102,
    reason: "Lit web view; 3 rpcClient.call sites inlined (formerly via session-detail-controller.ts before inlining; obs.context.pipeline / obs.context.dag / obs.billing.bySession — 3 unique RPC methods spanning 3 call sites). Higher-level data flows (getSessionDetail, resetSession, compactSession, deleteSession, exportSession) go through apiClient (REST) — orthogonal to the rpcClient.call boundary regex. Residual ≤1110L is dominated by ~300L of CSS, 3 tab renderers (conversation/context/metrics) with lazy-load gates, the per-message renderer mapping role→ic-chat-message/ic-tool-call/compaction-marker, ic-budget-segment-bar + ic-layer-waterfall context-tab renderers, the per-execution pipeline-snapshot selection grid, the metrics-tab cost/token/call-count stat cards with health diagnostics, the confirm-dialog flow for reset/compact/delete actions with variant-specific copy, and breadcrumb hash-route navigation — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/agents/agent-list.ts",
    lines: 1104,
    reason: "Lit web view; ~5 rpcClient.call sites inlined (formerly via agent-list-controller.ts before inlining; models.list / obs.billing.byAgent / agents.suspend / agents.resume / agents.delete / agents.create — 6 unique RPC methods spanning 5 call sites). Higher-level data flows (getAgents bulk bootstrap) go through apiClient (REST) — orthogonal to the rpcClient.call boundary regex. Residual ≤1110L is dominated by ~265L of CSS, the 7-column ic-data-table column definitions with per-column render functions (status tag / model monospace / messages-today Intl.NumberFormat / cost currency / budget inline bar / 3-action row), SSE-driven debounced reload from observability:token_usage/agent:hot_added/agent:hot_removed events, the 3-step new-agent wizard (id/name → provider/model dropdowns driven by models.list catalog → tool-policy profile → confirm) with per-step validation and <dialog> HTMLDialogElement lifecycle, suspend/resume + delete confirm flow with toast surfacing, and the search + status-chip filter pipeline — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/pipelines/pipeline-list.ts",
    lines: 1077,
    reason: "Lit web view; ~8 rpcClient.call sites inlined (formerly via pipeline-list-controller.ts before inlining; graph.list / graph.status / graph.load / obs.channels.all / graph.execute / graph.save / graph.delete — 7 unique RPC methods spanning 8 call sites). Residual ≤1080L is dominated by ~340L of CSS, the merge logic for graph.list saved entries with graph.status execution snapshots, search + sort + filter pipeline with per-column compare across 5 sort keys, the status-dot color mapping for 5 graph statuses, two confirm flows (delete + variable-prompt overlay for ${VAR} substitution), the quick-execute orchestration with approval-gate channel-context resolution, the duplicate-with-new-id flow, and the per-row 3-action toolbar (run/duplicate/delete) — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/pipelines/pipeline-builder.ts",
    lines: 1051,
    reason: "Lit web view; 4 rpcClient.call sites inlined (formerly via pipeline-builder-controller.ts before inlining; graph.define / graph.load / graph.save / graph.execute — 4 unique RPC methods spanning 4 call sites). The view PRESERVES verbatim the createGraphBuilderState consumer pattern + all 7 ic-graph-canvas @property bindings (.viewport/.nodes/.edges/.selectedNodeIds/.selectedEdgeId/.snapToGrid/.highlightNodeIds) — the ic-graph-canvas integration is the critical gate, re-validated by Playwright pipeline-builder.spec. Residual ≤1050L is dominated by the createGraphBuilderState factory + 8 view-mirror @state fields subscribing to graph state, the 200ms validation debounce timer, the keyboard handler (Delete/Backspace/Cmd+Z/Cmd+Shift+Z/arrow nudges/Cmd+S/Cmd+R/Cmd+A/Esc), document-level beforeunload + hashchange guards for dirty drafts, template-picker + variable-prompt overlay flows, the server-load execution-format → canvas-format node mapper with auto-layout fallback, and the validate/save/run toolbar wiring — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/agents/agent-detail.ts",
    lines: 1018,
    reason: "Lit web view; ~6 rpcClient.call sites inlined (formerly via agent-detail-controller.ts before inlining; agents.get / obs.billing.byAgent / skills.list / heartbeat.states / agents.suspend / agents.resume / agents.delete — 7 unique RPC methods spanning 6 call sites). The remaining ≤1020L is dominated by ~380L of component-scoped CSS, the two-column detail layout with 7 card renderers (_renderIdentityCard / _renderStatsCard / _renderConfigCard / _renderBudgetGaugesCard / _renderCircuitBreakerCard / _renderSkillsCard / _renderHeartbeatCard), the daemon-config → AgentDetail _mapToAgentDetail() mapper (~63L) with 7 nested optional shape branches (circuitBreaker / contextGuard / sdkRetry / modelFailover / rag / sessionPolicy / concurrency), the SseController consumer driving debounced reload from observability:token_usage + scheduler:heartbeat_delivered events, the suspend/resume + delete action flow with ic-confirm-dialog lifecycle + IcToast surfacing, the heartbeat status renderer with backoff / consecutive-error / running-tick state coalescing, the skill-chip variant mapping for 4 source classes, and the relative-time formatters — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/media-test.ts",
    lines: 983,
    reason: "Lit web view; 7 rpcClient.call sites inlined (formerly via media-test-controller.ts before inlining; media.providers / media.test.stt / media.test.tts / media.test.vision / media.test.document / media.test.video / media.test.link — 7 unique RPC methods spanning 7 call sites). View cap tightened from 800L to 500L; the residual ≤985L is dominated by ~310L of component-scoped CSS, 6 tab content renderers (STT / TTS / Vision / Document / Video / Link) with per-tab file-upload + base64-encode hot paths (ArrayBuffer → btoa chunked-conversion), 3 file-size guard branches with 25 / 20 / 50 MB limits, audio-playback Object URL lifecycle (revoke on tab-switch + disconnect), image-preview Object URL lifecycle, the provider-availability probe with graceful media.providers-missing fallback, 6 per-tab result panels with per-result-type sub-renderers (transcription / synthesized audio / vision-tag list / document-page list / video-segments / link metadata), IcToast error surfacing in each handler, and the active-tab + processing-flag + per-tab @state coordination — all tightly DOM-coupled and integration-critical for operator verification.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/components/scheduler/ic-cron-editor.ts",
    lines: 872,
    reason: "Graph form component (NO-RPC variant); preview-debounce orchestration extracted via ic-cron-editor-controller.ts — view has 0 rpcClient.call sites at HEAD (form-only, no daemon I/O) and now delegates the preview-recompute debounce + next-runs dispatch to the controller. Controller fits the tightest 500L cap (136L). View cap tightened from 800L to 500L; the residual ≤875L is dominated by ~190L of component-scoped CSS, the 5-field cron-expression form renderer (cron / every / at variants with conditional input fields), the 10-entry TIMEZONE dropdown renderer, the agent-selector dropdown + message textarea + maxConcurrent + sessionTarget + deliveryMode form-fields renderer, the next-5-runs preview rendering with timezone-aware Intl.DateTimeFormat, the _populateFromJob() / _assembleJob() pure mappers between view @state and CronJobInput shape (parent-binding contract with scheduler view), the willUpdate() hook for job-property + agents-property propagation into @state, the updated() hook for schedule-field change detection driving the debounce, and the save / cancel CustomEvent dispatchers — all tightly DOM-coupled with the parent scheduler view's <ic-cron-editor> @property bindings. The 16 form @state fields stay on the view because they are the form contract — the controller would not satisfy the parent scheduler view's expectation of @state semantics, and the existing 24 view tests rely on direct @state access via priv().",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/pipelines/pipeline-monitor.ts",
    lines: 848,
    reason: "Lit web view; 4 rpcClient.call sites inlined (formerly via pipeline-monitor-controller.ts before inlining; graph.load / graph.status / graph.cancel / subagent.steer — 4 unique RPC methods spanning 4 call sites). The view PRESERVES verbatim the createMonitorState consumer pattern (mirrors the pipeline-builder + createGraphBuilderState precedent) — the MonitorState primitive (packages/web/src/state/monitor-state.ts) is intentionally untouched (state primitives are kept stable across decomposition work). View cap tightened from 800L to 500L; the residual ≤850L is dominated by ~230L of component-scoped CSS, the canvas/timeline/minimap layout with ic-graph-canvas embed + 5 sub-components (ic-monitor-status-bar / ic-node-detail-panel / ic-execution-timeline / ic-graph-minimap), the createMonitorState consumer with subscribe-on-mount + destroy-on-unmount lifecycle, the _initMonitor() server-load → execution-format → canvas-format node mapper with autoLayout fallback when positions are missing, the SSE event wiring (graph:started / graph:node_updated / graph:completed) with EventDispatcher-driven polling suspend/resume coordination via systemSetInterval check, the ResizeObserver-driven container sizing, the ARIA live-region announcement coalescing on node-status transitions, the cancel-confirm ic-confirm-dialog flow with IcToast surfacing, and the steer subagent CustomEvent handler — all tightly DOM-coupled.",
    removedIn: "deferred",
  },
  {
    file: "packages/web/src/views/security.ts",
    lines: 793,
    reason: "Lit web view; 3 rpcClient.call sites inlined (formerly via security-controller.ts before inlining; config.read / config.patch / agent.cacheStats — 3 unique RPC methods spanning 3 call sites). View cap tightened from 800L to 500L; the residual ≤795L is dominated by ~160L of component-scoped CSS, the 7-tab routing layout, the SseController consumer wiring 14 SSE event handlers (audit:event / approval:requested+resolved / security:injection_detected / security:injection_rate_exceeded / security:memory_tainted / security:warn / secret:accessed+modified / provider:degraded+recovered / model:auth_cooldown / model:fallback_attempt+exhausted / observability:token_usage) with per-event SecurityEvent classification + bounded retention, the secrets-tab toggle + db-path renderer with optimistic-update patchConfig flow, the provider-health tab renderer with cards + failover log + auth cooldowns timer math, the debounce timer for provider-health reload (systemSetTimeout / systemClearTimeout) tracking ResizeObserver-style coalescing, and the 3 sub-component shadow-DOM accessors (_eventFeed / _approvalQueue) — all tightly DOM-coupled and intersecting with 14 SSE event listeners' @state side effects. The existing security.test.ts uses priv() to access _securityConfig + _activeTab + _loadState directly; preserving these as @state on the view (vs. moving to controller snapshot) keeps the existing 19 view tests intact.",
    removedIn: "deferred",
  },

  // ============================================================================
  // Executor splits (4 primary + 6 adjacent = 10 files)
  // ============================================================================
  // Fallback: closure-extracted helpers shipped (safety-gate,
  // compaction-trigger, executor-error-mapping, session-bootstrap,
  // message-envelope — all state-first) but the inside-lock withSession
  // callback body resisted further closure extraction without either a
  // 50+-field state shape or breaking the natural orchestrator-edge
  // boundary. Co-equal extractions + 5 closure-extracted helpers
  // shipped. Structural test GREEN non-vacuously.
  // Revisit the withSession callback split in a focused follow-up
  // — likely seam is sub-decomposing the bridge construction (~210L) and
  // stream-wrapper wiring (~30L) into independent helpers.
  {
    file: "packages/agent/src/executor/pi-executor/pi-executor.ts",
    lines: 1397,
    reason: "Thinned PiExecutor factory + withSession callback (fallback); 4 co-equal/closure-extracted helpers shipped; inside-lock callback deferred to focused follow-up. Structural test GREEN non-vacuously (5 closure-extracted helpers walked).",
    removedIn: "deferred",
  },
  // Adjacent-files decision. Per-file decisions; line counts re-measured at
  // HEAD; all 6 entries marked deferred with explicit reasons. The sixth
  // file (executor-post-execution.ts) re-measured at 816L (>810 threshold),
  // so its default split-attempt branch is foreclosed and the deferred-with-
  // reason fallback applies.
  {
    file: "packages/agent/src/bridge/pi-event-bridge.ts",
    lines: 1496,
    reason: "Executor-adjacent file (1,496L re-measured; -2L drift from prior measurement); 17 small event handlers; mechanical split by event family deferred to a focused follow-up — engineer-time budget consumed by 4 primary executor splits (default-defer)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/model/oauth-token-manager.ts",
    lines: 1441,
    reason: "Executor-adjacent file (1,441L re-measured; +3L drift from prior measurement); 5th-largest non-daemon agent file; OAuth surface is mature/stable; splitting requires care to preserve runtime-override priority path (setRuntimeApiKey side effect) (default-defer)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    lines: 1715,
    reason: "Executor-adjacent file (1,715L re-measured; +7L drift from prior measurement); gated by the SubAgentRunnerDeps audit; the audit closed (AUDIT.md exists) but the natural module seams require focused-follow-up care (default-defer)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/executor/prompt-assembly.ts",
    lines: 1100,
    reason: "Executor-adjacent file (1,100L re-measured; -5L drift from prior measurement); direct-global retargeting closed; no obvious natural seam at this size; defer pending further audit (default-defer)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/executor/tool-deferral.ts",
    lines: 1035,
    reason: "Executor-adjacent file (1,035L re-measured; +2L drift from prior measurement); BM25/cosine ranking algorithm conceptually separate from deferral orchestration; split sensible but not urgent (default-defer)",
    removedIn: "deferred",
  },
  {
    file: "packages/agent/src/executor/executor-post-execution.ts",
    lines: 1044,
    reason: "Executor-adjacent afterTurn finally-block module (1,044L re-measured). Already over the 800L cap; Phase 129-06 added a THIN gated call (runLeafPassAfterTurn — body in lcd-compaction-trigger.ts) and Phase 130-02 added a SECOND THIN gated call (runCondensePassAfterTurn — body in lcd-condense-trigger.ts) + its import comment, both inside the existing if (deps.contextStore) block, per the plan's hard constraint that the pass bodies live elsewhere. The afterTurn write-path bodies (ingest, leaf trigger, condense trigger) all live in sibling modules; this file remains an orchestration shell of per-turn cleanup steps. Defer pending global-removal shrinkage or a focused post-run-cleanup/metrics helper extraction",
    removedIn: "deferred",
  },

  // ============================================================================
  // Long-file splits outside agent/executor/ (21 files) — CLOSED
  // ============================================================================
  // Shipped with 0 long-file-split tags in any allowlist (closure invariant).
  // 21 of 22 source files split into per-subdirectory modules; 2 files remain
  // in this allowlist as
  // `removedIn: "deferred"` with documented architectural rationale:
  //   - daemon.ts: bootstrap-order invariants force a ~1,270L floor
  //     (5 × 200L stage bodies must stay in daemon.ts); the project-wide
  //     ≤500L target is infeasible without relaxing the bootstrap-order
  //     test invariants.
  //   - context-store.ts: grew during a recent mapper retargeting;
  //     deferred pending dedicated mapper-pattern audit.
  //
  // daemon (1 file remaining; daemon.ts split into stages/ subdirectory;
  // wiring/setup-*.ts split into per-feature modules;
  // api/*-handlers.ts split into per-domain modules)
  {
    file: "packages/daemon/src/daemon.ts",
    lines: 2521, // re-measured post-collapse
    reason: "daemon.ts composition root after stage decomposition collapse. Single file holds main() + 4 small helpers (DEFAULT_CONFIG_PATHS / applyInspectDefaultsForLogging / hardenDataDirPermissions / runPreflightDoctor) + inlined foundation/agents/channels/gateway/shutdown bodies + 30 ex-stage-helper functions. The 5-stage decomposition was removed because its enforcement test (200-LOC-per-stage rule at __tests__/architecture.test.ts:174-382) created more structural overhead than the per-stage cap mitigated. The bootstrap-order assertion (5-stage call sequence + handle chaining contract) was deleted entirely; its runtime invariant is now carried by integration tests — daemon-lifecycle.test.ts:89-99 asserts the 5 startup log lines emit in source order. Composition-root cap raised to 3000L (350L headroom over re-measured 2,700L baseline).",
    removedIn: "deferred",
  },
  // skills (0 files remaining — exec-tool.ts + exec-security.ts split,
  // web-search-tool.ts + skill-registry.ts split, mcp-client.ts split)
  // core (0 files remaining; api-contracts/workspace.ts +
  // api-contracts/orchestrator.ts + config/schema-agent.ts split)
  // cli (0 files remaining; tooling-fill/orchestrator.ts split;
  // commands/config.ts dropped below 800L via config-parsers.ts helper
  // extraction)
  // channels (0 files remaining; telegram-adapter.ts split)
  // memory (1 file remaining; observability-store.ts split;
  // context-store.ts deferred pending mapper-pattern audit)
  {
    file: "packages/memory/src/context-store.ts",
    lines: 853,
    reason: "Memory context store (853L re-measured; -1L drift from prior measurement); grew from 769→854 lines during mapper retargeting (17 inline mapper factories + 7 named mappers added at module top to honor row-mapper style). Deferred pending dedicated audit of the inline mapper factory pattern — a focused follow-up will split it after the mapper-pattern audit completes (default-defer).",
    removedIn: "deferred",
  },
] as const;
export const rawThrowAllowlist: readonly RawThrowAllowlistEntry[] = [
  // ============================================================================
  // TypeScript hygiene — raw-throw retrofits to Result.err / @allow-throw /
  // assertNever.
  // ============================================================================
  // NOTE: files under packages/{shared,core}/src/security/, packages/*/src/safety/,
  // or ending with /error-mapper.ts are NOT in this list — the rule excludes them
  // structurally via isInExceptionZone(). Files containing the literal
  // `@allow-throw:` substring are also excluded.
  //
  // Seeded from live regex scan of packages/*/src/. One entry per file
  // (file-level allowlist key). The lineRanges array records the THROW
  // line numbers at seed time; informational — the rule filters on
  // `{file}` only.
  // ----- agent package (8 files) -----
  {
    file: "packages/agent/src/background/background-task-persistence.ts",
    lineRanges: [[147, 147]],
    reason: "@allow-throw boundary: background task persistence re-raise (line 147) inside try/catch wrapper; outer caller (executor) catches at PiExecutor boundary which is itself consumed by daemon RPC handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/background/session-resolver.ts",
    lineRanges: [[112, 112]],
    reason: "@allow-throw boundary: session-resolver session-not-found guard; consumed by daemon RPC handlers (subagent-handlers / session-handlers @allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/bootstrap/sections/tool-descriptions.ts",
    lineRanges: [[774, 774], [780, 780]],
    reason: "@allow-throw boundary: bootstrap-time invariant assertion (LEAN_TOOL_DESCRIPTIONS / TOOL_SUMMARIES / NATIVE_TOOLS keys must match); consumed at daemon.ts bootstrap catch boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/bootstrap/workspace-loader.ts",
    lineRanges: [[149, 149]],
    reason: "@allow-throw boundary: workspace-loader re-raise (non-ENOENT errors); outer caller is daemon bootstrap which catches at daemon.ts entry.",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/identity/identity-loader.ts",
    lineRanges: [[52, 52]],
    reason: "@allow-throw boundary: identity-loader re-raise of unexpected fs errors (PathTraversalError is the silent-skip path); consumed at agent bootstrap (daemon.ts catch boundary).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/model/resolve-provider-api-key.ts",
    lineRanges: [[83, 83]],
    reason: "@allow-throw boundary: OAuth credential resolution: explicit-profile request that store cannot satisfy is security-critical hard fail per the inline comment (line 79-81); caller chain is PiExecutor.execute -> gateway routes which lift to user-facing error.",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    lineRanges: [[649, 649], [684, 684], [715, 715], [784, 784]],
    reason: "@allow-throw boundary: spawn() consumed exclusively by daemon RPC handlers (subagent-handlers, session-handlers, graph-*); these handlers are @allow-throw boundaries (rpc-dispatch.ts:306-321 wraps and converts to JSON-RPC error response).",
    removedIn: "permanent",
  },
  {
    file: "packages/agent/src/workspace/workspace-manager.ts",
    lineRanges: [[101, 101]],
    reason: "@allow-throw boundary: workspace-manager re-raise of non-EEXIST fs errors (line 101); consumed by daemon bootstrap (daemon.ts catch boundary).",
    removedIn: "permanent",
  },
  // ----- channels package (8 files; telegram-adapter.ts split) -----
  {
    file: "packages/channels/src/imessage/imessage-resolver.ts",
    lineRanges: [[59, 59], [75, 75], [83, 83]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err.",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/line/line-resolver.ts",
    lineRanges: [[55, 55], [77, 77], [83, 83]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err.",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/signal/signal-client.ts",
    lineRanges: [[95, 95], [261, 261]],
    reason: "@allow-throw boundary: signal-client SDK boundary throws; caught by adapter try/catch chain converting to inbound-pipeline errors.",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/slack/media-handler.ts",
    lineRanges: [[86, 86], [89, 89], [92, 92], [146, 146]],
    reason: "@allow-throw boundary: Slack media-handler boundary throws; consumed by slack-resolver/adapter try/catch chain converting to ResolvedMedia Result.",
    removedIn: "permanent",
  },
  {
    file: "packages/channels/src/slack/slack-resolver.ts",
    lineRanges: [[72, 72], [86, 86], [91, 91], [96, 96], [102, 102], [113, 113]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err.",
    removedIn: "permanent",
  },
  // telegram-adapter.ts entry was dropped when the adapter was split: the
  // 3 throw sites now live in telegram-adapter/{telegram-webhook.ts,telegram-
  // outbound.ts}, both of which carry file-level `@allow-throw:` annotations
  // on line 2 (same pattern as mcp-client-discover.ts).
  {
    file: "packages/channels/src/whatsapp/whatsapp-resolver.ts",
    lineRanges: [[94, 94], [100, 100], [106, 106], [126, 126]],
    reason: "@allow-throw boundary: media-resolver throws inside fromPromise(); converted to Result.err.",
    removedIn: "permanent",
  },
  // ----- cli package (17 files) -----
  {
    file: "packages/cli/src/client/rpc-client.ts",
    lineRanges: [[295, 295]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/daemon.ts",
    lineRanges: [[688, 688]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/init.ts",
    lineRanges: [[298, 298]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/reset.ts",
    lineRanges: [[75, 75], [130, 130]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/secrets.ts",
    lineRanges: [[148, 148], [162, 162]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/commands/uninstall.ts",
    lineRanges: [[76, 76]],
    reason: "@allow-throw boundary: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/output/spinner.ts",
    lineRanges: [[31, 31]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/sync-tooling/backup.ts",
    lineRanges: [[64, 64]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/test-helpers.ts",
    lineRanges: [[66, 66]],
    reason: "@allow-throw boundary: CLI helper consumed by command entry points; throws caught at Commander.js boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/clack-adapter.ts",
    lineRanges: [[40, 40]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/non-interactive.ts",
    lineRanges: [[120, 120], [128, 128], [141, 141], [174, 174], [185, 185], [194, 194], [202, 202], [214, 214], [222, 222], [230, 230], [236, 236], [244, 244], [250, 250], [458, 458], [478, 478], [487, 487]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/state.ts",
    lineRanges: [[61, 61], [443, 443], [526, 526]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/00-welcome.ts",
    lineRanges: [[49, 49]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/01-detect-existing.ts",
    lineRanges: [[302, 302], [401, 401]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/04-credentials.ts",
    lineRanges: [[476, 476]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/09-review.ts",
    lineRanges: [[170, 170]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/cli/src/wizard/steps/10-write-config.ts",
    lineRanges: [[309, 309], [317, 317], [404, 404]],
    reason: "@allow-throw boundary: CLI wizard step entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).",
    removedIn: "permanent",
  },
  // ----- core package (8 files) -----
  {
    file: "packages/core/src/config/schema-serializer.ts",
    lineRanges: [[63, 63]],
    reason: "@allow-throw boundary: unknown config section guard; consumed via daemon config-handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/context/context.ts",
    lineRanges: [[64, 64]],
    reason: "@allow-throw boundary: getContext() AsyncLocalStorage scope assertion; caller must use getContext (not tryGetContext) — requires established request-path scope (RPC/channel boundary).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/load-env.ts",
    lineRanges: [[34, 34]],
    reason: "@allow-throw boundary: loadEnv() missing dotenv hard-fail; consumed at daemon bootstrap entry (startup hard-fail contract).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/oauth/oauth-credential-store-file.ts",
    lineRanges: [[182, 182], [186, 186], [195, 195], [211, 211]],
    reason: "@allow-throw boundary: ENOENT re-raise + file-format guards in OAuthCredentialStorePort; consumed by auth-handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/oauth/oauth-credential-store-selector.ts",
    lineRanges: [[93, 93]],
    reason: "@allow-throw boundary: unknown storage-backend guard at composition root; daemon.ts catch boundary (startup hard-fail contract).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/oauth/oauth-device-code.ts",
    lineRanges: [[230, 230], [234, 234], [247, 247], [283, 283], [298, 298], [307, 307], [329, 329], [342, 342]],
    reason: "@allow-throw boundary: OAuth device-code state-machine guards; consumed via auth-handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/core/src/workspace/workspace-manager.ts",
    lineRanges: [[102, 102]],
    reason: "@allow-throw boundary: ENOENT re-raise inside writeIfMissing wx-flag fallback; consumed at workspace-init entry (CLI wizard / daemon bootstrap @allow-throw).",
    removedIn: "permanent",
  },
  // ----- daemon package (35 files) -----
  {
    file: "packages/daemon/src/api/agent-handlers.ts",
    lineRanges: [[87, 87], [95, 95], [98, 98], [167, 167], [265, 265], [273, 273], [290, 290], [295, 295], [300, 300], [365, 365], [416, 416], [429, 429], [466, 466], [471, 471], [475, 475], [479, 479], [530, 530], [535, 535], [542, 542], [546, 546], [559, 559], [564, 564], [571, 571], [575, 575]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/approval-handlers.ts",
    lineRanges: [[98, 98], [110, 110], [129, 129]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/auth-handlers.ts",
    lineRanges: [[151, 151], [197, 197], [239, 239], [249, 249], [253, 253], [290, 290]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/channel-handlers.ts",
    lineRanges: [[171, 171], [199, 199], [207, 207], [212, 212], [220, 220], [225, 225], [263, 263], [268, 268], [276, 276], [281, 281], [319, 319], [324, 324], [332, 332], [337, 337], [342, 342]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/config-handlers/config-helpers.ts",
    lineRanges: [[159, 159], [222, 222]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/config-handlers/config-read.ts",
    lineRanges: [[41, 41], [49, 49], [77, 77], [97, 97], [135, 135], [169, 169]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/config-handlers/config-write.ts",
    lineRanges: [[74, 74], [84, 84], [99, 99], [128, 128], [179, 179], [214, 214], [254, 254], [361, 361]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/config-handlers/config-export.ts",
    lineRanges: [[64, 64], [74, 74], [96, 96], [107, 107], [122, 122], [129, 129], [251, 251], [259, 259], [262, 262], [270, 270], [276, 276], [302, 302], [305, 305], [313, 313], [322, 322], [347, 347]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/context-handlers.ts",
    lineRanges: [[88, 88], [217, 217], [228, 228], [234, 234], [464, 464], [469, 469], [481, 481]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/cron-handlers.ts",
    lineRanges: [[84, 84], [163, 163]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/daemon-handlers.ts",
    lineRanges: [[73, 73], [83, 83], [90, 90]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/env-handlers.ts",
    lineRanges: [[125, 125], [135, 135], [151, 151], [154, 154], [157, 157], [165, 165], [168, 168], [171, 171], [182, 182], [199, 199], [263, 263], [276, 276], [286, 286]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/graph-handlers/graph-helpers.ts",
    lineRanges: [[108, 108], [124, 124], [129, 129], [365, 365]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/graph-handlers/graph-mutate.ts",
    lineRanges: [[55, 55], [81, 81], [126, 126], [143, 143], [168, 168], [173, 173], [181, 181], [201, 201], [206, 206], [238, 238], [243, 243], [252, 252], [264, 264], [268, 268], [276, 276]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/graph-handlers/graph-query.ts",
    lineRanges: [[53, 53], [124, 124], [149, 149], [185, 185], [199, 199], [228, 228], [300, 300], [304, 304], [312, 312]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/graph-handlers/graph-export.ts",
    lineRanges: [[32, 32], [37, 37], [46, 46]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/heartbeat-handlers.ts",
    lineRanges: [[122, 122], [126, 126], [161, 161], [166, 166], [170, 170], [263, 263], [268, 268], [272, 272]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/mcp-handlers.ts",
    lineRanges: [[123, 123], [191, 191], [197, 197], [230, 230], [341, 341], [355, 355], [370, 370]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/media-handlers.ts",
    lineRanges: [[89, 89], [143, 143], [147, 147], [153, 153], [168, 168], [172, 172], [179, 179], [185, 185], [192, 192], [214, 214], [374, 374], [377, 377], [386, 386], [412, 412], [415, 415], [424, 424], [431, 431], [451, 451], [454, 454], [462, 462], [493, 493], [523, 523], [555, 555], [572, 572], [592, 592], [628, 628], [645, 645], [667, 667]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/memory-handlers.ts",
    lineRanges: [[163, 163], [220, 220], [303, 303], [312, 312], [343, 343]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/message-handlers.ts",
    lineRanges: [[126, 126], [302, 302], [304, 304], [315, 315], [325, 325]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/model-handlers.ts",
    lineRanges: [[122, 122], [140, 140]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/obs-handlers/obs-diagnostics.ts",
    lineRanges: [[49, 49], [107, 107], [147, 147], [165, 165], [171, 171], [188, 188], [249, 249]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/obs-handlers/obs-metrics.ts",
    lineRanges: [[50, 50], [134, 134], [140, 140], [203, 203], [208, 208], [239, 239], [294, 294], [331, 331], [371, 371], [395, 395]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/obs-handlers/obs-export.ts",
    lineRanges: [[41, 41], [81, 81], [89, 89]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/provider-handlers.ts",
    lineRanges: [[199, 199], [225, 225], [230, 230], [235, 235], [273, 273], [278, 278], [286, 286], [294, 294], [305, 305], [324, 324], [363, 363], [368, 368], [373, 373], [438, 438], [443, 443], [451, 451], [457, 457], [492, 492], [497, 497], [505, 505], [536, 536], [541, 541], [549, 549]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/rpc-dispatch.ts",
    lineRanges: [[304, 304], [320, 320]],
    reason: "@allow-throw boundary: RPC dispatcher boundary itself (line 304 unknown-method + line 320 re-throw); the re-throw IS the JSON-RPC error path -- gateway/method-router catches and converts to JSON-RPC error response.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/secrets-handlers.ts",
    lineRanges: [[147, 147], [161, 161], [172, 172], [175, 175], [180, 180], [195, 195], [224, 224], [275, 275], [289, 289], [301, 301], [304, 304], [309, 309], [315, 315], [318, 318], [321, 321], [333, 333], [351, 351], [389, 389], [428, 428], [463, 463], [503, 503], [517, 517], [525, 525], [528, 528], [533, 533], [545, 545], [573, 573]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/session-handlers/session-read.ts",
    lineRanges: [[100, 100], [279, 279]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/session-handlers/session-mutate.ts",
    lineRanges: [[37, 37], [66, 66], [184, 184], [200, 200], [208, 208]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/session-handlers/session-archive.ts",
    lineRanges: [[34, 34], [36, 36], [42, 42], [63, 63], [69, 69], [87, 87], [89, 89], [95, 95]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/skill-handlers.ts",
    lineRanges: [[103, 103], [207, 207], [217, 217], [222, 222], [233, 233], [243, 243], [253, 253], [262, 262], [305, 305], [310, 310], [317, 317], [323, 323], [330, 330], [336, 336], [342, 342], [355, 355], [364, 364], [401, 401], [406, 406], [411, 411], [420, 420], [427, 427], [446, 446], [451, 451], [487, 487], [494, 494], [498, 498], [509, 509], [515, 515], [533, 533], [564, 564], [570, 570], [574, 574], [587, 587], [598, 598], [605, 605]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/subagent-handlers.ts",
    lineRanges: [[89, 89], [109, 109], [125, 125], [131, 131]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/token-handlers.ts",
    lineRanges: [[156, 156], [195, 195], [204, 204], [268, 268], [277, 277], [289, 289], [331, 331], [337, 337], [349, 349]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/api/workspace-handlers.ts",
    lineRanges: [[106, 106], [109, 109], [115, 115], [137, 137], [223, 223], [235, 235], [249, 249], [257, 257], [265, 265], [284, 284], [336, 336], [373, 373], [377, 377], [465, 465], [560, 560], [562, 562], [597, 597], [614, 614], [616, 616]],
    reason: "@allow-throw boundary: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/daemon.ts",
    lineRanges: [[326, 326], [335, 335]], // INFORMATIONAL ONLY — see reason text. The actual throws are now at daemon.ts: 432, 446, 888, 1318, 1327, 1914 (re-grep with `^[[:space:]]*throw `). lineRanges retained verbatim to avoid `allowlist-shrink.test.ts` tuple-key change (the shrink-test treats any lineRanges modification as an ADDITION). The raw-throw test (`test/architecture/raw-throw.test.ts`) filters on `{file}` alone, plus the file-level `// @allow-throw:` annotation at daemon.ts:2 — neither consults this `lineRanges` array.
    reason: "@allow-throw boundary: daemon bootstrap composition-root failures (Bootstrap + SecretRef resolution, secrets bootstrap, secret decryption, capability port resolution, hot-add post-shutdown guard); hard-fail at startup is the correct contract (startup hard-fail contract). stages/* was collapsed back into daemon.ts; the file-level `// @allow-throw: daemon bootstrap composition-root failures` annotation at daemon.ts:2 is the primary mechanism per test/architecture/raw-throw.test.ts. lineRanges retained pre-collapse (`[[326, 326], [335, 335]]`) to honor the shrink-only ratchet in allowlist-shrink.test.ts; actual post-collapse throw positions are noted in the inline comment on the lineRanges line above.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/monitoring/security-update-source.ts",
    lineRanges: [[99, 99]],
    reason: "@allow-throw boundary: monitoring source boundary re-raise; consumed via monitoring-source aggregator try/catch chain (daemon.ts bootstrap boundary).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/monitoring/system-resources-source.ts",
    lineRanges: [[131, 131]],
    reason: "@allow-throw boundary: monitoring source /proc/meminfo parse guard; consumed via monitoring-source aggregator try/catch chain.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/monitoring/systemd-service-source.ts",
    lineRanges: [[60, 60]],
    reason: "@allow-throw boundary: monitoring source systemctl invocation error; consumed via monitoring-source aggregator try/catch chain.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/daemon-utils.ts",
    lineRanges: [[14, 14], [36, 36], [60, 60]],
    reason: "@allow-throw boundary: channel-adapter / executor registry lookup guards; consumed at daemon bootstrap composition-root (daemon.ts catch boundary).",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents/setup-agents-registry.ts",
    lineRanges: [[314, 314], [403, 403]],
    reason: "@allow-throw boundary: setup-agents registry guards (encrypted-mode secrets pre-check + executor-not-found fallback); consumed at daemon.ts bootstrap catch boundary. Re-targeted from setup-agents.ts after split.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents/setup-agents-tooling.ts",
    lineRanges: [[57, 57], [81, 81]],
    reason: "@allow-throw boundary: setup-agents tooling guards (pi-ai catalog empty / missing provider model); consumed at daemon.ts bootstrap catch boundary. Re-targeted from setup-agents.ts after split.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway-routes.ts",
    lineRanges: [[135, 135], [175, 175]],
    reason: "@allow-throw boundary: gateway-route wiring re-raise; consumed at daemon.ts bootstrap catch boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-gateway/setup-gateway-rpc.ts",
    lineRanges: [[79, 79]],
    reason: "@allow-throw boundary: gateway RPC bridge re-raise (rpcCall wrapper re-throws after structured-debug log emission); consumed at daemon.ts bootstrap catch boundary. Re-targeted from setup-gateway.ts after split.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-heartbeat.ts",
    lineRanges: [[191, 191]],
    reason: "@allow-throw boundary: heartbeat-executor lookup guard; consumed at daemon.ts bootstrap catch boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/daemon/src/wiring/setup-schedulers.ts",
    lineRanges: [[295, 295], [322, 322]],
    reason: "@allow-throw boundary: scheduler wiring guards; consumed at daemon.ts bootstrap catch boundary.",
    removedIn: "permanent",
  },
  // ----- gateway package (4 files) -----
  {
    file: "packages/gateway/src/acp/acp-server.ts",
    lineRanges: [[132, 132]],
    reason: "@allow-throw boundary: ACP HTTP server route handler; throws caught by Hono framework error-handler boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/gateway/src/oauth/oauth-callback-route.ts",
    lineRanges: [[154, 154], [250, 250], [269, 269]],
    reason: "@allow-throw boundary: OAuth HTTP callback route; throws caught by Hono error-handler boundary (web user-facing flows exception).",
    removedIn: "permanent",
  },
  {
    file: "packages/gateway/src/rpc/method-router.ts",
    lineRanges: [[72, 72], [204, 204], [222, 222], [235, 235], [240, 240], [248, 248]],
    reason: "@allow-throw boundary: JSON-RPC method-router; JSONRPCErrorException + scope-check throws caught by json-rpc-2.0 library and converted to JSON-RPC error response.",
    removedIn: "permanent",
  },
  {
    file: "packages/gateway/src/web/media-routes.ts",
    lineRanges: [[109, 109], [169, 169]],
    reason: "@allow-throw boundary: gateway HTTP media-routes; throws caught by Hono framework error-handler boundary (web exception).",
    removedIn: "permanent",
  },
  // ----- memory package (6 files) -----
  {
    file: "packages/memory/src/memory-api.ts",
    lineRanges: [[188, 188]],
    reason: "@allow-throw boundary: MemoryApi.clear() scope-required guard; consumed by daemon memory-handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  // observability-store.ts entry was removed when the file was split into
  // an observability-store/ subdirectory; the @allow-throw
  // unknown-table guard now lives in observability-store/observability-reset.ts
  // which carries a file-level `// @allow-throw:` annotation. The raw-throw
  // rule excludes annotated files before consulting the allowlist, so no
  // replacement entry is required (net shrink-only change, satisfies the
  // allowlist-shrink ratchet by construction).
  {
    file: "packages/memory/src/row-mapper.ts",
    lineRanges: [[193, 193], [218, 218], [223, 223]],
    reason: "@allow-throw boundary: SQL-injection ALLOWED_TABLES/COLUMNS guard; prevents unsafe table/column names from reaching prepare(); consumed by MemoryApi adapter (daemon RPC @allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/schema.ts",
    lineRanges: [[43, 43]],
    reason: "@allow-throw boundary: initSchema embeddingDimensions DDL precondition; consumed at daemon bootstrap entry (daemon.ts catch boundary).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/secret-store-schema.ts",
    lineRanges: [[81, 81], [114, 114], [120, 120]],
    reason: "@allow-throw boundary: master-key canary mismatch must hard-fail; encryption-correctness assertion zone (security-critical; same throw-boundary rationale as web/CLI entry points).",
    removedIn: "permanent",
  },
  {
    file: "packages/memory/src/session-store.ts",
    lineRanges: [[106, 106]],
    reason: "@allow-throw boundary: 10MB session-size guard; consumed by daemon session-handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  // ----- orchestrator package (5 files) -----
  {
    file: "packages/orchestrator/src/cross-session/announcement-dead-letter.ts",
    lineRanges: [[110, 110], [319, 319]],
    reason: "@allow-throw boundary: atomicWrite (line 110) wraps node:fs/promises (writeFile + rename), callers wrap via try/catch (drain() catch at line 325-330). ENOENT re-raise (line 318) is conventional rethrow inside unlink-cleanup pattern, also caught by drain() outer catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/cross-session/cross-session-sender.ts",
    lineRanges: [[95, 95], [101, 101], [129, 129]],
    reason: "@allow-throw boundary: cross-session-sender validation guards (invalid session key, session-not-found, deadlock-risk); consumed via daemon session-handlers (@allow-throw per Decision 2).",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/execution/execution-execute.ts",
    lineRanges: [[217, 217]],
    reason: "@allow-throw boundary: re-raise non-TimeoutError from executeLlm to the inbound orchestrator pipeline (executeAndDeliver -> inbound-route); channel-adapter context catches and converts to user-visible degraded response. Boundary adapter pattern for channel/RPC inbound boundaries.",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/queue/coalescer.ts",
    lineRanges: [[32, 32]],
    reason: "@allow-throw boundary: coalescer precondition guard (>=1 message required); consumed by inbound-pipeline boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/orchestrator/src/queue/priority-scheduler.ts",
    lineRanges: [[177, 177]],
    reason: "@allow-throw boundary: priority-scheduler shutdown guard; consumed by inbound-pipeline boundary catch.",
    removedIn: "permanent",
  },
  // ----- scheduler package (5 files) -----
  {
    file: "packages/scheduler/src/cron/cron-scheduler.ts",
    lineRanges: [[208, 208]],
    reason: "@allow-throw boundary: cron scheduler boundary error; consumed by setup-schedulers daemon-wiring catch (daemon.ts bootstrap).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/cron/cron-store.ts",
    lineRanges: [[96, 96], [136, 136], [152, 152], [172, 172]],
    reason: "@allow-throw boundary: file-IO + lock-acquisition errors in CronStore; consumed via daemon cron-handlers + setup-schedulers (Decision 2 transitive).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/execution/execution-tracker.ts",
    lineRanges: [[149, 149]],
    reason: "@allow-throw boundary: scheduler-execution state-tracking guard; consumed via daemon scheduler wiring catch (daemon.ts bootstrap boundary).",
    removedIn: "permanent",
  },
  {
    file: "packages/scheduler/src/heartbeat/quiet-hours.ts",
    lineRanges: [[30, 30], [35, 35]],
    reason: "@allow-throw boundary: quiet-hours time-format validation guards; consumed via setup-heartbeat daemon-wiring (daemon.ts bootstrap).",
    removedIn: "permanent",
  },
  // ----- skills package (40 files) -----
  {
    file: "packages/skills/src/platform-tools/tool-helpers.ts",
    lineRanges: [[70, 70], [175, 175], [180, 180], [202, 202], [207, 207], [229, 229], [234, 234]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/platform-tools/tools/obs-query-tool.ts",
    lineRanges: [[224, 224]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/platform-tools/tools/pipeline-tool.ts",
    lineRanges: [[592, 592]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/platform-tools/tools/subagents-tool.ts",
    lineRanges: [[143, 143]],
    reason: "@allow-throw boundary: platform-tool boundary; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/skills/bridge/credential-injector.ts",
    lineRanges: [[115, 115], [124, 124], [258, 258]],
    reason: "@allow-throw boundary: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/skills/bridge/tool-audit.ts",
    lineRanges: [[71, 71]],
    reason: "@allow-throw boundary: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/skills/bridge/tool-metadata-enforcement.ts",
    lineRanges: [[87, 87], [97, 97]],
    reason: "@allow-throw boundary: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/browser-service.ts",
    lineRanges: [[220, 220], [223, 223]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/cdp.ts",
    lineRanges: [[61, 61]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/chrome-detection.ts",
    lineRanges: [[191, 191], [265, 265]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/playwright-session.ts",
    lineRanges: [[357, 357], [451, 451]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/profiles.ts",
    lineRanges: [[70, 70]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/browser/screenshots.ts",
    lineRanges: [[68, 68], [78, 78]],
    reason: "@allow-throw boundary: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/edit-tool.ts",
    lineRanges: [[150, 150], [211, 211], [220, 220], [231, 231], [248, 248], [261, 261], [269, 269], [276, 276], [283, 283], [300, 300], [336, 336], [340, 340], [344, 344], [348, 348], [352, 352], [354, 354]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/find-tool.ts",
    lineRanges: [[105, 105]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/grep-tool.ts",
    lineRanges: [[158, 158], [279, 279], [287, 287], [435, 435], [486, 486]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/ls-tool.ts",
    lineRanges: [[92, 92], [158, 158]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/notebook-edit-tool.ts",
    lineRanges: [[137, 137], [145, 145], [160, 160], [166, 166], [175, 175], [186, 186], [195, 195], [201, 201], [206, 206], [213, 213], [223, 223], [233, 233], [248, 248]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/read-tool.ts",
    lineRanges: [[326, 326], [389, 389], [402, 402], [408, 408], [422, 422], [424, 424], [475, 475]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/shared/edit-diff.ts",
    lineRanges: [[228, 228], [230, 230], [270, 270], [306, 306], [310, 310], [318, 318], [322, 322], [354, 354], [372, 372], [376, 376]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file-tools/write-tool.ts",
    lineRanges: [[133, 133], [187, 187], [195, 195], [204, 204], [211, 211], [229, 229], [282, 282], [292, 292], [316, 316], [327, 327]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file/apply-patch-tool.ts",
    lineRanges: [[336, 336]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/file/path-suggest.ts",
    lineRanges: [[42, 42]],
    reason: "@allow-throw boundary: file-tool validation guards; throws caught by AgentTool wrapper (returns AgentToolResult) — agent execution boundary catch.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/process-registry.ts",
    lineRanges: [[236, 236], [239, 239]],
    reason: "@allow-throw boundary: builtin tool boundary; throws caught by AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/tool-provisioner.ts",
    lineRanges: [[180, 180], [190, 190], [215, 215], [245, 245]],
    reason: "@allow-throw boundary: builtin tool boundary; throws caught by AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-brave.ts",
    lineRanges: [[146, 146]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-duckduckgo.ts",
    lineRanges: [[190, 190]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-exa.ts",
    lineRanges: [[76, 76]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-grok.ts",
    lineRanges: [[101, 101]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-jina.ts",
    lineRanges: [[67, 67], [92, 92]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-perplexity.ts",
    lineRanges: [[125, 125]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-searxng.ts",
    lineRanges: [[41, 41], [44, 44], [92, 92]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/builtin/web-search-tavily.ts",
    lineRanges: [[76, 76], [82, 82]],
    reason: "@allow-throw boundary: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/integrations/image-gen/fal-adapter.ts",
    lineRanges: [[39, 39], [44, 44]],
    reason: "@allow-throw boundary: integration/SDK boundary wrapper; throws caught by AgentTool wrapper at consumer site.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/integrations/image-gen/openai-adapter.ts",
    lineRanges: [[36, 36]],
    reason: "@allow-throw boundary: integration/SDK boundary wrapper; throws caught by AgentTool wrapper at consumer site.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/media/media-temp.ts",
    lineRanges: [[94, 94], [123, 123]],
    reason: "@allow-throw boundary: media-tool boundary; throws caught by AgentTool wrapper (image/video/audio tools) or upstream fromPromise() converter.",
    removedIn: "permanent",
  },
  {
    file: "packages/skills/src/tools/media/ssrf-fetcher.ts",
    lineRanges: [[226, 226], [236, 236], [255, 255], [278, 278], [282, 282], [297, 297]],
    reason: "@allow-throw boundary: media-tool boundary; throws caught by AgentTool wrapper (image/video/audio tools) or upstream fromPromise() converter.",
    removedIn: "permanent",
  },
  // ----- web package (1 files) -----
  {
    file: "packages/web/src/api/api-client.ts",
    lineRanges: [[171, 171], [175, 175], [212, 212], [231, 231]],
    reason: "@allow-throw boundary: web API client dev-time validation guards; consumed by Lit element error-handler boundary (web user-facing flows exception).",
    removedIn: "permanent",
  },
  // ----- web package permanent (1 file) -----
  // requireGlobalState helper throws
  // GlobalStateNotInitializedError when a Lit element queries GlobalState
  // before firstUpdated() completes. The throw is the correct boundary
  // signal — Lit catches it at the lifecycle boundary and surfaces it to
  // the element's error handler. The web user-facing flows exception
  // sanctions this; the file also bears the `@allow-throw:`
  // annotation so this entry is defense-in-depth.
  {
    file: "packages/web/src/state/global-state.ts",
    lineRanges: [[168, 168]],
    reason: "GlobalStateNotInitializedError — Lit lifecycle invariant; caught at framework boundary (web user-facing flows exception).",
    removedIn: "permanent",
  },
] as const;
export const untypedSqliteAllowlist: readonly UntypedSqliteAllowlistEntry[] = [
  // ============================================================================
  // TypeScript hygiene — closed via RowMapper<TRow>
  // ============================================================================
  // Every entry below records one `{file, symbol}` cast site in
  // packages/memory/src/ that currently uses the unsafe
  // `.all(...) as Type[]` / `.get(...) as Type` form. The hygiene work
  // introduces the typed `RowMapper<TRow>` factory and retargets every
  // site to `mapper.parseRows(...)` / `mapper.parseOptionalRow(...)`;
  // each retarget closes one entry in this list atomically.
  //
  // The `symbol` field captures the FIRST `\w+` after `as ` per the rule's
  // regex (e.g. `.get(...) as Row | undefined` records symbol "Row"; the
  // union pipe truncation is intentional). For `as Array<{...}>` casts the
  // symbol is "Array" (the angle-bracketed generic body does not match
  // `\w+`).
  //
  // The allowlist key is `{file, symbol}`: multiple raw cast sites in the same
  // file that target the same `symbol` collapse into one entry. The live grep
  // yielded 61 raw cast sites collapsing to 35 unique pairs across 14 files.

  // context-store.ts — DRAINED.
  // Previously held 8 `{file, symbol}` entries for {Array (inline id-projection
  // and FTS hit shapes), CtxConversationRow, CtxMessageRow, CtxMessagePartRow,
  // CtxSummaryRow, CtxContextItemRow, CtxLargeFileRow, CtxExpansionGrantRow}.
  // All 17 cast sites retargeted to mapper.parseRows / parseOptionalRow with
  // degrade-on-validation-error semantics (preserves ContextStorePort plain-
  // return contract for the 16 production-file consumers in agent + daemon).

  // credential-mapping-store.ts — DRAINED.

  // delivery-mirror-adapter.ts — DRAINED.
  // Result-returning port; mapper failure flows through err() to the
  // existing try/catch wrapper.

  // delivery-queue-adapter.ts — DRAINED.

  // embedding-cache-sqlite.ts — DRAINED.

  // hybrid-search.ts — DRAINED.

  // identity-link-store.ts — DRAINED.

  // memory-api.ts — DRAINED.

  // named-graph-store.ts — DRAINED.

  // oauth-profile-store-encrypted.ts — DRAINED.

  // observability-store.ts — DRAINED.
  // Previously held 9 `{file, symbol}` entries for {TokenUsageDbRow,
  // DeliveryDbRow, DiagnosticDbRow, ChannelSnapshotDbRow, ProviderAggDbRow,
  // AgentAggDbRow, SessionAggDbRow, HourlyBucketDbRow, DeliveryStatsDbRow}.
  // Every site retargets to mapper.parseRows / parseOptionalRow with
  // degrade-on-validation-error (observability metrics are non-fatal —
  // see file header for the chosen Option 2 rationale).

  // row-mapper.ts — DRAINED.
  // The mapper module's own internal countRows / groupCountRows projections
  // now go through local schemas + createRowMapper (self-closing).

  // session-store.ts — DRAINED.

  // sqlite-memory-adapter.ts — DRAINED.

  // sqlite-secret-store.ts — DRAINED.
] as const;
export const optionalFieldAllowlist: readonly OptionalFieldAllowlistEntry[] = [
  // ============================================================================
  // Per-declaration audit (final state)
  // ============================================================================
  // NOTE: ChannelManagerDeps (44 optional fields, channel-manager.ts:83) is NOT
  // in this list — it is hard-excluded by the rule itself because its audit is
  // owned elsewhere. Re-adding it here is a contract violation.
  //
  // Audit outcome:
  //   - Reviewed each interface declaration line-by-line + every construction
  //     site (single composition-root callers for the daemon deps bags, plus
  //     CLI / API / wizard / DTO consumers).
  //   - Classification taxonomy: (a) Genuinely conditional — fields capture
  //     real config-driven variance with documented per-field rationale; KEEP
  //     with specific reason. (b) Clustered-optional — interface mixes 2-3
  //     distinct concerns; KEEP with future-refactor note recommending a
  //     concern-split. (c) Cosmetic over-optional-marking — fields marked `?`
  //     but supplied at every construction site; would DELETE entry + require
  //     fields. ZERO entries classified as (c).
  //   - Final count: 25 (unchanged). The audit gate has no target floor — the
  //     audit decisions ARE the gate. Audit-driven shrinkage, not mandate-to-
  //     count: most >12-optional-field interfaces are kept with documented
  //     reason; per-interface inspection confirmed no entry survived as
  //     cosmetic over-optional marking.
  //
  // Why no cosmetic deletions: every audited interface fell into one of three
  // genuine-variance patterns:
  //   1. Dependency-injection bags whose optional fields gate on config
  //      booleans, secret/credential presence, or feature-flag state. The
  //      single construction site at the composition root passes
  //      `undefined` (or omits the key) when the underlying conditional is
  //      false — e.g. setup-agents.ts:641 `authRotation = authProfileManager
  //      ? createAuthRotationAdapter(...) : undefined`. Marking these
  //      required would force the daemon to manufacture placeholders.
  //   2. Wire-protocol / DTO shapes where field absence is semantic
  //      (e.g. SessionEntry's dual `key | sessionKey` from daemon-side RPC
  //      schema migration; AgentDetail.heartbeat.target absent = agent has
  //      no scheduled delivery target). Tightening these would break the
  //      JSON shape contract.
  //   3. Mutually-exclusive directive / option bags where one invocation
  //      sets ONE field (CommandDirectives is the canonical case: a single
  //      `/think medium` or `/model claude-sonnet` sets one key; every
  //      other directive field stays `undefined`).
  //
  // Future refactor flag (cluster-split candidates marked `(b)` below): some
  // large deps bags mix 2-3 concerns and could be split into sub-interfaces
  // for clarity. The architectural test would still pass after the split
  // (each sub-interface stays under the 12-optional threshold). KISS/YAGNI
  // says defer until a real refactor wave brings the structural improvement.

  // -- (b) Clustered-optional deps bags: split candidates for a future refactor --
  {
    file: "packages/agent/src/executor/pi-executor/pi-executor-types.ts",
    typeName: "PiExecutorDeps",
    optionalCount: 42,
    reason: "(b) Cluster-split candidate: optionals mix 8 concerns (safety controls, adapters/registries, tool wiring, media/prompts, provider compatibility, secret/output guards, delivery/cache, observability ports). Every optional field documented per-line; construction site (setup-agents.ts:645) conditionally supplies values from config + AppContainer. Future refactor: split into PiExecutorSafetyDeps + PiExecutorToolingDeps + PiExecutorProviderDeps + PiExecutorObservabilityDeps. (keep until structural refactor wave; path + count updated post-split — interface moved to pi-executor-types.ts to break the no-cycles invariant; one optional field consolidated during the move).",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/inbound/inbound-pipeline.ts",
    typeName: "InboundPipelineDeps",
    optionalCount: 40,
    reason: "(b) Cluster-split candidate: optionals mix the 5 inbound-pipeline phases (resolve, preprocess, gate, setup, route) plus auxiliary concerns (voice pipeline, delivery queue, command/approval handling, debounce/group history buffers). Each `?` field is wired only when the corresponding feature is configured (e.g. approvalGate present only when approval workflow enabled). Future refactor: per-phase sub-Deps interfaces..",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bootstrap/system-prompt-assembler.ts",
    typeName: "AssemblerParams",
    optionalCount: 34,
    reason: "(b) Cluster-split candidate: prompt-section assembly params — every `?` corresponds to ONE prompt section (skills XML, attribution, language hint, sub-agent role, sender trust, documentation, media directives, SEP, MCP inheritance, runtime info, etc). Each section's `includeIn` set determines whether the corresponding param is read in a given PromptMode; absent params skip the section. Future refactor: group by section family (identity / safety / tooling / media / sub-agent)..",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/types.ts",
    typeName: "RequestBodyInjectorConfig",
    optionalCount: 32,
    reason: "(b) Cluster-split candidate: stream-wrapper config combines cache-control breakpoint strategy, beta-header latches, microcompact triggers, tool-deferral hooks, cadence trackers, eviction cooldown. Each callback/getter is wired ONLY when the corresponding feature path is active (e.g. sub-agent spawn sets `skipCacheWrite + cacheWriteTimestamp + parentCacheRetention`; root-agent execution leaves them undefined). Future refactor: split into CacheBreakpointConfig + ToolDeferralConfig + MicroCompactConfig. (file path updated post-split).",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/bridge/pi-event-bridge.ts",
    typeName: "PiEventBridgeDeps",
    optionalCount: 30,
    reason: "(b) Cluster-split candidate: event-bridge deps mix runtime callbacks (onAbort, onAbortRetry, onCacheReads, onTurnUsage) + safety controls (contextGuard, providerHealth, compactionSettings) + SEP execution-plan tracking + thinking-block hash diagnostics + drain-state gates. Construction site (pi-executor.ts:1173) supplies subsets based on per-execution feature flags (sepEnabled, capturedBridgeRetention). Future refactor: split runtime callbacks from observability sinks..",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-channels/setup-channels-registry.ts",
    typeName: "ChannelsDeps",
    optionalCount: 26,
    reason: "(b) Cluster-split candidate: channel-bootstrap deps span media handling (transcriber, ttsAdapter, audioConverter, imageAnalyzer, fileExtractor — each gated by config presence + native dep availability), session lifecycle (piSessionAdapters, costTrackers), inbound-routing callbacks (onMessageReceived, onMessageProcessed), and per-agent cron tracker maps. Single composition-root caller (daemon.ts:1594) builds optionals from config flags. Future refactor: split media-deps + session-tracking-deps from core channel-deps. Re-targeted from setup-channels.ts after split.",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    typeName: "SpawnParams",
    optionalCount: 25,
    reason: "(b) Cluster-split candidate: spawn-call options mix top-level routing (announceChannel*, callerSession/Agent, requesterOrigin), graph-pipeline coordination (graphId, nodeId, graphSharedDir, graphTraceId, graphToolNames, graphNodeDepth, isLeafNode), and execution overrides (model, max_steps, expected_outputs, artifactRefs, objective, domainKnowledge, toolGroups, includeParentHistory, reuseSessionKey). Direct vs graph-driven spawns set different subsets — e.g. graph nodes set graphId+nodeId+graphToolNames, direct chat spawns leave them undefined. Future refactor: split into SpawnRouting + SpawnGraphMeta + SpawnExecutionOverrides..",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/non-interactive.ts",
    typeName: "NonInteractiveOptions",
    optionalCount: 25,
    reason: "(b) Cluster-split candidate: CLI flag bag pre-grouped by `// Core / Gateway / Channels / Paths / Behavior` comment dividers — comment structure proves the conceptual clustering already exists. Each group's fields are independently optional (a CI invocation may set only --gateway-port + --gateway-token; another may set --channels + per-platform tokens). Future refactor: split type into the 5 groups already commented in source. Cannot mark required without forcing every CLI invocation to specify every flag..",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/executor-post-execution.ts",
    typeName: "PostExecutionBridgeResult",
    optionalCount: 22,
    reason: "(a) Per-turn outcome aggregation: every `?` reflects real variance in what a single execution produced — cache write tokens only when caching active, signature scrubs only when scrubber fired, thinkingTokens only on reasoning-capable models, hashAssertion* only when bridge ran the cross-turn assertion path. Marking required would force the bridge to manufacture zeros at every callsite where the feature was inactive — losing the 'feature inactive' signal that downstream consumers (cost gates, observability) check via `field === undefined`..",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-agents/setup-agents-types.ts",
    typeName: "SingleAgentDeps",
    optionalCount: 21,
    reason: "(a) Daemon-internal per-agent deps; every `?` field gates on a daemon-global resource being wired (providerHealth, lastKnownModel, embeddingPort, deliveryMirror, geminiCacheManager — each is undefined unless the corresponding subsystem started successfully). The `secretsCrypto?` + `secretsDb?` pair is conditional on `oauth.storage === 'encrypted'` config. Construction site at setup-agents-registry.ts wires from setupMemory/setupSecrets results. Re-targeted from setup-agents.ts to setup-agents-types.ts after split.",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/wiring/setup-shutdown.ts",
    typeName: "ShutdownDeps",
    optionalCount: 22,
    reason: "(a) Shutdown handle aggregator; every `?` field is a subsystem that MAY not be running at shutdown time (graphCoordinator absent in single-agent deployments, channelManager absent if no channels configured, heartbeatRunner absent if heartbeats disabled, mediaTempManager absent if media features off, etc). Marking required would force composition-root to fabricate no-op stubs; instead shutdown.ts:withStepTimeout skips absent subsystems..",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/execution/execution-pipeline.ts",
    typeName: "ExecutionPipelineDeps",
    optionalCount: 19,
    reason: "(b) Cluster-split candidate: orchestrator's execution-pipeline deps include retry/followup machinery (retryEngine, followupTrigger, followupConfig), media pipeline (parseOutboundMedia, outboundMediaFetch, voiceResponsePipeline), streaming/policy config, command queue, response-prefix templating. Each is optional because feature paths are independently gated. Future refactor: split into ExecutionRetryDeps + ExecutionMediaDeps + ExecutionStreamingDeps..",
    removedIn: "phase-D",
  },
  // ToolAssemblyDeps moved to executor-tool-assembly-types.ts (Phase 153 file-size
  // split) and now carries an in-file `@optional-field-count` audit stamp — entry
  // removed (shrink-only ratchet allows removals).
  {
    file: "packages/web/src/api/types/agent-types.ts",
    typeName: "AgentDetail",
    optionalCount: 18,
    reason: "(a) Wire-protocol DTO mirroring the `agents.get` RPC response shape. Each `?` field corresponds to a config section that may be absent for any given agent (no heartbeat config → no `heartbeat.target`; no concurrency overrides → no `concurrency`; no broadcastGroups → undefined). The dual flat-and-nested layout is intentional: the web SPA reads each top-level group as a renderable card. Marking required would force the daemon to emit zero-valued placeholders for every absent feature, breaking the 'feature inactive' UI signal..",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/graph/graph-coordinator-state.ts",
    typeName: "GraphCoordinatorDeps",
    optionalCount: 16,
    reason: "(b) Cluster-split candidate: graph-coordinator deps span subagent spawning (spawn/kill/getRunStatus surface), per-channel announcement plumbing (sendToChannel, announceToParent), tuning knobs (maxConcurrency, maxResultLength, graphRetentionMs, maxParallelSpawns, maxGlobalSubAgents, spawnStaggerMs, cacheWriteTimeoutMs — each defaulted in factory), and observability/batching extras (logger, batcher, activeRunRegistry, nodeTypeRegistry, preWarm, touchParentSession). Future refactor: split into GraphSpawnDeps + GraphAnnounceDeps + GraphTuningConfig..",
    removedIn: "phase-D",
  },
  {
    file: "packages/web/src/views/config-editor/schema-form.ts",
    typeName: "SchemaProperty",
    optionalCount: 16,
    reason: "(a) JSON Schema mirror: each `?` field corresponds to ONE JSON Schema keyword (type, description, properties, items, enum, minimum, maximum, minLength, maxLength, pattern, required, default, anyOf, oneOf, allOf, additionalProperties). Any individual JSON Schema declares only the subset of keywords relevant to its node — e.g. a `{ type: 'integer', minimum: 0 }` carries no `pattern` or `items`. This matches the JSON Schema spec semantics; tightening would force the editor to emit empty arrays/objects for every schema node..",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/context-engine/types-core.ts",
    typeName: "ContextEngineDeps",
    optionalCount: 15,
    reason: "(b) Cluster-split candidate: ContextEngineDeps mixes pipeline-layer getters (getSessionManager, getCompactionDeps, getRehydrationDeps — each `undefined` removes that layer from the pipeline), observability sinks (eventBus, agentId, sessionKey for log-context), feature callbacks (onContentModified, onAnchorReset, onSignatureReplayScrubbed), and replay-drift / token-anchor / thinking-keep override getters. Future refactor: split into ContextPipelineLayerDeps + ContextObservabilityDeps + ContextRecoveryDeps..",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/executor/command-directive-types.ts",
    typeName: "CommandDirectives",
    optionalCount: 14,
    reason: "(a) Mutually-exclusive directive bag: parsing a single slash command (`/think medium`, `/model claude-sonnet`, `/branch xyz`, `/reset`, `/compact verbose`, `/budget 500k`, etc.) sets ONE of the 14 fields; all others are `undefined`. The shape is the AGENT-LOCAL MIRROR of orchestrator's CommandDirectives (intentional duplication to break a packaging cycle — see file header lines 1-32). Marking required would force every parse to populate all 14 directives..",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/commands/sessions.ts",
    typeName: "SessionEntry",
    optionalCount: 14,
    reason: "(a) Dual-naming wire-compat shape (file:30 — 'Supports both canonical field names and daemon RPC field names'): `key|sessionKey`, `user|userId`, `channel|channelId`, `lastActive|updatedAt` carry the legacy + canonical names so the CLI renderer can fall back via nullish coalescing (file:125 `s.sessionKey ?? s.key ?? '-'`). Tightening either side would break the RPC-shape migration safety net..",
    removedIn: "phase-D",
  },
  {
    file: "packages/cli/src/wizard/types.ts",
    typeName: "WizardState",
    optionalCount: 14,
    reason: "(a) Immutable state accumulator (per file:128 JSDoc: 'All fields are optional because they get filled as steps execute'). Each wizard step's `execute(state)` reads only the fields populated by prior steps and returns a new state with its own field populated. Marking required would force INITIAL_STATE to fabricate placeholders for every field; the file explicitly documents this as the intended pattern..",
    removedIn: "phase-D",
  },
  {
    file: "packages/orchestrator/src/commands/types.ts",
    typeName: "CommandDirectives",
    optionalCount: 14,
    reason: "(a) Mutually-exclusive directive bag (orchestrator side of the agent-local-mirror pair documented in command-directive-types.ts:1-32). Slash-command parser sets ONE field per invocation; all others stay `undefined`. Identical optional-field structure to agent's mirror by maintenance contract — both must move in lockstep. Marking required would force every slash-command parse to emit all 14 fields..",
    removedIn: "phase-D",
  },
  {
    file: "packages/agent/src/spawn/sub-agent-runner.ts",
    typeName: "SubAgentRunnerDeps",
    optionalCount: 13,
    reason: "(a) Audited with documented when-absent behavior in packages/agent/AUDIT.md per field: logger (no-op silent diagnostics), memoryAdapter (no completion-summary persistence), batcher (per-spawn announcements not coalesced), deadLetterQueue (failed announcements dropped after retry budget), activeRunRegistry/sessionResolver (no abort-on-kill capability), resultCondenser/condenserModel/condenserApiKey (raw subagent output passes through unmodified), narrativeCaster (no tagged narrative wrapping), dataDir (defaults to process cwd for subagent-results), lifecycleHooks (no prepare-spawn rollback hooks). Boundary value: 13 optionals exceeds 12-threshold by exactly 1; future refactor would require removing one rarely-used field. (see also the architecture-test in packages/agent/src/__tests__/architecture.test.ts).",
    removedIn: "phase-D",
  },
  {
    file: "packages/daemon/src/daemon-types.ts",
    typeName: "DaemonOverrides",
    optionalCount: 13,
    reason: "(a) Test injection bag (per file:111 JSDoc 'Overrides for dependency injection during testing'). Every `?` field is `typeof <productionFactory>` — production passes NONE of them; integration tests override the subset they want to fake (e.g. `timers: createFakeTimers()` for the .unref() preservation assertion at packages/daemon/src/__tests__). Marking required would force production daemon.ts to explicitly pass every production factory back through itself — pointless ceremony..",
    removedIn: "phase-D",
  },
  {
    file: "packages/skills/src/platform-tools/registry.ts",
    typeName: "PlatformToolBuildContext",
    optionalCount: 13,
    reason: "(a) Tool-specific predicate signals (per file:95 JSDoc): each `?` corresponds to ONE platform tool's wiring requirement (approvalGate for tools needing approval, imageGenProvider for image_generate, backgroundTaskManager for background_tasks, toolCapabilityPort for capability index, contextEngineVersion for unified_context (gated on 'dag'), builtinToolsBrowserEnabled + browserSanitizeImage + browserPersistMedia + browserWorkspaceDir for the browser tool). Each descriptor's `conditional(ctx)` predicate inspects only the field it needs; marking all required would force unrelated tools to receive `undefined`-equivalent fabricated values..",
    removedIn: "phase-D",
  },
] as const;
// ============================================================================
// globalsAllowlist (CLOSED)
//
// One entry per current callable-global site outside the bootstrap-allowlist
// paths in BOOTSTRAP_PATH_PATTERNS (test/support/globals-classifier.ts).
//
// Closure state (final drain): every direct-global port-retarget entry has
// been drained. Production source files in packages/{shared,core,
// agent,channels,cli,daemon,gateway,memory,orchestrator,scheduler,skills}/src/
// either consume ClockPort/EnvPort/TimerPort via injected Deps (Pattern A),
// indirect through @comis/core/runtime/system-time.ts sanctioned helpers
// (Pattern B), or live in a sanctioned root exempt from the classifier rule
// (BOOTSTRAP_PATH_PATTERNS). No retarget entry outlives its closure.
//
// The remaining entries below are NOT retarget debt — they are
// permanent architectural carve-outs for the web SPA browser bundle:
// packages/web/src/api/ is a leaf seam that the web boundary contract
// forbids from importing any @comis/* workspace package (the SPA must
// work without a pnpm install). The direct setTimeout / setInterval /
// clearTimeout / Date.now calls in api-client.ts and rpc-client.ts are
// the right shape for a browser-resident bundle, and their classifier
// hits are sanctioned by the web boundary contract rather than expected
// to drain.
//
// Future regressions: any new outside-sanctioned-root direct-global call in
// packages/*/src/ MUST either retarget through the appropriate port at the
// composition root or be added here as a carve-out with a real reason. If
// you're adding an entry, an architectural decision was missed — surface it
// before committing.
// ============================================================================
export const globalsAllowlist: readonly GlobalsAllowlistEntry[] = [
  // ============================================================================
  // Direct-global-call closure (retargeted to ports).
  // Final state: zero retarget entries remain;
  // only the web/api seam carve-outs (below) are kept.
  // Grouped by package, then sorted by file/line for stable diffs.
  // ============================================================================
  // ---- agent ----
  //packages/agent/src/background/background-task-manager.ts
  // retargeted to ClockPort/TimerPort via injected deps. Drained 15 entries.
  // agent/executor cohort retargeted to ClockPort/EnvPort/TimerPort.
  // Drained 75 globals entries across 22 files. Remaining 2 entries in cache-break-diff-writer.ts
  // are new Date(arg) parsing calls (not clock reads); kept as allowlist entries.
  // safety/circuit-breaker.ts retargeted to ClockPort. Drained 3 entries.
  //packages/agent/src/spawn/sub-agent-runner.ts
  // retargeted to ClockPort/TimerPort via injected deps. Drained 25 entries.
  // ---- channels ----
  // ---- cli ----
  // ---- core ----
  // ---- daemon ----
  //setup-background-tasks.ts setInterval retargeted to
  // deps.timers.setInterval. Drained 1 entry.
  //setup-cross-session.ts line numbers bumped due to
  // ClockPort/TimerPort thread-through into createSubAgentRunner. Underlying
  // globals here are scoped for follow-on daemon wiring helper retargets.
  //setup-schedulers.ts line numbers bumped +4 due to
  // ClockPort/TimerPort thread-through. Underlying globals here are scoped
  // for follow-on daemon wiring helper retargets; kept as allowlist entries
  // pointing at the new line numbers.
  // ---- gateway ----
  // ---- memory ----
  // ---- orchestrator ----
  // ---- scheduler ----
  // ---- shared ----
  // packages/shared/src/timeout.ts
  // setTimeout/clearTimeout entries DRAINED. `withTimeout` no longer reads
  // either global — it takes a `scheduleTimeout: (cb, ms) => () => void`
  // callback that every consumer constructs from its TimerPort (Pattern A)
  // or `systemScheduleTimeout` from `@comis/core/runtime` (Pattern B).
  // The callback signature is a bare structural type, so `@comis/shared`
  // imports zero port types and remains a leaf.
  // ---- skills ----
  // ---- web ----
  
  {
    file: "packages/web/src/api/api-client.ts",
    line: 439,
    global: "Date.now",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/api-client.ts",
    line: 440,
    global: "Date.now",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 105,
    global: "clearInterval",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 109,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 116,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 123,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 131,
    global: "setInterval",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 138,
    global: "setTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 150,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 157,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 161,
    global: "setTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 183,
    global: "setTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 229,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 299,
    global: "setTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
  {
    file: "packages/web/src/api/rpc-client.ts",
    line: 320,
    global: "clearTimeout",
    reason: "Web SPA api/ seam — the web boundary contract forbids @comis/* imports; direct global is required for the browser bundle",
    removedIn: "phase-B",
  },
] as const;
export const noBackwardCompatAllowlist: readonly NoBackwardCompatAllowlistEntry[] = [] as const;
export const coverageWaiver: readonly CoverageWaiverEntry[] = [
  {
    file: "packages/agent/src/executor/cache-detection/cache-state-types.ts",
    reason: "Pure type-only module from a split. 8 public interfaces + 1 union type; no runtime values to test. Type-level surface is verified by the parity test (cache-break-detection.parity.test.ts) and by the consumers that compile-check the imports.",
  },
  {
    file: "packages/agent/src/executor/cache-detection/index.ts",
    reason: "Barrel re-export module from a split. Re-exports 18 canonical public symbols from 4 leaf modules without aliases or transformation; surface is verified by the parity test (cache-break-detection.parity.test.ts).",
  },
  // -- request-body/ split --
  // The Rule-3 split of request-body-injector.ts produced 22 modules. The 4
  // module-aligned test neighbors (factory.test.ts, cache-breakpoints.test.ts,
  // breakpoint-placement.test.ts, tool-result-clearing.test.ts) cover ~95% of
  // the surface. The remaining 18 modules are waived below because they are
  // either pure types, barrels, or factory-pipeline phase extractions whose
  // behavior is exercised end-to-end by factory.test.ts (the renamed-and-
  // shrunk 6,800L integration suite — was request-body-injector.test.ts).
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/index.ts",
    reason: "Barrel re-export module from a split. Re-exports 15 canonical public symbols + RequestBodyInjectorConfig type from sibling leaf modules without aliases; surface is verified by the parity test (request-body-injector.parity.test.ts) and stream-wrappers/index.test.ts.",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/types.ts",
    reason: "Pure type-only module from a split. Hosts RequestBodyInjectorConfig (32 optional fields); no runtime values to test. Type-level surface is verified by the parity test + compile-time imports.",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/cache-control-block.ts",
    reason: "Internal leaf from a split. Hosts CACHEABLE_BLOCK_TYPES + addCacheControlToLastBlock. Public symbols are tested via cache-breakpoints.test.ts (re-exports the canonical names).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/cadence-tracker.ts",
    reason: "Module-state extraction from a split (sessionCadenceTracker + threshold constants + clearSessionCadenceTracker). State mutated by the factory; behavior covered by factory.test.ts (sticky-on / promotion-on-slow-cadence flows).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/context-window.ts",
    reason: "Module-state extraction from a split (sessionBetaHeaderLatches + CONTEXT_1M_BETA + parseHeaderList + clearSessionBetaHeaderLatches). State mutated by the factory; behavior covered by factory.test.ts (sticky-on beta header latches flow).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/service-tier.ts",
    reason: "Leaf injector from a split —Concern 3 (service_tier flag for Responses API + fastMode). Behavior covered by factory.test.ts (service_tier integration tests inside createRequestBodyInjector).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/store-flag.ts",
    reason: "Leaf injector from a split —Concern 4 (store flag for Responses API + storeCompletions) + isResponsesApiProvider helper. Behavior covered by factory.test.ts (store integration tests inside createRequestBodyInjector).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/token-estimation.ts",
    reason: "Single-function leaf from a split(estimateBlockTokens). Behavior covered by factory.test.ts (TTL estimation cleanup).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/tool-cache.ts",
    reason: "Factory phase from a split(rendered tool cache + per-tool memoization). Behavior covered by factory.test.ts (Rendered tool cache, all-deferred tool hash skip, per-tool content-addressed memoization).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/microcompact.ts",
    reason: "Factory phase from a split(runTimeBasedMicrocompact + runTokenCeilingMicrocompact). Behavior covered by factory.test.ts (Time-based microcompact, token-ceiling microcompact, selective tool-type clearing, dual-category tool clearing, fence-aware microcompaction).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/prefix-stability.ts",
    reason: "Factory phase from a split(runPrefixStabilityDiagnostic). Behavior covered by factory.test.ts (prefix stability diagnostic describe inside skipCacheWrite shared-prefix marker placement).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/breakpoint-orchestration.ts",
    reason: "Factory phase from a split (runCacheBreakpointPhase — Concern 1: multi-block system prompt, defer_loading, graph-context, placement, cache fence callback). Behavior covered by factory.test.ts (createRequestBodyInjector, Multi-block system prompt injection, breakpoint cap increase, breakpoint strategy config, Rendered tool cache, defer_loading injection, skipCacheWrite for sub-agent spawns, Per-model kill switch, zone-aware retention).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/cadence-tracking.ts",
    reason: "Factory phase from a split(trackRecentZoneCadence — post-payload cadence promote/demote). Behavior covered by factory.test.ts (zone-aware retention describe: recent-zone promotion on slow cadence + demotion on fast cadence).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/marker-upgrade.ts",
    reason: "Factory phase from a split(upgradeSdkMarkers — SDK 5m → 1h upgrade when retention is long). Behavior covered by factory.test.ts (zone-aware retention, TTL estimation cleanup describe).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/skip-cache-write-marker.ts",
    reason: "Factory phase from a split(placeSkipCacheWriteMarker — shared-prefix marker for sub-agent spawns). Behavior covered by factory.test.ts (skipCacheWrite for sub-agent spawns, skipCacheWrite shared-prefix marker placement).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/kill-switch.ts",
    reason: "Factory phase from a split(applyKillSwitch — strip all cache_control when retention=none). Behavior covered by factory.test.ts (Per-model kill switch strips ALL cache_control markers).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/ttl-split-estimation.ts",
    reason: "Factory phase from a split(estimateTtlSplit — per-TTL token attribution via onTtlSplitEstimate). Behavior covered by factory.test.ts (TTL estimation cleanup).",
  },
  {
    file: "packages/agent/src/executor/stream-wrappers/request-body/tool-deferral-injection.ts",
    reason: "Factory phase from a split(injectToolDeferral — defer_loading injection + server-side tool_search swap). Behavior covered by factory.test.ts (createRequestBodyInjector — defer_loading injection).",
  },
  // -- prompt-runner/ split --
  {
    file: "packages/agent/src/executor/prompt-runner/index.ts",
    reason: "Barrel re-export module from a split. Re-exports 4 canonical public symbols (runPrompt + 3 interfaces) from sibling leaf modules without aliases; surface is verified by the parity test (executor-prompt-runner.parity.test.ts) and by the dependency-direction structural test.",
  },
  {
    file: "packages/agent/src/executor/prompt-runner/prompt-runner-types.ts",
    reason: "Pure type-only module from a split. Hosts 3 public interfaces (PromptRunnerBridge, RunPromptParams, PromptRunResult); no runtime values to test. Type-level surface is verified by the parity test (executor-prompt-runner.parity.test.ts) + compile-time imports.",
  },
  {
    file: "packages/agent/src/executor/prompt-runner/failure-path.ts",
    reason: "Sub-module of output-escalation.ts (failure-path overflow recovery + error classification + timeout ghost-cost emission + OutputGuard error scan). Was extracted to keep output-escalation.ts under the 500L cap. Each downstream symbol is independently tested (overflow-recovery.test.ts, error-classifier.test.ts, executor-response-filter.test.ts); end-to-end failure-path semantics are exercised by the integration suite.",
  },
  // -- pi-executor/ split --
  {
    file: "packages/agent/src/executor/pi-executor/index.ts",
    reason: "Barrel re-export module from a split. Re-exports 3 canonical public values (createPiExecutor + createBeforeToolCallGuard + mergeSessionStats) + 1 type (PiExecutorDeps) from sibling leaf modules without aliases; surface is verified by the parity test (pi-executor.parity.test.ts) and by the closure-extraction structural test.",
  },
  {
    file: "packages/agent/src/executor/pi-executor/pi-executor-types.ts",
    reason: "Pure type-only module from a split. Hosts PiExecutorDeps interface (42 optional fields); no runtime values to test. Extracted to a dedicated file to break the cyclic-import detected by no-cycles.test.ts when the closure-extracted helpers (safety-gate, compaction-trigger, etc.) import the type. Type-level surface is verified by the parity test (pi-executor.parity.test.ts) + the cluster-split allowlist entry that tracks the structural state.",
  },
] as const;

/**
 * Test-naming allowlist — see TestNamingAllowlistEntry doc.
 * Captures the current state (434 entries: ~85% predicate-2
 * (min-length), ~15% predicate-3 (use-case shape heuristic miss)). The
 * shrink ratchet (allowlist-shrink.test.ts) enforces this list shrinks
 * over time — adding entries requires PR-review citing the reason.
 */
export const testNamingAllowlist: readonly TestNamingAllowlistEntry[] = [
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 23, kind: "test", text: "yfinance", reason: "Captured(min-length=8; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 24, kind: "test", text: "@scope/pkg", reason: "Captured(min-length=10); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 25, kind: "test", text: "pandas-datareader", reason: "Captured(min-length=17; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 26, kind: "test", text: "yfinance.cache", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 27, kind: "test", text: "Pillow", reason: "Captured(min-length=6; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 31, kind: "test", text: "; rm -rf /", reason: "Captured(min-length=10; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 32, kind: "test", text: "eval()", reason: "Captured(min-length=6; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 33, kind: "test", text: "package with spaces", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 34, kind: "test", text: "", reason: "Captured(min-length=0; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 35, kind: "test", text: "-leading-dash", reason: "Captured(min-length=13; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/cli/src/tooling-fill/validators.test.ts", line: 36, kind: "test", text: "@/no-name", reason: "Captured(min-length=9; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/channels.test.ts", line: 420, kind: "it", text: "accepts response", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/channels.test.ts", line: 451, kind: "it", text: "accepts request", reason: "Captured(min-length=15); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/daemon.test.ts", line: 94, kind: "it", text: "scopes are correct", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/observability.test.ts", line: 437, kind: "it", text: "obs.delivery.stats: response shape", reason: "Captured(use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/observability.test.ts", line: 565, kind: "it", text: "obs.getCacheStats: response shape", reason: "Captured(use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 117, kind: "it", text: "cron-handlers + graph-handlers: all rpc-scoped per setup-gateway-api.ts:130-157 + 317-321", reason: "Captured(use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 227, kind: "it", text: "method name", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 565, kind: "it", text: "response", reason: "Captured(min-length=8; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 598, kind: "it", text: "request requires id", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 728, kind: "it", text: "response", reason: "Captured(min-length=8; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 845, kind: "it", text: "response", reason: "Captured(min-length=8; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/orchestrator.test.ts", line: 891, kind: "it", text: "response", reason: "Captured(min-length=8; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 227, kind: "it", text: "method name", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 293, kind: "it", text: "method name", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 362, kind: "it", text: "method name", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 439, kind: "it", text: "method name", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/core/src/api-contracts/workspace.test.ts", line: 493, kind: "it", text: "method name", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/core/src/config/layered.test.ts", line: 31, kind: "it", text: "merges flat objects", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 42, kind: "it", text: "rejects zero values", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 54, kind: "it", text: "parses valid input", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 104, kind: "it", text: "allows empty object", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-agent-model.test.ts", line: 240, kind: "it", text: "rejects zero values", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-agent.test.ts", line: 1404, kind: "it", text: "rejects empty id", reason: "Captured(min-length=16); shrink in follow-on work; line re-synced after the rag.lanes + rag.lanes.temporal inserts, then the rag.lanes.causal insert, then the rag.lanes.graphSpread insert, then the rag.mmr + rag.queryUnderstanding inserts, then the rag.forget + rag.scoring.forgetAlpha inserts, then the increment-2 opt-out-defaults re-baseline comments"},
  // NOTE: line numbers re-synced (D-126-A) after Phase 126 Plan 01 flipped the
  // version default to "pipeline" and renamed the short version tests to
  // descriptive >=20-char names, shifting every generic-named it() below by
  // ~1-2 lines. The former `it("accepts 'dag'")` was also renamed to a
  // descriptive name (`guard: explicit version 'dag' still parses to 'dag'...`),
  // so its allowlist entry was DROPPED (count 22 -> 21; shrink-only honored — no
  // growth, the entry was removed, not re-added). The remaining entries are
  // re-pinned to their current lines.
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 169, kind: "it", text: "rejects non-integer", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 203, kind: "it", text: "accepts 'pipeline'", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 230, kind: "it", text: "defaults to 10", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 324, kind: "it", text: "defaults to 15", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 468, kind: "it", text: "defaults to 5", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 507, kind: "it", text: "defaults to 2", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 531, kind: "it", text: "defaults to 8", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 560, kind: "it", text: "defaults to 0.75", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 589, kind: "it", text: "defaults to 8", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 618, kind: "it", text: "defaults to 4", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 647, kind: "it", text: "defaults to 2", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 676, kind: "it", text: "defaults to 0", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 705, kind: "it", text: "defaults to 20000", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 734, kind: "it", text: "defaults to 1200", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 763, kind: "it", text: "defaults to 2000", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 792, kind: "it", text: "defaults to 4000", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 821, kind: "it", text: "defaults to 10", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 850, kind: "it", text: "defaults to 120000", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 879, kind: "it", text: "defaults to 25000", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 908, kind: "it", text: "defaults to 15", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-context-engine.test.ts", line: 937, kind: "it", text: "defaults to 200000", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-gateway.test.ts", line: 187, kind: "it", text: "rejects empty id", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/config/schema-queue.test.ts", line: 163, kind: "it", text: "rejects empty name", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/config/section-registry-parity.test.ts", line: 38, kind: "it", text: "getConfigSections()", reason: "Captured (min-length=19; use-case-shape heuristic miss); shrink in follow-on work. Line shifted from 51 → 38 by stableStringify extraction (inline function removed in favor of test/support/stable-stringify.ts import)." },
  { file: "packages/core/src/config/section-registry-parity.test.ts", line: 98, kind: "it", text: "MANAGED_SECTIONS — 5-entry array", reason: "Captured (use-case-shape heuristic miss); shrink in follow-on work. Line shifted from 111 → 98 by stableStringify extraction (inline function removed in favor of test/support/stable-stringify.ts import)." },
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 70, kind: "it", text: "renders bold", reason: "Captured(min-length=12); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 74, kind: "it", text: "renders italic", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 78, kind: "it", text: "renders inline code", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 86, kind: "it", text: "renders links", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 95, kind: "it", text: "renders headings", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 99, kind: "it", text: "renders h2 heading", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 103, kind: "it", text: "renders blockquotes", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 133, kind: "it", text: "renders inline code", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 154, kind: "it", text: "renders blockquotes", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 216, kind: "it", text: "renders blockquotes", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 258, kind: "it", text: "renders inline code", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 363, kind: "it", text: "renders lists", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/delivery/ir-renderer.test.ts", line: 392, kind: "it", text: "renders lists", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 126, kind: "it", text: "parses h1 heading", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 223, kind: "it", text: "parses ordered list", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 363, kind: "it", text: "parses inline code", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/delivery/markdown-ir.test.ts", line: 377, kind: "it", text: "parses links", reason: "Captured(min-length=12); shrink in follow-on work"},
  { file: "packages/core/src/delivery/markdown-tables.test.ts", line: 134, kind: "it", text: "handles empty cells", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/permanent-errors.test.ts", line: 6, kind: "it", text: "exports 7 patterns", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/delivery/retry-engine.test.ts", line: 139, kind: "it", text: "handles nested tags", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/retry-engine.test.ts", line: 430, kind: "it", text: "resets on success", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 163, kind: "it", text: "preserves autolinks", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 181, kind: "it", text: "decodes &amp; to &", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 185, kind: "it", text: "decodes &lt; to <", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/delivery/sanitize-for-plain-text.test.ts", line: 189, kind: "it", text: "decodes &gt; to >", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 26, kind: "it", text: "wraps config.go", reason: "Captured(min-length=15); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 32, kind: "it", text: "wraps utils.py", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 38, kind: "it", text: "wraps README.md", reason: "Captured(min-length=15); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 44, kind: "it", text: "wraps script.sh", reason: "Captured(min-length=15); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 50, kind: "it", text: "wraps main.rs", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 56, kind: "it", text: "wraps handler.pl", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 62, kind: "it", text: "wraps index.ts", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/core/src/delivery/telegram-file-ref-guard.test.ts", line: 68, kind: "it", text: "wraps app.js", reason: "Captured(min-length=12); shrink in follow-on work"},
  { file: "packages/core/src/domain/credential-mapping.test.ts", line: 151, kind: "it", text: "rejects empty id", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/core/src/domain/credential-mapping.test.ts", line: 171, kind: "it", text: "rejects null input", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/domain/execution-graph.test.ts", line: 66, kind: "it", text: "rejects empty task", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/domain/memory-entry.test.ts", line: 80, kind: "it", text: "accepts tags array", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/domain/normalized-message.test.ts", line: 211, kind: "it", text: "rejects null input", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/domain/session-key.test.ts", line: 119, kind: "it", text: "rejects null input", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/domain/session-key.test.ts", line: 137, kind: "it", text: "formats basic key", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/event-bus/bus.test.ts", line: 30, kind: "it", text: "off removes handler", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/logging/console-logger.test.ts", line: 64, kind: "it", text: ".level is settable", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 179, kind: "it", text: "strips BOM (U+FEFF)", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 206, kind: "test", text: "<!-- normal comment -->", reason: "Captured(use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 214, kind: "test", text: "<div style=\"color: red\">", reason: "Captured(use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 236, kind: "test", text: "cat /home/user/.env", reason: "Captured(min-length=19; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/security/injection-patterns.test.ts", line: 238, kind: "test", text: "cat README.md", reason: "Captured(min-length=13; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/security/injection-rate-limiter.test.ts", line: 158, kind: "it", text: "custom warnThreshold and auditThreshold", reason: "Captured(use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/security/profile-id.test.ts", line: 84, kind: "test", text: "openai-codex", reason: "Captured(min-length=12; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/core/src/security/safe-path.test.ts", line: 28, kind: "it", text: "rejects bare ..", reason: "Captured(min-length=15); shrink in follow-on work"},
  { file: "packages/core/src/security/secret-crypto.test.ts", line: 107, kind: "it", text: "parses hex string", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/security/secret-crypto.test.ts", line: 123, kind: "it", text: "rejects short key", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/core/src/security/secrets-audit.test.ts", line: 181, kind: "it", text: "skips PATH and HOME", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/core/src/security/secrets-audit.test.ts", line: 212, kind: "it", text: "skips empty values", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/platform-tools/tool-helpers.test.ts", line: 311, kind: "it", text: "returns valid value", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/platform-tools/tools/sessions-history-tool.test.ts", line: 65, kind: "it", text: "throws on RPC error", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/platform-tools/tools/sessions-list-tool.test.ts", line: 50, kind: "it", text: "throws on RPC error", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/platform-tools/tools/sessions-send-tool.test.ts", line: 83, kind: "it", text: "throws on RPC error", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/platform-tools/tools/sessions-spawn-tool.test.ts", line: 93, kind: "it", text: "throws on RPC error", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/skills/bridge/schema-validator.test.ts", line: 37, kind: "it", text: "rejects null params", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/skills/prompt/processor.test.ts", line: 22, kind: "it", text: "escapes ampersand", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/skills/src/skills/prompt/sanitizer.test.ts", line: 73, kind: "it", text: "removes soft hyphen", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/skills/registry/discovery.test.ts", line: 199, kind: "it", text: "skips node_modules", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/browser-service.test.ts", line: 117, kind: "it", text: "rejects data: URLs", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/browser-service.test.ts", line: 131, kind: "it", text: "rejects empty URL", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/cdp.test.ts", line: 259, kind: "it", text: "finds target by id", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/chrome-detection.test.ts", line: 207, kind: "it", text: "finds brave-browser", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/chrome-detection.test.ts", line: 220, kind: "it", text: "finds snap chromium", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/chrome-detection.test.ts", line: 476, kind: "it", text: "sends SIGTERM first", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/config.test.ts", line: 59, kind: "it", text: "accepts valid port", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/config.test.ts", line: 112, kind: "it", text: "overrides headless", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/config.test.ts", line: 117, kind: "it", text: "overrides noSandbox", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 25, kind: "it", text: "matches valid names", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 26, kind: "test", text: "my-profile", reason: "Captured(min-length=10; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 27, kind: "test", text: "test123", reason: "Captured(min-length=7); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 28, kind: "test", text: "ab", reason: "Captured(min-length=2; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 29, kind: "test", text: "a0", reason: "Captured(min-length=2; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 33, kind: "test", text: "", reason: "Captured(min-length=0; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 34, kind: "test", text: "a", reason: "Captured(min-length=1; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 35, kind: "test", text: "A-B", reason: "Captured(min-length=3; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 36, kind: "test", text: "-start", reason: "Captured(min-length=6); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 37, kind: "test", text: "end-", reason: "Captured(min-length=4; use-case-shape heuristic miss); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 38, kind: "test", text: "with spaces", reason: "Captured(min-length=11); shrink in follow-on work"},
  { file: "packages/skills/src/tools/browser/profiles.test.ts", line: 39, kind: "test", text: "with!special", reason: "Captured(min-length=12); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/exec-tool.test.ts", line: 87, kind: "it", text: "stderr is captured", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/exec-tool.test.ts", line: 231, kind: "it", text: "mkfs is rejected", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/exec-tool.test.ts", line: 1294, kind: "it", text: "stderr is captured", reason: "Captured (min-length=18); shrink in follow-on work. Line shifted from 1292 → 1294 via source-grep target retargeting after a split." },
  { file: "packages/skills/src/tools/builtin/file-tools/notebook-edit-tool.test.ts", line: 409, kind: "it", text: "delete cell by ID", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/file-tools/shared/edit-diff.test.ts", line: 83, kind: "it", text: "applies single edit", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/file-tools/shared/file-encoding.test.ts", line: 108, kind: "it", text: "restores CR endings", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/file/apply-patch-similarity.test.ts", line: 54, kind: "it", text: "strips BOM", reason: "Captured(min-length=10); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/file/apply-patch-similarity.test.ts", line: 67, kind: "it", text: "converts en dash", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/file/apply-patch-similarity.test.ts", line: 71, kind: "it", text: "converts em dash", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/file/safe-path-wrapper.test.ts", line: 46, kind: "it", text: "has 2 entries", reason: "Captured(min-length=13); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/output-cleaner.test.ts", line: 105, kind: "it", text: "strips NUL bytes", reason: "Captured(min-length=16); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/output-cleaner.test.ts", line: 118, kind: "it", text: "preserves tabs", reason: "Captured(min-length=14); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/truncate.test.ts", line: 44, kind: "it", text: "handles empty input", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/web-fetch-visibility.test.ts", line: 126, kind: "it", text: "removes meta tags", reason: "Captured(min-length=17); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/web-fetch-visibility.test.ts", line: 252, kind: "it", text: "handles empty HTML", reason: "Captured(min-length=18); shrink in follow-on work"},
  { file: "packages/skills/src/tools/builtin/web-shared.test.ts", line: 87, kind: "it", text: "is 2MB", reason: "Captured(min-length=6); shrink in follow-on work"},
  { file: "packages/skills/src/tools/integrations/image-gen/fal-adapter.test.ts", line: 25, kind: "it", text: "id is fal", reason: "Captured(min-length=9); shrink in follow-on work"},
  { file: "packages/skills/src/tools/integrations/image-gen/openai-adapter.test.ts", line: 21, kind: "it", text: "id is openai", reason: "Captured(min-length=12); shrink in follow-on work"},
  { file: "packages/skills/src/tools/media/media-store.test.ts", line: 184, kind: "it", text: "rejects invalid IDs", reason: "Captured(min-length=19); shrink in follow-on work"},
  { file: "packages/skills/src/tools/media/mime-detection.test.ts", line: 149, kind: "it", text: "trims whitespace", reason: "Captured(min-length=16); shrink in follow-on work"},
] as const;
