// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import type { DataTableColumn } from "../../api/types/index.js";
import { systemClearInterval, systemSetInterval } from "@comis/core";

// Side-effect imports (register the design-system components used below).
import "../../components/data/ic-data-table.js";
import "../../components/data/ic-tag.js";
import "../../components/data/ic-relative-time.js";
import "../../components/form/ic-filter-chips.js";
import "../../components/shell/ic-skeleton-view.js";
import "../../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for the durable-audit query, in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Default row cap requested from `obs.audit.query` (clamped store-side too). */
const DEFAULT_LIMIT = 200;

/**
 * The content-free `obs.audit.query` row projection (mirrors the daemon's
 * `AuditEventRowWire`). The view narrows the loose wire rows to this shape — it
 * is structurally content-free: counts / ids / closed enums / a scrubbed `refs`
 * blob, never a secret value field (Phase 176 scrubbed at write).
 */
interface AuditRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  ts: number;
  kind: string;
  classification: string | null;
  outcome: string | null;
  severity: string | null;
  [key: string]: unknown;
}

/** The five user-facing audit filters (a subset of the `obs.audit.query` request). */
type FilterField = "kind" | "agentId" | "tenant" | "outcome" | "severity";

/**
 * `ic-durable-audit-log` — the durable, queryable security-audit view, the FIRST
 * SPA consumer of the Phase-176 `obs.audit.query` RPC (already shipped,
 * admin-gated, content-free). It REPLACES the live SSE feed in the Security
 * view's Audit Log tab (Pitfall 2 — replace, do not sit beside) so audit history
 * survives a daemon restart.
 *
 * Filters by kind / agent / tenant / outcome / severity (the `obs.audit.query`
 * request shape); admin-gating rides the existing RPC (an "Admin access required"
 * rejection surfaces the error path, never a silent render); honest-degradation
 * renders "audit persistence off" on an empty `{ rows: [] }` rather than a blank
 * success that could read as "no security events".
 *
 * Data flow: `obs.audit.query` RPC -> this view (the `diagnostics-view.ts` mold —
 * `LoadState` machine, `willUpdate`-driven load, skeleton / error / empty-state).
 */
