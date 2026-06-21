// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import type { DataTableColumn } from "../api/types/index.js";

// Side-effect imports (register custom elements)
import "../components/data/ic-stat-card.js";
import "../components/data/ic-data-table.js";
import "../components/data/ic-tag.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/**
 * The deterministic `obs.explain` IncidentReport wire shape (the fields this
 * view renders). A loose, presence-conditional projection — every optional
 * section is rendered ONLY when present (mirroring the schema's additive
 * optional-section family). The full shape lives in
 * `@comis/core` `incident-report.ts` (the daemon-side authority); the view
 * narrows the wire response to just what it surfaces.
 */
interface IncidentReportView {
  sessionKey: string;
  traceId: string;
  agentId: string;
  channel: { type: string; id: string };
  outcome: { endReason: string; degraded: boolean; severity: "ok" | "degraded" | "failed" };
  cost: { costUsd: number; totalTokens: number; cacheReadRatio: number };
  timing: { durationMs: number; turnCount: number };
  failures: Array<{
    seq: number;
    toolName: string;
    errorKind: string;
    httpStatus?: number;
    transportOk: boolean;
    classifiedFailureBy: string;
  }>;
  breakerTimeline: Array<{
    seq: number;
    event: "opened" | "reset";
    toolName: string;
    consecutiveFailures?: number;
  }>;
  // Optional, presence-conditional sections:
  recall?: { recalls: number; zeroHits: number; lastFinalCount: number; rerankerAvailable: boolean };
  cacheBreaks?: Array<{ reason: string; count: number; estCostUsd: number }>;
  audit?: { total: number; byKind: Record<string, number> };
  spend?: { scope: string; totalUsd: number; capUsd: number };
  summary: string;
  likelyRootCause: { code: string; detail: string; suggestedNextSteps: string[] } | null;
  suggestedNextSteps: string[];
}

/** ic-tag variant per outcome severity. */
const SEVERITY_VARIANT: Record<string, string> = {
  ok: "success",
  degraded: "warning",
  failed: "danger",
};

/** Format a USD value as currency. */
function formatCost(usd: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd);
}

/** Format a token count compactly. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format a duration (ms) human-readably. */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * The native, in-product twin of the E7 metric→incident drill-down: an
 * Incident view surfacing the already-wired `obs.explain` RPC (the v2.14
 * deterministic, content-free `IncidentReport`). The FIRST SPA consumer of
 * `obs.explain` — reachable from every chart row + `session-detail.ts` keyed on
 * `sessionKey | traceId`.
 *
 * Renders the IncidentReport sections (outcome / cost / timing / failures /
 * breaker timeline / likelyRootCause) plus the optional, presence-conditional
 * sections (`recall?` / `cacheBreaks?` / `audit?` / `spend?`). Admin-gated
 * (rides `obs.explain`'s admin gate), content-free (the report is scrubbed at
 * the source), and degrades honestly (no ref → an "select an incident" empty
 * state; a denied/failed call → the error path).
 *
 * Grafana relationship (locked §14: link, NEVER embed): when
 * `observability.prometheus.enabled`, an "Open in Grafana" `<a href
 * target=_blank rel=noopener>` to the matching dashboard is shown; otherwise
 * omitted (honest). NEVER an `<iframe>` — the SPA stays zero-dependency.
 *
 * Route: `#/observe/incident?ref=<sessionKey|traceId>`.
 * Data flow: obs.explain RPC -> this view; config.read -> the Grafana link gate.
 */
