# generate_column_chart — Column Chart

## Overview
Compares metrics across different categories or time periods using vertical columns. Supports grouping and stacking. Commonly used for sales, revenue, and traffic comparisons.

## Input Fields
### Required
- `data`: array<object>, each record must contain at least `category` (string) and `value` (number). For grouping or stacking, an additional `group` (string) field is required.

### Optional
- `group`: boolean, defaults to `true`. Displays different `group` values side by side. When enabled, requires `stack=false` and data to contain the `group` field.
- `stack`: boolean, defaults to `false`. Stacks different `group` values on the same column. When enabled, requires `group=false` and data to contain the `group` field.
- `style.backgroundColor`: string, custom background color.
- `style.palette`: string[], defines the color list.
- `style.texture`: string, defaults to `default`. Options: `default`/`rough`.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`.
- `height`: number, defaults to `400`.
- `title`: string, defaults to empty string.
- `axisXTitle`: string, defaults to empty string.
- `axisYTitle`: string, defaults to empty string.

## Usage Tips
When there are many categories (>12), consider using Top-N filtering or aggregation. In stacking mode, ensure every record contains the `group` field to avoid validation failures.

## Output
- Returns a column chart URL, with configuration details provided in `_meta.spec`.