@customElement("ic-durable-audit-log")
export class IcDurableAuditLog extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-md);
        flex-wrap: wrap;
        gap: var(--ic-space-sm);
      }

      .header-title {
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
      }

      .summary-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
      }

      .filter-section {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-md);
      }

      .filter-group {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .filter-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        min-width: 5rem;
      }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message {
        color: var(--ic-error);
        font-size: 0.875rem;
      }

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

      .retry-btn:hover {
        background: var(--ic-surface-alt, #374151);
      }
    `,
  ];

  /* ---- Public properties ---- */

  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /* ---- Internal state ---- */

  @state() private _loadState: LoadState = "loading";
  @state() private _rows: AuditRow[] = [];

  // The five user-facing filters ("" = unset = widen the scan).
  @state() private _kind = "";
  @state() private _agentId = "";
  @state() private _tenant = "";
  @state() private _outcome = "";
  @state() private _severity = "";

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    // _tryLoad() is NOT called here — rpcClient is typically null at this
    // point; willUpdate() drives the load once the property is set (the
    // diagnostics-view.ts mold).
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._refreshInterval !== null) {
      systemClearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("rpcClient") && this.rpcClient) {
      this._tryLoad();
    }
  }

  private _tryLoad(): void {
    if (!this.rpcClient) {
      this._loadState = "loaded";
      return;
    }
    this._rpcStatusUnsub?.();
    if (this.rpcClient.status === "connected") {
      this._startLoading();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected") {
          this._startLoading();
        }
      });
    }
  }

  private _startLoading(): void {
    void this._loadData();
    if (this._refreshInterval === null) {
      this._refreshInterval = systemSetInterval(() => {
        void this._loadData();
      }, RPC_REFRESH_INTERVAL_MS);
    }
  }

  /* ---- Data loading ---- */

  /** Build the `obs.audit.query` request from ONLY the set filters (an unset
   *  filter is absent — it widens the scan; the tenant `""` sentinel is itself a
   *  meaningful filter only when explicitly chosen). */
  private _buildRequest(): Record<string, unknown> {
    return {
      ...(this._kind !== "" ? { kind: this._kind } : {}),
      ...(this._agentId !== "" ? { agentId: this._agentId } : {}),
      ...(this._tenant !== "" ? { tenant: this._tenant } : {}),
      ...(this._outcome !== "" ? { outcome: this._outcome } : {}),
      ...(this._severity !== "" ? { severity: this._severity } : {}),
      limit: DEFAULT_LIMIT,
    };
  }

  private async _loadData(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") {
      this._loadState = "loaded";
      return;
    }

    const rpc = this.rpcClient;

    try {
      const raw = await rpc.call<{ rows?: unknown[] }>("obs.audit.query", this._buildRequest());
      const wireRows = Array.isArray(raw?.rows) ? raw.rows : [];
      this._rows = wireRows.map((r) => this._narrowRow(r as Record<string, unknown>));
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  /** Narrow a loose wire row to the content-free {@link AuditRow}. The scrubbed
   *  `refs` blob is intentionally NOT carried onto a rendered field — only the
   *  closed-enum / id columns are surfaced. */
  private _narrowRow(r: Record<string, unknown>): AuditRow {
    return {
      id: String(r.id ?? ""),
      tenantId: String(r.tenantId ?? ""),
      agentId: r.agentId == null ? null : String(r.agentId),
      ts: typeof r.ts === "number" ? r.ts : 0,
      kind: String(r.kind ?? ""),
      classification: r.classification == null ? null : String(r.classification),
      outcome: r.outcome == null ? null : String(r.outcome),
      severity: r.severity == null ? null : String(r.severity),
    };
  }

  /* ---- Filter handling ---- */

  /** Apply a filter value and re-query. A test seam + the filter-chip handler. */
  private _onFilterChange(field: FilterField, value: string): void {
    switch (field) {
      case "kind":
        this._kind = value;
        break;
      case "agentId":
        this._agentId = value;
        break;
      case "tenant":
        this._tenant = value;
        break;
      case "outcome":
        this._outcome = value;
        break;
      case "severity":
        this._severity = value;
        break;
    }
    void this._loadData();
  }

  /** First value of a single-select filter-chip change (we model the filters as
   *  single-select: empty Set clears the filter). */
  private _onChipFilter(field: FilterField, e: CustomEvent<{ selected: Set<string> }>): void {
    const next = [...e.detail.selected];
    this._onFilterChange(field, next.length > 0 ? next[next.length - 1]! : "");
  }

  /* ---- Rendering ---- */

  private get _severityVariant(): (s: string | null) => string {
    return (s) => {
      switch (s) {
        case "critical":
        case "high":
          return "error";
        case "medium":
          return "warning";
        default:
          return "info";
      }
    };
  }

  private get _columns(): DataTableColumn<AuditRow>[] {
    return [
      {
        key: "ts",
        label: "Time",
        render: (_v, row) => html`<ic-relative-time .timestamp=${row.ts}></ic-relative-time>`,
      },
      {
        key: "kind",
        label: "Kind",
        render: (_v, row) => html`<ic-tag>${row.kind}</ic-tag>`,
      },
      {
        key: "agentId",
        label: "Agent",
        render: (_v, row) => (row.agentId ? html`<ic-tag variant="info">${row.agentId}</ic-tag>` : html`<span>—</span>`),
      },
      {
        key: "tenantId",
        label: "Tenant",
        render: (_v, row) => html`<span>${row.tenantId || "—"}</span>`,
      },
      {
        key: "outcome",
        label: "Outcome",
        render: (_v, row) => html`<ic-tag variant=${row.outcome === "denied" || row.outcome === "failure" ? "error" : "default"}>${row.outcome ?? "—"}</ic-tag>`,
      },
      {
        key: "severity",
        label: "Severity",
        render: (_v, row) => html`<ic-tag variant=${this._severityVariant(row.severity)}>${row.severity ?? "—"}</ic-tag>`,
      },
    ];
  }

  private _chipOptions(field: FilterField): Array<{ value: string; label: string }> {
    const accessor: Record<FilterField, (r: AuditRow) => string | null> = {
      kind: (r) => r.kind,
      agentId: (r) => r.agentId,
      tenant: (r) => r.tenantId,
      outcome: (r) => r.outcome,
      severity: (r) => r.severity,
    };
    const values = [...new Set(this._rows.map(accessor[field]).filter((v): v is string => v != null && v !== ""))].sort();
    return values.map((v) => ({ value: v, label: v }));
  }

  private _selectedSet(field: FilterField): Set<string> {
    const current: Record<FilterField, string> = {
      kind: this._kind,
      agentId: this._agentId,
      tenant: this._tenant,
      outcome: this._outcome,
      severity: this._severity,
    };
    return current[field] !== "" ? new Set([current[field]]) : new Set();
  }

  private _renderFilters() {
    const groups: Array<{ field: FilterField; label: string }> = [
      { field: "kind", label: "Kind" },
      { field: "agentId", label: "Agent" },
      { field: "tenant", label: "Tenant" },
      { field: "outcome", label: "Outcome" },
      { field: "severity", label: "Severity" },
    ];
    return html`
      <div class="filter-section">
        ${groups.map(
          (g) => html`
            <div class="filter-group">
              <span class="filter-label">${g.label}</span>
              <ic-filter-chips
                .options=${this._chipOptions(g.field)}
                .selected=${this._selectedSet(g.field)}
                @filter-change=${(e: CustomEvent<{ selected: Set<string> }>) => this._onChipFilter(g.field, e)}
              ></ic-filter-chips>
            </div>
          `,
        )}
      </div>
    `;
  }

  override render() {
    if (this._loadState === "loading" && !this.rpcClient) {
      return html`<ic-skeleton-view variant="table"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">Failed to load the durable audit log</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    if (this._rows.length === 0) {
      // Honest-degradation: an empty result is "persistence off / not configured",
      // NOT a silent blank success that could read as "no security events".
      return html`<ic-empty-state
        icon="security"
        message="Audit persistence off (or no matching events)"
        description="The durable security-audit log is empty. Enable audit persistence to retain decisions across restarts; with persistence on, events appear here as they are recorded."
      ></ic-empty-state>`;
    }

    return html`
      <div class="header">
        <span class="header-title">Durable Audit Log</span>
      </div>
      ${this._renderFilters()}
      <div class="summary-bar">${this._rows.length} audit event(s)</div>
      <ic-data-table
        .columns=${this._columns}
        .rows=${this._rows}
        emptyMessage="No matching audit events"
      ></ic-data-table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-durable-audit-log": IcDurableAuditLog;
  }
}
