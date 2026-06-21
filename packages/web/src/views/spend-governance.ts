// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { DataTableColumn } from "../api/types/index.js";
import { systemClearInterval, systemSetInterval } from "@comis/core";

// Side-effect imports (register the design-system components used below).
import "../components/data/ic-stat-card.js";
import "../components/data/ic-data-table.js";
import "../components/data/ic-tag.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-empty-state.js";

type LoadState = "loading" | "loaded" | "error";

/** Auto-refresh interval for the live spend snapshot, in milliseconds. */
const RPC_REFRESH_INTERVAL_MS = 30_000;

/** Headroom warn/critical thresholds as a fraction of the ceiling remaining. */
const HEADROOM_WARN_FRACTION = 0.25;
const HEADROOM_CRITICAL_FRACTION = 0.1;

/**
 * One content-free per-scope spend row from `obs.spend.snapshot` (179-04): the
 * scope KEY (a `${tenantId} ${agentId}` / tenant id — config ids, never user
 * content) + the LIVE spent total + its ceiling (null = off) + the derived
 * headroom (null when the ceiling is off).
 */
interface ScopeRow {
  scope: string;
  spentUsd: number;
  capUsd: number | null;
  headroomUsd: number | null;
  /** The scope tier label (agent | tenant) — for the governed-scope table. */
  tier: string;
}

/** The three-state pricing-coverage count (how trustworthy the dollars are). */
interface PricingCoverage {
  priced: number;
  free: number;
  unknown: number;
}

/**
 * The narrowed, content-free `obs.spend.snapshot` shape. `enabled:false` (or
 * all-null ceilings) is the honest-degradation signal — governance is off.
 */
interface SpendSnapshot {
  enabled: boolean;
  global: number;
  globalCapUsd: number | null;
  globalHeadroomUsd: number | null;
  perAgent: ScopeRow[];
  perTenant: ScopeRow[];
  pricingCoverage: PricingCoverage;
}

/**
 * `ic-spend-governance-view` — the native mirror of the Grafana Cost/Governance
 * dashboard, no Grafana required (WEBUI-02, 179-07). Renders the per-agent /
 * tenant / global spend-vs-ceiling headroom gauges + the three-state
 * pricing-coverage (priced / free / unknown) + the governed-scope table.
 *
 * LOCKED A1: it consumes the LIVE `obs.spend.snapshot` (the threaded
 * `spendAccumulator.getSnapshot()`, NOT the lagging SQL) — so the rendered figure
 * CANNOT disagree with `comis fleet` / the dollars kill-switch (T-179-24).
 *
 * Admin-gating rides the admin-gated 179-04 RPC (an "Admin access required"
 * rejection surfaces the error path). Honest-degradation: an `{ enabled: false }`
 * snapshot OR a snapshot whose every ceiling is null renders "spend governance not
 * configured" rather than a misleading $0 gauge (T-179-23). Content-free: scope
 * KEYS (config ids) + dollar/count NUMBERS + pricing enums ONLY.
 *
 * Data flow: `obs.spend.snapshot` RPC -> this view (the `diagnostics-view.ts`
 * mold — `LoadState` machine, `willUpdate`-driven load, skeleton / error / empty).
 */
@customElement("ic-spend-governance-view")
export class IcSpendGovernanceView extends LitElement {
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
  @state() private _snapshot: SpendSnapshot | null = null;

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

