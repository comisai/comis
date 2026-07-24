// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";
import type { SessionListItem, DataTableColumn } from "../../api/types/index.js";
import { computeSessionStatus } from "../../utils/session-key-parser.js";

// Side-effect imports to register child custom elements
import "../data/ic-data-table.js";
import "../data/ic-tag.js";
import "../data/ic-relative-time.js";

/**
 * Format a token count with K suffix for readability.
 * @param tokens - Raw token count.
 * @returns Formatted string (e.g., "23.4K", "890").
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  return String(tokens);
}

/** Status dot color map. */
const STATUS_DOT_COLORS: Record<string, string> = {
  active: "#22c55e",
  idle: "#eab308",
  expired: "#6b7280",
};

/** Column definitions for the session data table. */
const SESSION_COLUMNS: DataTableColumn<SessionListItem>[] = [
  {
    key: "conversationRef",
    label: "Session",
    sortable: true,
    render: (value: unknown, row: SessionListItem) => {
      const raw = String(value ?? "");
      const displayName = raw.length > 15 ? raw.slice(0, 12) + "..." : raw;
      return html`<span title=${raw}>
        <strong style="font-size: var(--ic-text-sm);">${displayName}</strong>
        <span style="font-size: var(--ic-text-xs); color: var(--ic-text-dim); margin-left: 4px;">${row.kind}</span>
      </span>`;
    },
  },
  {
    // Synthetic key — render() owns the source field (row.updatedAt via
    // computeSessionStatus). `sortable: false` so ordering is unaffected.
    key: "status",
    label: "Status",
    sortable: false,
    render: (_value: unknown, row: SessionListItem) => {
      const status = computeSessionStatus(row.updatedAt);
      const color = STATUS_DOT_COLORS[status] ?? STATUS_DOT_COLORS.expired;
      return html`<span style="display: inline-flex; align-items: center; gap: 6px;">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${color};"></span>
        <span style="font-size: var(--ic-text-xs); text-transform: capitalize;">${status}</span>
      </span>`;
    },
  },
  {
    key: "agentId",
    label: "Agent",
    sortable: true,
  },
  {
    key: "kind",
    label: "Kind",
    sortable: true,
    render: (value: unknown) => {
      const kind = String(value ?? "");
      return html`<ic-tag variant=${kind}>${kind}</ic-tag>`;
    },
  },
  {
    key: "messageCount",
    label: "Messages",
    sortable: true,
  },
  {
    key: "totalTokens",
    label: "Tokens",
    sortable: true,
    render: (value: unknown) => formatTokens(Number(value ?? 0)),
  },
  {
    key: "updatedAt",
    label: "Age",
    sortable: true,
    render: (value: unknown) => {
      const ts = Number(value ?? 0);
      return html`<ic-relative-time .timestamp=${ts}></ic-relative-time>`;
    },
  },
];

/**
 * Session list table component using ic-data-table.
 *
 * Renders a list of sessions in a sortable, paginated table with
 * optional row selection for bulk operations.
 *
 * @fires session-click - CustomEvent<SessionListItem> when a row is clicked
 * @fires selection-change - CustomEvent<string[]> when selection changes
 *
 * @example
 * ```html
 * <ic-session-list
 *   .sessions=${sessions}
 *   selectable
 *   @session-click=${handler}
 *   @selection-change=${handler}
 * ></ic-session-list>
 * ```
 */
@customElement("ic-session-list")
export class IcSessionList extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  /** Session data to display. */
  @property({ attribute: false }) sessions: SessionListItem[] = [];

  /** Enable row selection checkboxes. */
  @property({ type: Boolean }) selectable = false;

  private _handleRowClick(e: CustomEvent<SessionListItem>): void {
    this.dispatchEvent(
      new CustomEvent("session-click", {
        detail: e.detail,
        bubbles: true,
      }),
    );
  }

  private _handleSelectionChange(e: CustomEvent<string[]>): void {
    this.dispatchEvent(
      new CustomEvent("selection-change", {
        detail: e.detail,
        bubbles: true,
      }),
    );
  }

  override render() {
    return html`
      <ic-data-table
        .columns=${SESSION_COLUMNS}
        .rows=${this.sessions}
        .pageSize=${25}
        ?selectable=${this.selectable}
        emptyMessage="No sessions found"
        @row-click=${this._handleRowClick}
        @selection-change=${this._handleSelectionChange}
      ></ic-data-table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-session-list": IcSessionList;
  }
}
