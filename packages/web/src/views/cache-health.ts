// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { DataTableColumn } from "../api/types/index.js";
import { systemClearInterval, systemNowMs, systemSetInterval } from "@comis/core";

// Side-effect imports (register the design-system components used below).
import "../components/data/ic-stat-card.js";
import "../components/data/ic-data-table.js";
import "../components/data/ic-sparkline.js";
import "../components/data/ic-tag.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for the cache-health query, in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Default lookback window: 24h in milliseconds. */
const DEFAULT_WINDOW_MS = 86_400_000;

/**
 * The content-free `obs.cacheBreaks.byReason` row projection. The view
 * narrows the loose wire rows to this shape — a closed cache-break `reason` label
 * + a `count` + the summed `estCostUsd` ($-lost). Structurally content-free: no
 * message/body/query/secret field is ever surfaced.
 */
interface CacheBreakRow {
  reason: string;
  count: number;
  estCostUsd: number;
}

/**
 * `ic-cache-health-view` — the native mirror of the Grafana Cache dashboard, no
 * Grafana required. Renders the cache-break rate across the reasons + the $-lost
 * SUM (the `obs.cacheBreaks.byReason` RPC) + the hit/write ratio (the existing
 * `obs.cacheStats.window` RPC).
 *
 * Admin-gating rides the admin-gated `obs.cacheBreaks.byReason` RPC (an "Admin
 * access required" rejection surfaces the error path, never a silent render). Honest-degradation:
 * an empty `{ rows: [] }` renders "cache health not configured" rather than a
 * blank success that could read as "no cache breaks". Content-free: only the
 * pre-aggregated {reason,count,estCostUsd} numbers are surfaced.
 *
 * Data flow: `obs.cacheBreaks.byReason` + `obs.cacheStats.window` RPCs -> this
 * view (the `diagnostics-view.ts` mold — `LoadState` machine, `willUpdate`-driven
 * load, skeleton / error / empty-state).
 */
@customElement("ic-cache-health-view")
export class IcCacheHealthView extends LitElement {
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

      .stats-row {
        display: flex;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
        margin-bottom: var(--ic-space-lg);
      }

      .stats-row > ic-stat-card {
        flex: 1 1 12rem;
      }

      .section {
        margin-bottom: var(--ic-space-lg);
      }

      .section-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: var(--ic-space-sm);
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
  @state() private _rows: CacheBreakRow[] = [];
  @state() private _sinceMs = DEFAULT_WINDOW_MS;
  /** hit/write ratio derived from obs.cacheStats.window; null when unavailable. */
  @state() private _hitWriteRatio: number | null = null;

  private _refreshInterval: ReturnType<typeof setInterval> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
    // _tryLoad() is NOT called here — rpcClient is typically null at this point;
    // willUpdate() drives the load once the property is set (diagnostics-view.ts mold).
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