    try {
      // The 179-04 LIVE spend snapshot (locked A1 — the kill-switch value).
      const raw = await rpc.call<{ snapshot?: Record<string, unknown> }>("obs.spend.snapshot", {});
      this._snapshot = this._narrowSnapshot(raw?.snapshot ?? {});
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  /** Narrow the loose wire snapshot to the content-free {@link SpendSnapshot} —
   *  only scope keys + dollar/count numbers + pricing enums are carried. */
  private _narrowSnapshot(s: Record<string, unknown>): SpendSnapshot {
    const pc = (s.pricingCoverage ?? {}) as Record<string, unknown>;
    return {
      enabled: s.enabled === true,
      global: typeof s.global === "number" ? s.global : 0,
      globalCapUsd: typeof s.globalCapUsd === "number" ? s.globalCapUsd : null,
      globalHeadroomUsd: typeof s.globalHeadroomUsd === "number" ? s.globalHeadroomUsd : null,
      perAgent: this._narrowScopeRows(s.perAgent, "agent"),
      perTenant: this._narrowScopeRows(s.perTenant, "tenant"),
      pricingCoverage: {
        priced: typeof pc.priced === "number" ? pc.priced : 0,
        free: typeof pc.free === "number" ? pc.free : 0,
        unknown: typeof pc.unknown === "number" ? pc.unknown : 0,
      },
    };
  }

  private _narrowScopeRows(raw: unknown, tier: string): ScopeRow[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        scope: String(row.scope ?? ""),
        spentUsd: typeof row.spentUsd === "number" ? row.spentUsd : 0,
        capUsd: typeof row.capUsd === "number" ? row.capUsd : null,
        headroomUsd: typeof row.headroomUsd === "number" ? row.headroomUsd : null,
        tier,
      };
    });
  }

  /* ---- Computed ---- */

  /** Governance is "configured" only when SOME ceiling is non-null. An enabled
   *  snapshot with every ceiling null is honest-degradation (governance off). */
  private get _isGoverned(): boolean {
    const s = this._snapshot;
    if (!s || !s.enabled) return false;
    if (s.globalCapUsd !== null) return true;
    return [...s.perAgent, ...s.perTenant].some((r) => r.capUsd !== null);
  }

  private get _governedScopeRows(): ScopeRow[] {
    const s = this._snapshot;
    if (!s) return [];
    return [...s.perAgent, ...s.perTenant];
  }

  private _formatUsd(n: number | null): string {
    return n === null ? "—" : `$${n.toFixed(2)}`;
  }

  /** Threshold tier for a headroom gauge: critical when <10% of the ceiling is
   *  left, warning when <25%, else normal. Null ceiling/headroom => normal. */
  private _headroomThreshold(headroomUsd: number | null, capUsd: number | null): "normal" | "warning" | "critical" {
    if (headroomUsd === null || capUsd === null || capUsd <= 0) return "normal";
    const fraction = headroomUsd / capUsd;
    if (fraction <= HEADROOM_CRITICAL_FRACTION) return "critical";
    if (fraction <= HEADROOM_WARN_FRACTION) return "warning";
    return "normal";
  }

  /* ---- Rendering ---- */

  private get _columns(): DataTableColumn<ScopeRow>[] {
    return [
      {
        key: "tier",
        label: "Tier",
        render: (_v, row) => html`<ic-tag>${row.tier}</ic-tag>`,
      },
      {
        key: "scope",
        label: "Scope",
        render: (_v, row) => html`<span>${row.scope || "—"}</span>`,
      },
      {
        key: "spentUsd",
        label: "Spent",
        render: (_v, row) => html`<span>${this._formatUsd(row.spentUsd)}</span>`,
      },
      {
        key: "capUsd",
        label: "Ceiling",
        render: (_v, row) => html`<span>${this._formatUsd(row.capUsd)}</span>`,
      },
      {
        key: "headroomUsd",
        label: "Headroom",
        render: (_v, row) => html`<ic-tag
          variant=${this._headroomThreshold(row.headroomUsd, row.capUsd) === "critical"
            ? "error"
            : this._headroomThreshold(row.headroomUsd, row.capUsd) === "warning"
              ? "warning"
              : "default"}
        >${this._formatUsd(row.headroomUsd)}</ic-tag>`,
      },
    ];
  }

  private _renderGauges() {
    const s = this._snapshot!;
    const pc = s.pricingCoverage;
    return html`
      <div class="stats-row">
        <ic-stat-card
          label="Global Spend"
          .value=${this._formatUsd(s.global)}
        ></ic-stat-card>
        <ic-stat-card
          label="Global Ceiling"
          .value=${this._formatUsd(s.globalCapUsd)}
        ></ic-stat-card>
        <ic-stat-card
          label="Global Headroom"
          .value=${this._formatUsd(s.globalHeadroomUsd)}
          threshold=${this._headroomThreshold(s.globalHeadroomUsd, s.globalCapUsd)}
        ></ic-stat-card>
        <ic-stat-card
          label="Pricing Coverage"
          .value=${`${pc.priced} priced / ${pc.free} free / ${pc.unknown} unknown`}
          threshold=${pc.unknown > 0 ? "warning" : "normal"}
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
          <span class="error-message">Failed to load spend-governance data</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    if (!this._isGoverned) {
      // Honest-degradation: an { enabled:false } snapshot OR all-null ceilings is
      // "governance off", NOT a misleading $0 success that could read as "no spend".
      return html`<ic-empty-state
        icon="dollar-sign"
        message="spend governance not configured"
        description="No spend ceilings are configured, so there is no kill-switch to enforce and no headroom to show. Configure per-agent / per-tenant / global USD ceilings to see live spend-vs-ceiling headroom here."
      ></ic-empty-state>`;
    }

    return html`
      <div class="header">
        <span class="header-title">Spend & Governance</span>
      </div>
      ${this._renderGauges()}
      <div class="section">
        <div class="section-title">Headroom by Scope (live)</div>
        <ic-data-table
          .columns=${this._columns}
          .rows=${this._governedScopeRows}
          emptyMessage="No governed scopes have recorded spend"
        ></ic-data-table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-spend-governance-view": IcSpendGovernanceView;
  }
}
