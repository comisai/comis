# generate_bar_chart — Bar Chart

## Overview
Uses horizontal bars to compare metrics across different categories or groups. Suitable for Top-N rankings, regional comparisons, or channel comparisons.

## Input Fields
### Required
- `data`: array<object>, each record must contain at least `category` (string) and `value` (number). For grouping or stacking, an additional `group` (string) field is required.

### Optional
- `group`: boolean, defaults to `false`. When enabled, displays different `group` values side by side, requiring `stack=false` and data to contain the `group` field.
- `stack`: boolean, defaults to `true`. When enabled, stacks different `group` values on the same bar, requiring `group=false` and data to contain the `group` field.
- `style.backgroundColor`: string, custom background color (e.g., `#fff`).
- `style.palette`: string[], sets the series color list.
- `style.texture`: string, defaults to `default`. Options: `default`/`rough`.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`, controls chart width.
- `height`: number, defaults to `400`, controls chart height.
- `title`: string, defaults to empty string, sets the chart title.
- `axisXTitle`: string, defaults to empty string, sets the X-axis title.
- `axisYTitle`: string, defaults to empty string, sets the Y-axis title.

## Usage Tips
Keep category names short. If there are many series, consider using stacking or filtering to highlight key items to avoid a cluttered chart.

## Output
- Returns a bar chart image URL, with the full configuration provided in `_meta.spec` for reuse.
