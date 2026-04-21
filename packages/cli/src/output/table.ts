// SPDX-License-Identifier: Apache-2.0
/**
 * CLI table rendering utilities using cli-table3.
 *
 * Provides renderTable for tabular data display and renderKeyValue
 * for status/info displays with label-value pairs.
 *
 * @module
 */

import Table from "cli-table3";

/**
 * Render a table with headers and rows to stdout.
 *
 * @param headers - Column header labels
 * @param rows - Array of row data (each row is an array of strings)
 */
export function renderTable(headers: string[], rows: string[][]): void {
  const table = new Table({
    head: headers,
    style: { head: ["cyan"] },
  });

  for (const row of rows) {
    table.push(row);
  }

  console.log(table.toString());
}

/**
 * Render key-value pairs as a two-column table (for status displays).
 *
 * @param pairs - Array of [label, value] tuples
 */
export function renderKeyValue(pairs: [string, string][]): void {
  const table = new Table({
    style: { head: [] },
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "  ",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: "  ",
    },
  });

  for (const [key, value] of pairs) {
    table.push({ [key]: value });
  }

  console.log(table.toString());
}
