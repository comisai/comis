# generate_line_chart — Line Chart

## Overview
Shows trends over time or continuous independent variables, supports multi-series comparison, suitable for KPI monitoring, metric forecasting, and trend analysis.

## Input Fields
### Required
- `data`: array<object>, each entry contains `time` (string) and `value` (number); for multi-series, include `group` (string).

### Optional
- `style.lineWidth`: number, custom line width.
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], specifies series colors.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.
- `axisXTitle`: string, default empty string.
- `axisYTitle`: string, default empty string.

## Usage Tips
Time points across all series should be aligned; use ISO formats such as `2025-01-01` or `2025-W01`; for high-frequency data, aggregate to daily/weekly granularity first to avoid overcrowding.

## Output
- Returns a line chart URL, with `_meta.spec` attached for subsequent editing.