  private async _loadData(): Promise<void> {
    if (!this.rpcClient || this.rpcClient.status !== "connected") {
      this._loadState = "loaded";
      return;
    }

    const rpc = this.rpcClient;
    const since = systemNowMinus(this._sinceMs);

    try {
      // The cache-break-by-reason RPC ($-lost SUM) — the primary surface.
      const raw = await rpc.call<{ rows?: unknown[] }>("obs.cacheBreaks.byReason", { since });
      const wireRows = Array.isArray(raw?.rows) ? raw.rows : [];
      this._rows = wireRows.map((r) => this._narrowRow(r as Record<string, unknown>));

      // Best-effort hit/write ratio (the existing cache-stats RPC). A failure here
      // must NOT fail the view — the break-rate is the load-bearing surface.
      this._hitWriteRatio = await this._loadHitWriteRatio(rpc, since);

      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  /** Fetch the hit/write ratio from obs.cacheStats.window; null on any failure. */
  private async _loadHitWriteRatio(rpc: RpcClient, since: number): Promise<number | null> {
    try {
      const stats = await rpc.call<{ window?: Record<string, unknown> } & Record<string, unknown>>(
        "obs.cacheStats.window",
        { sinceMs: since },
      );
      const w = (stats?.window ?? stats) as Record<string, unknown>;
      const hits = typeof w?.hits === "number" ? w.hits : 0;
      const writes = typeof w?.writes === "number" ? w.writes : 0;
      if (hits + writes === 0) return null;
      return hits / (hits + writes);
    } catch {
      return null;
    }
  }

  /** Narrow a loose wire row to the content-free {@link CacheBreakRow} — only the
   *  reason/count/$ are carried; any extra wire field (a body) is dropped. */
  private _narrowRow(r: Record<string, unknown>): CacheBreakRow {
    return {
      reason: String(r.reason ?? "unknown"),
      count: typeof r.count === "number" ? r.count : 0,
      estCostUsd: typeof r.estCostUsd === "number" ? r.estCostUsd : 0,
    };
  }

  /* ---- Computed ---- */

  private get _totalBreaks(): number {
    return this._rows.reduce((sum, r) => sum + r.count, 0);
  }

  private get _totalLostUsd(): number {
    return this._rows.reduce((sum, r) => sum + r.estCostUsd, 0);
  }

  /** Per-reason break counts as a sparkline series (descending — the shape of the
   *  break distribution at a glance). */
  private get _breakSparkline(): number[] {
    return [...this._rows].sort((a, b) => b.count - a.count).map((r) => r.count);
  }

  private _formatUsd(n: number): string {
    return `$${n.toFixed(3)}`;
  }

  /* ---- Rendering ---- */

  private get _columns(): DataTableColumn<CacheBreakRow>[] {
    return [
      {
        key: "reason",
        label: "Reason",
        render: (_v, row) => html`<ic-tag>${row.reason}</ic-tag>`,
      },
      {
        key: "count",
        label: "Breaks",
        render: (_v, row) => html`<span>${row.count}</span>`,
      },
      {
        key: "estCostUsd",
        label: "$ Lost",
        render: (_v, row) => html`<span>${this._formatUsd(row.estCostUsd)}</span>`,
      },
    ];
  }

  private _renderStats() {
    return html`
      <div class="stats-row">
        <ic-stat-card label="Total Breaks" .value=${String(this._totalBreaks)}></ic-stat-card>
        <ic-stat-card
          label="$ Lost"
          .value=${this._formatUsd(this._totalLostUsd)}
          threshold=${this._totalLostUsd > 0 ? "warning" : "normal"}
        ></ic-stat-card>
        <ic-stat-card
          label="Hit/Write Ratio"
          .value=${this._hitWriteRatio === null ? "—" : `${(this._hitWriteRatio * 100).toFixed(1)}%`}
        ></ic-stat-card>
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
          <span class="error-message">Failed to load cache-health data</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    if (this._rows.length === 0) {
      // Honest-degradation: an empty result is "not configured / no breaks recorded",
      // NOT a silent blank success that could read as "cache is perfectly healthy".
      return html`<ic-empty-state
        icon="activity"
        message="cache health not configured"
        description="No cache-break telemetry is available. Enable cache-break persistence to see the break rate by reason and the dollars lost to broken prompt-cache reuse."
      ></ic-empty-state>`;
    }

    return html`
      <div class="header">
        <span class="header-title">Cache Health</span>
      </div>
      ${this._renderStats()}
      <div class="section">
        <div class="section-title">Break Distribution</div>
        <ic-sparkline .data=${this._breakSparkline} width=${160} height=${32}></ic-sparkline>
      </div>
      <div class="section">
        <div class="section-title">Break Rate by Reason</div>
        <ic-data-table
          .columns=${this._columns}
          .rows=${this._rows}
          emptyMessage="No cache breaks recorded"
        ></ic-data-table>
      </div>
    `;
  }
}

/** Local helper: a millisecond epoch `windowMs` in the past (test-stable via the
 *  sanctioned `systemNowMs` the rest of the SPA uses — never raw `Date.now`, the
 *  globals gate). Kept inline to avoid a cross-module import for a one-liner. */
function systemNowMinus(windowMs: number): number {
  return systemNowMs() - windowMs;
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-cache-health-view": IcCacheHealthView;
  }
}