@customElement("ic-incident-view")
export class IcIncidentView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host { display: block; }

      .incident-view { padding: 0; }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: var(--ic-space-lg);
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
      }

      .header-left { display: flex; flex-direction: column; gap: var(--ic-space-xs); }

      .header-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .header-sub {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        font-family: var(--ic-font-mono, monospace);
      }

      .grafana-link {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        padding: 0.375rem 0.75rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        text-decoration: none;
      }

      .grafana-link:hover { border-color: var(--ic-text-dim); }
      .grafana-link:focus-visible { outline: 2px solid var(--ic-accent); outline-offset: 2px; }

      .stats-row {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-lg);
      }

      .section { margin-bottom: var(--ic-space-lg); }

      .section-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-sm);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .root-cause {
        padding: var(--ic-space-md);
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        margin-bottom: var(--ic-space-md);
      }

      .root-cause-code {
        font-weight: 600;
        color: var(--ic-text);
        font-family: var(--ic-font-mono, monospace);
      }

      .root-cause-detail { color: var(--ic-text-dim); font-size: var(--ic-text-sm); margin-top: var(--ic-space-xs); }

      .kv-grid {
        display: grid;
        grid-template-columns: auto auto;
        gap: var(--ic-space-xs) var(--ic-space-lg);
        font-size: var(--ic-text-sm);
      }

      .kv-key { color: var(--ic-text-dim); }
      .kv-val { color: var(--ic-text); font-family: var(--ic-font-mono, monospace); }

      .next-steps { margin: 0; padding-left: 1.25rem; color: var(--ic-text-dim); font-size: var(--ic-text-sm); }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message { color: var(--ic-error); font-size: 0.875rem; }

      .retry-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 0.375rem;
        color: var(--ic-text);
        font-size: 0.8125rem;
        cursor: pointer;
        font-family: inherit;
      }

      .retry-btn:hover { background: var(--ic-surface-alt, #374151); }
    `,
  ];

  /* ---- Public properties ---- */

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  /** The drill ref (one of sessionKey | traceId resolves the incident). */
  @property() sessionKey = "";
  @property() traceId = "";

  /* ---- Internal state ---- */

  @state() private _loadState: LoadState = "loading";
  @state() private _report: IncidentReportView | null = null;
  /** Whether `observability.prometheus.enabled` — gates the Grafana link-out. */
  @state() private _prometheusEnabled = false;

  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override willUpdate(changed: Map<string, unknown>): void {
    // rpcClient is null in connectedCallback — load here once it (or the ref) is set.
    if ((changed.has("rpcClient") || changed.has("sessionKey") || changed.has("traceId")) && this.rpcClient) {
      this._tryLoad();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  private get _ref(): { sessionKey?: string; traceId?: string } | null {
    if (this.sessionKey) return { sessionKey: this.sessionKey };
    if (this.traceId) return { traceId: this.traceId };
    return null;
  }

  private _tryLoad(): void {
    if (!this.rpcClient) {
      this._loadState = "loaded";
      return;
    }
    // No ref → honest empty state; do NOT call obs.explain.
    if (!this._ref) {
      this._loadState = "loaded";
      return;
    }
    this._rpcStatusUnsub?.();
    if (this.rpcClient.status === "connected") {
      void this._loadData();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected") void this._loadData();
      });
    }
  }

  /* ---- Data loading ---- */

  private async _loadData(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") {
      this._loadState = "loaded";
      return;
    }
    const ref = this._ref;
    if (!ref) {
      this._loadState = "loaded";
      return;
    }
    const rpc = this.rpcClient;

    // The Grafana link gate (best-effort — a failure leaves the link off, honest).
    void this._loadPrometheusFlag(rpc);

    try {
      const raw = await rpc.call<IncidentReportView>("obs.explain", { ...ref, depth: "summary" });
      this._report = raw;
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  private async _loadPrometheusFlag(rpc: RpcClient): Promise<void> {
    try {
      const cfg = await rpc.call<{ config?: Record<string, unknown> }>("config.read");
      const obs = (cfg.config?.observability ?? {}) as Record<string, unknown>;
      const prom = (obs.prometheus ?? {}) as Record<string, unknown>;
      this._prometheusEnabled = prom.enabled === true;
    } catch {
      this._prometheusEnabled = false;
    }
  }

  /* ---- Computed: the Grafana dashboard URL (link, never embed) ---- */

  /**
   * The "matching dashboard" for a session incident is the provisioned
   * reliability dashboard (uid `comis-reliability`); the operator's Grafana
   * is the standard root (the dashboards-as-code ship under that uid). We link
   * to its data-link convention (`?var-` template) — a LINK, never an embed.
   */
  private get _grafanaUrl(): string {
    const ref = this.sessionKey || this.traceId;
    return `/grafana/d/comis-reliability?var-trace=${encodeURIComponent(ref)}`;
  }

  /* ---- Rendering ---- */

  private _renderHeader(report: IncidentReportView) {
    const sev = report.outcome.severity;
    return html`
      <div class="header">
        <div class="header-left">
          <div class="header-title">
            <span>Incident</span>
            <ic-tag variant=${SEVERITY_VARIANT[sev] ?? "default"}>${sev}</ic-tag>
            ${report.likelyRootCause
              ? html`<ic-tag variant="default">${report.likelyRootCause.code}</ic-tag>`
              : nothing}
          </div>
          <div class="header-sub">${report.sessionKey} · ${report.outcome.endReason}</div>
        </div>
        ${this._prometheusEnabled
          ? html`<a
              class="grafana-link"
              href=${this._grafanaUrl}
              target="_blank"
              rel="noopener noreferrer"
              >Open in Grafana</a
            >`
          : nothing}
      </div>
    `;
  }

  private _renderStats(report: IncidentReportView) {
    return html`
      <div class="stats-row">
        <ic-stat-card
          label="Cost"
          value=${formatCost(report.cost.costUsd)}
          threshold=${report.outcome.severity === "failed" ? "critical" : "normal"}
        ></ic-stat-card>
        <ic-stat-card label="Tokens" value=${formatTokens(report.cost.totalTokens)}></ic-stat-card>
        <ic-stat-card label="Duration" value=${formatDuration(report.timing.durationMs)}></ic-stat-card>
        <ic-stat-card label="Turns" value=${String(report.timing.turnCount)}></ic-stat-card>
        <ic-stat-card
          label="Cache read"
          value=${`${Math.round(report.cost.cacheReadRatio * 100)}%`}
        ></ic-stat-card>
      </div>
    `;
  }

  private _renderRootCause(report: IncidentReportView) {
    if (!report.likelyRootCause && report.suggestedNextSteps.length === 0) return nothing;
    return html`
      <div class="root-cause">
        ${report.likelyRootCause
          ? html`
              <div class="root-cause-code">${report.likelyRootCause.code}</div>
              <div class="root-cause-detail">${report.likelyRootCause.detail}</div>
            `
          : nothing}
        ${report.suggestedNextSteps.length > 0
          ? html`<ul class="next-steps">
              ${report.suggestedNextSteps.map((s) => html`<li>${s}</li>`)}
            </ul>`
          : nothing}
      </div>
    `;
  }

  private _renderFailures(report: IncidentReportView) {
    if (report.failures.length === 0) return nothing;
    const columns: DataTableColumn[] = [
      { key: "seq", label: "#" },
      { key: "toolName", label: "Tool" },
      { key: "errorKind", label: "Error kind" },
      {
        key: "httpStatus",
        label: "HTTP",
        render: (v) => (v === undefined || v === null ? "—" : String(v)),
      },
      {
        key: "transportOk",
        label: "Transport",
        render: (v) => (v === true ? "ok" : "failed"),
      },
      { key: "classifiedFailureBy", label: "Classified by" },
    ];
    return html`
      <div class="section">
        <div class="section-title">Failures (${report.failures.length})</div>
        <ic-data-table .columns=${columns} .rows=${report.failures} hidePagination></ic-data-table>
      </div>
    `;
  }

  private _renderBreaker(report: IncidentReportView) {
    if (report.breakerTimeline.length === 0) return nothing;
    const columns: DataTableColumn[] = [
      { key: "seq", label: "#" },
      { key: "event", label: "Event" },
      { key: "toolName", label: "Tool" },
      {
        key: "consecutiveFailures",
        label: "Consecutive failures",
        render: (v) => (v === undefined || v === null ? "—" : String(v)),
      },
    ];
    return html`
      <div class="section">
        <div class="section-title">Breaker timeline</div>
        <ic-data-table .columns=${columns} .rows=${report.breakerTimeline} hidePagination></ic-data-table>
      </div>
    `;
  }

  /* -- Optional, presence-conditional sections -- */

  private _renderSpend(report: IncidentReportView) {
    if (!report.spend) return nothing;
    const s = report.spend;
    return html`
      <div class="section">
        <div class="section-title">Spend (kill-switch breach)</div>
        <div class="root-cause">
          <div class="kv-grid">
            <span class="kv-key">Scope</span><span class="kv-val">${s.scope}</span>
            <span class="kv-key">Spent</span><span class="kv-val">${formatCost(s.totalUsd)}</span>
            <span class="kv-key">Ceiling</span><span class="kv-val">${formatCost(s.capUsd)}</span>
          </div>
        </div>
      </div>
    `;
  }

  private _renderCacheBreaks(report: IncidentReportView) {
    if (!report.cacheBreaks || report.cacheBreaks.length === 0) return nothing;
    const columns: DataTableColumn[] = [
      { key: "reason", label: "Reason" },
      { key: "count", label: "Count" },
      {
        key: "estCostUsd",
        label: "$ lost",
        render: (v) => formatCost(typeof v === "number" ? v : 0),
      },
    ];
    return html`
      <div class="section">
        <div class="section-title">Cache breaks</div>
        <ic-data-table .columns=${columns} .rows=${report.cacheBreaks} hidePagination></ic-data-table>
      </div>
    `;
  }

  private _renderRecall(report: IncidentReportView) {
    if (!report.recall) return nothing;
    const r = report.recall;
    return html`
      <div class="section">
        <div class="section-title">Recall</div>
        <div class="root-cause">
          <div class="kv-grid">
            <span class="kv-key">Recalls</span><span class="kv-val">${r.recalls}</span>
            <span class="kv-key">Zero-hits</span><span class="kv-val">${r.zeroHits}</span>
            <span class="kv-key">Final injected</span><span class="kv-val">${r.lastFinalCount}</span>
            <span class="kv-key">Reranker</span
            ><span class="kv-val">${r.rerankerAvailable ? "available" : "unavailable"}</span>
          </div>
        </div>
      </div>
    `;
  }

  private _renderAudit(report: IncidentReportView) {
    if (!report.audit) return nothing;
    const a = report.audit;
    return html`
      <div class="section">
        <div class="section-title">Audit (${a.total} events)</div>
        <div class="root-cause">
          <div class="kv-grid">
            ${Object.entries(a.byKind).map(
              ([kind, count]) =>
                html`<span class="kv-key">${kind}</span><span class="kv-val">${count}</span>`,
            )}
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    if (this._loadState === "loading" && !this.rpcClient) {
      return html`<ic-skeleton-view variant="detail"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">Failed to load incident report</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    // Honest-degradation: no ref selected → an "select an incident" empty state.
    if (!this._ref || !this._report) {
      return html`<ic-empty-state
        icon="activity"
        message="Select an incident to explain"
        description="Open this view from a chart row or a session to see its deterministic root-cause report."
      ></ic-empty-state>`;
    }

    const report = this._report;
    return html`
      <div class="incident-view">
        ${this._renderHeader(report)}
        ${this._renderStats(report)}
        ${this._renderRootCause(report)}
        ${this._renderSpend(report)}
        ${this._renderFailures(report)}
        ${this._renderBreaker(report)}
        ${this._renderCacheBreaks(report)}
        ${this._renderRecall(report)}
        ${this._renderAudit(report)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-incident-view": IcIncidentView;
  }
}
