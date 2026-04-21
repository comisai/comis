// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcDataTable } from "./ic-data-table.js";
import type { DataTableColumn } from "../../api/types/index.js";

// Import side-effect to register custom element
import "./ic-data-table.js";

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const testColumns: DataTableColumn[] = [
  { key: "name", label: "Name", sortable: true },
  { key: "age", label: "Age", sortable: true },
  { key: "status", label: "Status" },
];

const testRows = [
  { name: "Alice", age: 30, status: "active" },
  { name: "Bob", age: 25, status: "inactive" },
  { name: "Charlie", age: 35, status: "active" },
];

describe("IcDataTable", () => {
  it("renders a grid element in shadow DOM", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const grid = el.shadowRoot?.querySelector('[role="grid"]');
    expect(grid).toBeTruthy();
  });

  it("renders correct number of header columns", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const headers = el.shadowRoot?.querySelectorAll('[role="columnheader"]');
    expect(headers?.length).toBe(3);
  });

  it("renders correct number of body rows", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(3);
  });

  it("column headers show label text", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const headers = el.shadowRoot?.querySelectorAll('[role="columnheader"]');
    const texts = Array.from(headers!).map((h) => h.textContent?.trim() ?? "");
    expect(texts[0]).toContain("Name");
    expect(texts[1]).toContain("Age");
    expect(texts[2]).toContain("Status");
  });

  it("sortable column headers have sortable class", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const headers = el.shadowRoot?.querySelectorAll('[role="columnheader"]');
    expect(headers![0].classList.contains("sortable")).toBe(true);
    expect(headers![1].classList.contains("sortable")).toBe(true);
    expect(headers![2].classList.contains("sortable")).toBe(false);
  });

  it("clicking a sortable column header sorts rows ascending", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const nameHeader = el.shadowRoot?.querySelector(".header-cell.sortable") as HTMLElement;
    nameHeader.click();
    await el.updateComplete;

    // Get first cell of each row
    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    const names = Array.from(rows!).map((r) => {
      const cells = r.querySelectorAll('[role="cell"]');
      return cells[0]?.textContent?.trim();
    });
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("clicking same column again reverses to descending", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const nameHeader = el.shadowRoot?.querySelector(".header-cell.sortable") as HTMLElement;
    nameHeader.click();
    await el.updateComplete;
    nameHeader.click();
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    const names = Array.from(rows!).map((r) => {
      const cells = r.querySelectorAll('[role="cell"]');
      return cells[0]?.textContent?.trim();
    });
    expect(names).toEqual(["Charlie", "Bob", "Alice"]);
  });

  it("sort indicator visible on sorted column", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const nameHeader = el.shadowRoot?.querySelector(".header-cell.sortable") as HTMLElement;
    nameHeader.click();
    await el.updateComplete;

    const sortedHeader = el.shadowRoot?.querySelector(".header-cell.sorted");
    expect(sortedHeader).toBeTruthy();
    const indicator = sortedHeader?.querySelector(".sort-indicator");
    expect(indicator?.textContent).toContain("\u25B2"); // up triangle
  });

  it("non-sortable column does not respond to click", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const headers = el.shadowRoot?.querySelectorAll('[role="columnheader"]');
    // Status is the 3rd header (index 2), not sortable
    const statusHeader = headers![2] as HTMLElement;
    statusHeader.click();
    await el.updateComplete;

    // No sorted class should appear
    const sorted = el.shadowRoot?.querySelector(".header-cell.sorted");
    expect(sorted).toBeNull();
  });

  it("pagination shows correct range text for 3 rows with pageSize=25", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      pageSize: 25,
    });
    const info = el.shadowRoot?.querySelector(".pagination-info");
    expect(info?.textContent?.trim()).toBe("1-3 of 3");
  });

  it("with pageSize=2: shows correct range and only 2 rows", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      pageSize: 2,
    });
    const info = el.shadowRoot?.querySelector(".pagination-info");
    expect(info?.textContent?.trim()).toBe("1-2 of 3");

    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(2);
  });

  it("Next button advances to page 2", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      pageSize: 2,
    });

    const nextBtn = el.shadowRoot?.querySelectorAll(".page-btn")[1] as HTMLButtonElement;
    nextBtn.click();
    await el.updateComplete;

    const info = el.shadowRoot?.querySelector(".pagination-info");
    expect(info?.textContent?.trim()).toBe("3-3 of 3");

    const rows = el.shadowRoot?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(1);
  });

  it("Prev button goes back to page 1", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      pageSize: 2,
    });

    // Go to page 2
    const nextBtn = el.shadowRoot?.querySelectorAll(".page-btn")[1] as HTMLButtonElement;
    nextBtn.click();
    await el.updateComplete;

    // Go back to page 1
    const prevBtn = el.shadowRoot?.querySelectorAll(".page-btn")[0] as HTMLButtonElement;
    prevBtn.click();
    await el.updateComplete;

    const info = el.shadowRoot?.querySelector(".pagination-info");
    expect(info?.textContent?.trim()).toBe("1-2 of 3");
  });

  it("Prev disabled on first page", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      pageSize: 2,
    });
    const prevBtn = el.shadowRoot?.querySelectorAll(".page-btn")[0] as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it("Next disabled on last page", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      pageSize: 25,
    });
    const nextBtn = el.shadowRoot?.querySelectorAll(".page-btn")[1] as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it("row click dispatches row-click event with row data", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const handler = vi.fn();
    el.addEventListener("row-click", handler);

    const firstRow = el.shadowRoot?.querySelector(".grid-row") as HTMLElement;
    firstRow.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.name).toBe("Alice");
    expect(detail.age).toBe(30);
  });

  it("selectable mode shows checkboxes in first column", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      selectable: true,
    });
    const checkboxes = el.shadowRoot?.querySelectorAll('input[type="checkbox"]');
    // 1 header checkbox + 3 row checkboxes
    expect(checkboxes?.length).toBe(4);
  });

  it("selectable mode adds extra header column", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      selectable: true,
    });
    const headers = el.shadowRoot?.querySelectorAll('[role="columnheader"]');
    // 3 data columns + 1 checkbox column
    expect(headers?.length).toBe(4);
  });

  it("checking a row checkbox dispatches selection-change event", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      selectable: true,
    });
    const handler = vi.fn();
    el.addEventListener("selection-change", handler);

    // First row checkbox (skip header checkbox at index 0)
    const checkboxes = el.shadowRoot?.querySelectorAll('input[type="checkbox"]');
    const rowCheckbox = checkboxes![1] as HTMLInputElement;
    rowCheckbox.click();
    await el.updateComplete;

    expect(handler).toHaveBeenCalled();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(Array.isArray(detail)).toBe(true);
    expect(detail.length).toBe(1);
  });

  it("select-all checkbox toggles all visible rows", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
      selectable: true,
    });
    const handler = vi.fn();
    el.addEventListener("selection-change", handler);

    // Header checkbox (select all) - first checkbox in the grid header
    const headerCheckbox = el.shadowRoot?.querySelector(
      '.grid-header input[type="checkbox"]',
    ) as HTMLInputElement;
    headerCheckbox.click();
    await el.updateComplete;

    expect(handler).toHaveBeenCalled();
    const lastCall = handler.mock.calls[handler.mock.calls.length - 1];
    const detail = (lastCall[0] as CustomEvent).detail;
    expect(detail.length).toBe(3);
  });

  it("empty state shows emptyMessage when rows is empty array", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: [],
      emptyMessage: "No results found",
    });
    const empty = el.shadowRoot?.querySelector(".empty-message");
    expect(empty?.textContent?.trim()).toBe("No results found");
  });

  it("has role=grid on container", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const grid = el.shadowRoot?.querySelector('[role="grid"]');
    expect(grid).toBeTruthy();
  });

  it("has role=columnheader on header cells", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const headers = el.shadowRoot?.querySelectorAll('[role="columnheader"]');
    expect(headers?.length).toBe(3);
  });

  it("sorted column has aria-sort attribute", async () => {
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: testColumns,
      rows: testRows,
    });
    const nameHeader = el.shadowRoot?.querySelector(".header-cell.sortable") as HTMLElement;
    nameHeader.click();
    await el.updateComplete;

    const sortedHeader = el.shadowRoot?.querySelector(".header-cell.sorted");
    expect(sortedHeader?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("uses custom render function when provided", async () => {
    const customColumns: DataTableColumn[] = [
      { key: "name", label: "Name", sortable: true },
      {
        key: "age",
        label: "Age",
        render: (value) => `${value} years`,
      },
    ];
    const el = await createElement<IcDataTable>("ic-data-table", {
      columns: customColumns,
      rows: [{ name: "Alice", age: 30 }],
    });
    const cells = el.shadowRoot?.querySelectorAll('.grid-row [role="cell"]');
    expect(cells![1].textContent?.trim()).toBe("30 years");
  });
});
