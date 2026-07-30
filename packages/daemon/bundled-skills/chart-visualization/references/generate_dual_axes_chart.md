# generate_dual_axes_chart — Dual Axes Chart

## Overview
Overlays columns and lines (or two curves with different units of measure) on the same canvas to display trends and comparisons simultaneously. Examples include revenue vs. profit, or temperature vs. rainfall.

## Input Fields
### Required
- `categories`: string[], provides X-axis tick labels in order (e.g., years, months, categories).
- `series`: array<object>, each item must contain at least `type` (`column`/`line`) and `data` (number[], length must match `categories`). Optional `axisYTitle` (string) describes the Y-axis meaning for that series.

### Optional
- `style.backgroundColor`: string, custom background color.
- `style.palette`: string[], configures multi-series colors.
- `style.texture`: string, defaults to `default`. Options: `default`/`rough`.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`.
- `height`: number, defaults to `400`.
- `title`: string, defaults to empty string.
- `axisXTitle`: string, defaults to empty string.

## Usage Tips
Only use dual axes when there is a genuine need to compare different units of measure or legends. Keep the number of series at 2 or fewer to avoid complexity. If the two curves differ greatly in magnitude, use the secondary axis for scaling.

## Output
- Returns a dual axes chart image URL, with detailed parameters provided in `_meta.spec`.
