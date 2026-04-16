import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { MemoryEntry, DataTableColumn } from "../api/types/index.js";
import "./data/ic-data-table.js";
import "./data/ic-tag.js";
import "./data/ic-relative-time.js";

/**
 * Memory results table using ic-data-table for consistent rendering.
 *
 * Displays memory entries with columns for Score, Content, Type, Trust,
 * Agent, and Age. Score column only appears when entries have score values.
 * Supports row selection and forwards events from the underlying data table.
 *
 * @fires detail-requested - CustomEvent<MemoryEntry> when a row is clicked
 * @fires selection-change - CustomEvent<string[]> when checkbox selection changes
 */
@customElement("ic-memory-table")
export class IcMemoryTable extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .score-cell {
        font-family: var(--ic-font-mono);
        color: var(--ic-warning);
        font-size: var(--ic-text-xs);
      }

      .content-cell {
        max-width: 24rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  /** Memory entries to display. */
  @property({ attribute: false }) entries: MemoryEntry[] = [];

  /** Whether checkboxes are shown for selection. */
  @property({ type: Boolean }) selectable = false;

  /** Whether entries have score values (search mode). */
  private _hasScores(): boolean {
    return this.entries.some((e) => e.score !== undefined && e.score !== null);
  }

  private _getColumns(): DataTableColumn<MemoryEntry>[] {
    const cols: DataTableColumn<MemoryEntry>[] = [];

    if (this._hasScores()) {
      cols.push({
        key: "score",
        label: "Score",
        sortable: true,
        render: (value: unknown) => {
          const score = value as number | undefined;
          if (score === undefined || score === null) return "";
          return html`<span class="score-cell">${score.toFixed(3)}</span>`;
        },
      });
    }

    cols.push(
      {
        key: "content",
        label: "Content",
        sortable: false,
        render: (value: unknown) =>
          html`<span class="content-cell">${String(value ?? "")}</span>`,
      },
      {
        key: "memoryType",
        label: "Type",
        sortable: true,
        render: (value: unknown) => {
          const variant = this._typeVariant(String(value ?? ""));
          return html`<ic-tag variant=${variant}>${value}</ic-tag>`;
        },
      },
      {
        key: "trustLevel",
        label: "Trust",
        sortable: true,
        render: (value: unknown) => {
          const variant = this._trustVariant(String(value ?? ""));
          return html`<ic-tag variant=${variant}>${value}</ic-tag>`;
        },
      },
      {
        key: "agentId",
        label: "Agent",
        sortable: true,
      },
      {
        key: "createdAt",
        label: "Age",
        sortable: true,
        render: (value: unknown) => {
          const ts = value as number;
          if (!ts) return "";
          return html`<ic-relative-time .timestamp=${ts}></ic-relative-time>`;
        },
      },
    );

    return cols;
  }

  private _typeVariant(memoryType: string): string {
    const key = (memoryType ?? "").toLowerCase();
    if (key === "working" || key === "episodic") return "info";
    if (key === "semantic") return "success";
    if (key === "procedural") return "warning";
    return "default";
  }

  private _trustVariant(trustLevel: string): string {
    const key = (trustLevel ?? "").toLowerCase();
    if (key === "system") return "success";
    if (key === "learned") return "info";
    if (key === "external") return "warning";
    return "default";
  }

  private _handleRowClick(e: CustomEvent): void {
    this.dispatchEvent(
      new CustomEvent("detail-requested", {
        detail: e.detail as MemoryEntry,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleSelectionChange(e: CustomEvent<string[]>): void {
    this.dispatchEvent(
      new CustomEvent("selection-change", {
        detail: e.detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const columns = this._getColumns();

    return html`
      <ic-data-table
        .columns=${columns}
        .rows=${this.entries}
        ?selectable=${this.selectable}
        emptyMessage="No memory entries found"
        @row-click=${this._handleRowClick}
        @selection-change=${this._handleSelectionChange}
      ></ic-data-table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-memory-table": IcMemoryTable;
  }
}
