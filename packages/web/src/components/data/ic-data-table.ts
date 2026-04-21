// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { DataTableColumn } from "../../api/types/index.js";

/**
 * Generic sortable, paginated data table with row selection,
 * column resizing, sticky headers, and row expansion.
 *
 * Uses CSS grid layout with ARIA roles for accessibility (avoids
 * Lit+happy-dom compatibility issues with native table elements).
 *
 * @fires row-click - Fires with row data when a row is clicked
 * @fires selection-change - Fires with array of selected row IDs when selection changes
 *
 * @example
 * ```html
 * <ic-data-table
 *   .columns=${columns}
 *   .rows=${rows}
 *   pageSize="25"
 *   selectable
 *   resizable
 *   expandable
 *   .expandRenderer=${(row) => html`<pre>${JSON.stringify(row, null, 2)}</pre>`}
 *   @row-click=${handler}
 * ></ic-data-table>
 * ```
 */
@customElement("ic-data-table")
export class IcDataTable extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .table-container {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        overflow: hidden;
      }

      .table-wrapper {
        overflow-x: auto;
        overflow-y: auto;
        max-height: var(--table-max-height, none);
      }

      .grid-header {
        display: flex;
        background: var(--ic-bg);
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .header-cell {
        padding: var(--ic-space-sm) var(--ic-space-md);
        text-transform: uppercase;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        letter-spacing: 0.05em;
        font-weight: 600;
        text-align: left;
        white-space: nowrap;
        user-select: none;
        flex: 1;
        min-width: 0;
        position: relative;
      }

      .header-cell.sortable {
        cursor: pointer;
      }

      .header-cell.sortable:hover {
        color: var(--ic-text);
      }

      .header-cell.sorted {
        color: var(--ic-accent);
      }

      .sort-indicator {
        display: inline-block;
        margin-left: 4px;
        font-size: 10px;
      }

      .grid-row {
        display: flex;
        border-top: 1px solid var(--ic-border);
        cursor: pointer;
        transition: background var(--ic-transition);
      }

      .grid-row:hover {
        background: var(--ic-surface-2);
      }

      .cell {
        padding: var(--ic-space-sm) var(--ic-space-md);
        color: var(--ic-text);
        font-size: var(--ic-text-sm);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .checkbox-cell {
        width: 40px;
        flex: none;
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .expand-cell {
        width: 36px;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .expand-btn {
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 4px;
        font-size: 12px;
        transition: transform 0.15s;
        line-height: 1;
      }

      .expand-btn:hover {
        color: var(--ic-text);
      }

      .expand-btn--open {
        transform: rotate(90deg);
      }

      .expanded-content {
        border-top: 1px solid var(--ic-border);
        padding: var(--ic-space-md);
        background: var(--ic-bg);
        font-size: var(--ic-text-sm);
      }

      input[type="checkbox"] {
        accent-color: var(--ic-accent);
        cursor: pointer;
      }

      /* Resize handle */
      .resize-handle {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        cursor: col-resize;
        background: transparent;
        z-index: 2;
      }

      .resize-handle:hover {
        background: var(--ic-border);
      }

      .pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-top: 1px solid var(--ic-border);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
      }

      .pagination-info {
        font-size: var(--ic-text-xs);
      }

      .pagination-controls {
        display: flex;
        gap: var(--ic-space-sm);
      }

      .page-btn {
        background: transparent;
        border: none;
        color: var(--ic-text-muted);
        cursor: pointer;
        padding: var(--ic-space-xs) var(--ic-space-sm);
        border-radius: var(--ic-radius-sm);
        font-family: inherit;
        font-size: var(--ic-text-sm);
        transition: color var(--ic-transition);
      }

      .page-btn:hover:not(:disabled) {
        color: var(--ic-text);
      }

      .page-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .empty-message {
        padding: var(--ic-space-xl);
        text-align: center;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
      }
    `,
  ];

  /** Column definitions */
  @property({ type: Array }) columns: DataTableColumn[] = [];

  /** Row data */
  @property({ type: Array }) rows: unknown[] = [];

  /** Rows per page */
  @property({ type: Number }) pageSize = 25;

  /** Show row selection checkboxes */
  @property({ type: Boolean }) selectable = false;

  /** Message displayed when no rows present */
  @property() emptyMessage = "No data";

  /** Enable column resize handles */
  @property({ type: Boolean }) resizable = false;

  /** Enable row expansion with chevron toggle */
  @property({ type: Boolean }) expandable = false;

  /** Render function for expanded row content */
  @property({ attribute: false }) expandRenderer: ((row: unknown) => unknown) | null = null;

  /** Current sort column key */
  @state() private _sortKey = "";

  /** Sort direction */
  @state() private _sortDir: "asc" | "desc" = "asc";

  /** Current page (0-indexed) */
  @state() private _page = 0;

  /** Selected row IDs (uses first column value as ID) */
  @state() private _selectedIds: Set<string> = new Set();

  /** Column widths for resize (key -> px). Stored in @state for persistence across re-renders. */
  @state() private _columnWidths: Map<string, number> = new Map();

  /** Expanded row IDs */
  @state() private _expandedIds: Set<string> = new Set();

  /** Active resize tracking */
  private _resizing: { key: string; startX: number; startWidth: number } | null = null;
  private _boundPointerMove = this._handlePointerMove.bind(this);
  private _boundPointerUp = this._handlePointerUp.bind(this);

  private _getRowId(row: unknown): string {
    if (this.columns.length === 0) return "";
    const key = this.columns[0].key;
    return String((row as Record<string, unknown>)[key] ?? "");
  }

  private _getCellValue(row: unknown, key: string): unknown {
    return (row as Record<string, unknown>)[key];
  }

  private _getSortedRows(): unknown[] {
    const rows = [...this.rows];
    if (!this._sortKey) return rows;

    return rows.sort((a, b) => {
      const aVal = this._getCellValue(a, this._sortKey);
      const bVal = this._getCellValue(b, this._sortKey);

      let cmp: number;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
      }

      return this._sortDir === "asc" ? cmp : -cmp;
    });
  }

  private _getPagedRows(): unknown[] {
    const sorted = this._getSortedRows();
    const start = this._page * this.pageSize;
    return sorted.slice(start, start + this.pageSize);
  }

  private _getTotalPages(): number {
    return Math.max(1, Math.ceil(this.rows.length / this.pageSize));
  }

  private _handleSort(column: DataTableColumn): void {
    if (!column.sortable) return;

    if (this._sortKey === column.key) {
      this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
    } else {
      this._sortKey = column.key;
      this._sortDir = "asc";
    }
  }

  private _handleRowClick(row: unknown, e: MouseEvent): void {
    // Do not fire row-click when clicking a checkbox or expand button
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "BUTTON") return;
    this.dispatchEvent(new CustomEvent("row-click", { detail: row, bubbles: true }));
  }

  private _handleRowKeydown(row: unknown, e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.dispatchEvent(new CustomEvent("row-click", { detail: row, bubbles: true }));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      const sibling = e.key === "ArrowDown"
        ? target.nextElementSibling as HTMLElement | null
        : target.previousElementSibling as HTMLElement | null;
      if (sibling?.classList.contains("grid-row")) {
        sibling.focus();
      }
    }
  }

  private _handleCheckboxChange(row: unknown, e: Event): void {
    e.stopPropagation();
    const id = this._getRowId(row);
    const next = new Set(this._selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this._selectedIds = next;
    this.dispatchEvent(
      new CustomEvent("selection-change", {
        detail: [...this._selectedIds],
        bubbles: true,
      }),
    );
  }

  private _handleSelectAll(e: Event): void {
    e.stopPropagation();
    const pagedRows = this._getPagedRows();
    const allSelected = pagedRows.every((row) => this._selectedIds.has(this._getRowId(row)));

    const next = new Set(this._selectedIds);
    if (allSelected) {
      for (const row of pagedRows) {
        next.delete(this._getRowId(row));
      }
    } else {
      for (const row of pagedRows) {
        next.add(this._getRowId(row));
      }
    }
    this._selectedIds = next;
    this.dispatchEvent(
      new CustomEvent("selection-change", {
        detail: [...this._selectedIds],
        bubbles: true,
      }),
    );
  }

  private _handlePrev(): void {
    if (this._page > 0) this._page--;
  }

  private _handleNext(): void {
    if (this._page < this._getTotalPages() - 1) this._page++;
  }

  private _sortArrowClass(col: DataTableColumn): string {
    return this._sortKey === col.key ? "sort-indicator sorted" : "sort-indicator";
  }

  private _sortArrow(col: DataTableColumn): string {
    if (this._sortKey !== col.key) return "";
    return this._sortDir === "asc" ? "\u25B2" : "\u25BC";
  }

  // ---- Column resize ----

  private _handleResizeStart(col: DataTableColumn, e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const header = (e.target as HTMLElement).parentElement!;
    const startWidth = this._columnWidths.get(col.key) ?? header.offsetWidth;
    this._resizing = { key: col.key, startX: e.clientX, startWidth };
    document.addEventListener("pointermove", this._boundPointerMove);
    document.addEventListener("pointerup", this._boundPointerUp);
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (!this._resizing) return;
    const diff = e.clientX - this._resizing.startX;
    const newWidth = Math.max(50, this._resizing.startWidth + diff);
    const next = new Map(this._columnWidths);
    next.set(this._resizing.key, newWidth);
    this._columnWidths = next;
  }

  private _handlePointerUp(): void {
    this._resizing = null;
    document.removeEventListener("pointermove", this._boundPointerMove);
    document.removeEventListener("pointerup", this._boundPointerUp);
  }

  // ---- Row expansion ----

  private _toggleExpand(row: unknown, e: Event): void {
    e.stopPropagation();
    const id = this._getRowId(row);
    const next = new Set(this._expandedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this._expandedIds = next;
  }

  private _getColumnStyle(col: DataTableColumn): string {
    const width = this._columnWidths.get(col.key);
    if (width) return `width: ${width}px; flex: none;`;
    return "";
  }

  override render() {
    if (this.rows.length === 0) {
      return html`
        <div class="table-container">
          <div class="empty-message">${this.emptyMessage}</div>
        </div>
      `;
    }

    const pagedRows = this._getPagedRows();
    const totalPages = this._getTotalPages();
    const start = this._page * this.pageSize + 1;
    const end = Math.min(start + this.pageSize - 1, this.rows.length);
    const allSelected =
      pagedRows.length > 0 &&
      pagedRows.every((row) => this._selectedIds.has(this._getRowId(row)));

    return html`
      <div class="table-container">
        <div class="table-wrapper">
          <div role="grid">
            <div class="grid-header" role="row">
              ${this.expandable
                ? html`<div class="expand-cell header-cell" role="columnheader"></div>`
                : nothing}
              ${this.selectable
                ? html`
                    <div class="checkbox-cell header-cell" role="columnheader">
                      <input
                        type="checkbox"
                        .checked=${allSelected}
                        @change=${this._handleSelectAll}
                        aria-label="Select all rows"
                      />
                    </div>
                  `
                : nothing}
              ${this.columns.map(
                (col) => html`
                  <div
                    class="header-cell ${col.sortable ? "sortable" : ""} ${this._sortKey === col.key ? "sorted" : ""}"
                    role="columnheader"
                    aria-sort=${this._sortKey === col.key ? (this._sortDir === "asc" ? "ascending" : "descending") : "none"}
                    style=${this._getColumnStyle(col)}
                    @click=${() => this._handleSort(col)}
                  >
                    ${col.label}
                    <span class=${this._sortArrowClass(col)}>${this._sortArrow(col)}</span>
                    ${this.resizable
                      ? html`<div class="resize-handle" @pointerdown=${(e: PointerEvent) => this._handleResizeStart(col, e)}></div>`
                      : nothing}
                  </div>
                `,
              )}
            </div>
            ${pagedRows.map(
              (row) => {
                const rowId = this._getRowId(row);
                const isExpanded = this._expandedIds.has(rowId);

                return html`
                  <div class="grid-row focusable" role="row" tabindex="0"
                  @click=${(e: MouseEvent) => this._handleRowClick(row, e)}
                  @keydown=${(e: KeyboardEvent) => this._handleRowKeydown(row, e)}>
                    ${this.expandable
                      ? html`
                          <div class="expand-cell cell" role="cell">
                            <button
                              class="expand-btn ${isExpanded ? "expand-btn--open" : ""}"
                              aria-expanded=${isExpanded ? "true" : "false"}
                              aria-label=${isExpanded ? "Collapse row" : "Expand row"}
                              @click=${(e: Event) => this._toggleExpand(row, e)}
                            >\u25B6</button>
                          </div>
                        `
                      : nothing}
                    ${this.selectable
                      ? html`
                          <div class="checkbox-cell cell" role="cell">
                            <input
                              type="checkbox"
                              .checked=${this._selectedIds.has(this._getRowId(row))}
                              @change=${(e: Event) => this._handleCheckboxChange(row, e)}
                              aria-label="Select row"
                            />
                          </div>
                        `
                      : nothing}
                    ${this.columns.map((col) => {
                      const value = this._getCellValue(row, col.key);
                      const rendered = col.render ? col.render(value, row) : value;
                      return html`<div class="cell" role="cell" style=${this._getColumnStyle(col)}>${rendered}</div>`;
                    })}
                  </div>
                  ${isExpanded && this.expandRenderer
                    ? html`<div class="expanded-content" role="region" aria-label="Row details">${this.expandRenderer(row)}</div>`
                    : nothing}
                `;
              },
            )}
          </div>
        </div>
        <div class="pagination">
          <span class="pagination-info">${start}-${end} of ${this.rows.length}</span>
          <div class="pagination-controls">
            <button
              class="page-btn"
              ?disabled=${this._page === 0}
              @click=${this._handlePrev}
              aria-label="Previous page"
            >
              Prev
            </button>
            <button
              class="page-btn"
              ?disabled=${this._page >= totalPages - 1}
              @click=${this._handleNext}
              aria-label="Next page"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-data-table": IcDataTable;
  }
}
