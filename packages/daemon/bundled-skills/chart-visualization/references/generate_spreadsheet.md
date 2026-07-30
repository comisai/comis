# generate_spreadsheet — Spreadsheet / Pivot Table

## Overview
Generates a spreadsheet or pivot table for displaying structured tabular data. When `rows` or `values` fields are provided, it renders as a pivot table (cross-tabulation); otherwise it renders as a regular table. Suitable for displaying structured data, comparing values across categories, and creating data summaries.

## Input Fields
### Required
- `data`: array<object>, an array of table data where each object represents a row. Keys are column names, and values can be strings, numbers, null, or undefined. For example: `[{ name: 'John', age: 30 }, { name: 'Jane', age: 25 }]`.

### Optional
- `rows`: array<string>, row header fields for the pivot table. When `rows` or `values` is provided, the spreadsheet renders as a pivot table.
- `columns`: array<string>, column header fields that specify column order. For regular tables, this determines column order; for pivot tables, it is used for column grouping.
- `values`: array<string>, value fields for the pivot table. When `rows` or `values` is provided, the spreadsheet renders as a pivot table.
- `theme`: string, default `default`, options: `default`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.

## Usage Tips
- For regular tables, simply provide `data` and optionally `columns` to control column order.
- For pivot tables (cross-tabulations), provide `rows` for row grouping, `columns` for column grouping, and `values` for the fields to aggregate.
- Ensure that field names in the data match the field names specified in `rows`, `columns`, and `values`.

## Output
- Returns a spreadsheet/pivot table image URL with `_meta.spec` attached for subsequent editing.
