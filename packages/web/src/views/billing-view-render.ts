// SPDX-License-Identifier: Apache-2.0
/**
 * Pure presentational templates for the billing view's per-tool/per-subagent
 * granularity sections + the typed-query DSL filter bar.
 *
 * Extracted from `billing-view.ts` to hold the ≤800-line file-size cap — these
 * are pure `html` factories that take their data + formatters + callbacks as
 * arguments and touch no component state or DOM.
 *
 * @module
 */

import { html, nothing, type TemplateResult } from "lit";
import type { ToolCostBreakdown, SubagentCostBreakdown } from "../api/types/index.js";

/**
 * Trigger a client-side file download via the zero-dependency `<a download>`
 * Blob mechanism (the `diagnostics-view.ts:383` twin). In tests, vitest-setup
 * no-ops the download anchor's `click()` and a `createObjectURL` spy asserts
 * the blob was built.
 */
export function downloadBlob(body: string, filename: string, mimeType: string): void {
  const blob = new Blob([body], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Formatters/handlers the templates need, injected from the view. */
export interface BillingRenderDeps {
  formatCost: (n: number) => string;
  formatNumber: (n: number) => string;
}

/**
 * Per-tool cost section (tool_tag). Labeled "(best-effort)" — the even-split
 * caveat. Empty list renders nothing (honest degradation).
 */
export function renderToolCosts(
  toolCosts: ReadonlyArray<ToolCostBreakdown>,
  deps: BillingRenderDeps,
): TemplateResult | typeof nothing {
  if (toolCosts.length === 0) return nothing;
  return html`
    <div class="section">
      <div class="section-title">Per-tool cost <span class="caveat">(best-effort)</span></div>
      <div class="card">
        <div class="grid-table tool-table" role="table" aria-label="Per-tool cost">
          <div class="grid-header" role="row">
            <div class="cell" role="columnheader">Tool</div>
            <div class="cell cell-right" role="columnheader">Tokens</div>
            <div class="cell cell-right" role="columnheader">Cost</div>
            <div class="cell cell-right" role="columnheader">Calls</div>
          </div>
          ${toolCosts.map(
            (t) => html`
              <div class="grid-row" role="row">
                <div class="cell cell-mono" role="cell">${t.tool}</div>
                <div class="cell cell-mono cell-right" role="cell">${deps.formatNumber(t.tokens)}</div>
                <div class="cell cell-mono cell-right" role="cell">${deps.formatCost(t.cost)}</div>
                <div class="cell cell-mono cell-right" role="cell">${deps.formatNumber(t.calls)}</div>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

/**
 * Per-subagent cost section (corrected-$ subtree rollup). Exact within
 * the graph (no best-effort caveat).
 *
 * HONEST degradation when empty: per-subagent cost comes from the per-graph
 * `gs.nodeCost`, which is PER-GRAPH-RUN (in-memory, surfaced on `graph:completed` /
 * the Incident view), NOT persisted to `obs_token_usage` — so the per-agent billing
 * aggregate has no honest per-subagent source. Rather than render `nothing` (a
 * silent empty that reads as "no subagents ran") or a fabricated row, the empty case
 * renders an ACCURATE note naming where the data lives (the Incident view), so the
 * operator is not misled. Content-free (a static string, no data).
 */
export function renderSubagentCosts(
  subagentCosts: ReadonlyArray<SubagentCostBreakdown>,
  deps: BillingRenderDeps,
): TemplateResult | typeof nothing {
  if (subagentCosts.length === 0) {
    return html`
      <div class="section">
        <div class="section-title">Per-subagent cost</div>
        <div class="card">
          <div class="caveat">
            Per-subagent cost is per-graph-run — it is not in the per-agent billing
            aggregate. See the Incident view for a graph run's per-node / subtree cost.
          </div>
        </div>
      </div>
    `;
  }
  return html`
    <div class="section">
      <div class="section-title">Per-subagent cost</div>
      <div class="card">
        <div class="grid-table subagent-table" role="table" aria-label="Per-subagent cost">
          <div class="grid-header" role="row">
            <div class="cell" role="columnheader">Subagent</div>
            <div class="cell cell-right" role="columnheader">Node Cost</div>
            <div class="cell cell-right" role="columnheader">Subtree Cost</div>
          </div>
          ${subagentCosts.map(
            (s) => html`
              <div class="grid-row" role="row">
                <div class="cell cell-mono" role="cell">${s.nodeId}</div>
                <div class="cell cell-mono cell-right" role="cell">${deps.formatCost(s.cost)}</div>
                <div class="cell cell-mono cell-right" role="cell">${deps.formatCost(s.subtreeCost)}</div>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

/** Inputs for the DSL filter bar + export buttons. */
export interface FilterBarDeps {
  query: string;
  hint: string;
  onInput: (e: Event) => void;
  onExport: (format: "csv" | "json") => void;
}

/**
 * The typed-query DSL filter input + CSV/JSON export buttons. The hint surfaces
 * unknown-key feedback honestly (never throws).
 */
export function renderFilterBar(deps: FilterBarDeps): TemplateResult {
  return html`
    <div class="filter-bar">
      <input
        class="filter-input"
        type="text"
        .value=${deps.query}
        placeholder="Filter: agent:foo provider:openai minTokens:100 maxCost:0.5 has:errors tool:bash"
        aria-label="Billing query filter"
        @input=${deps.onInput}
      />
      <button class="export-btn" @click=${() => deps.onExport("csv")}>Export CSV</button>
      <button class="export-btn" @click=${() => deps.onExport("json")}>Export JSON</button>
    </div>
    ${deps.hint ? html`<div class="filter-hint" role="status">${deps.hint}</div>` : nothing}
  `;
}
