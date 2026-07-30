# generate_area_chart — Area Chart

## Overview
Displays value trends over a continuous independent variable (typically time). Supports stacking to show cumulative contributions from different groups. Suitable for KPI, energy, output, and other time-series scenarios.

## Input Fields
### Required
- `data`: Array of objects containing `time` (string) and `value` (number). When stacking, each object must also include `group` (string). At least 1 record required.

### Optional
- `stack`: boolean, defaults to `false`. Enabling stacking requires every data record to contain a `group` field.
- `style.backgroundColor`: string, sets the chart background color (e.g., `#fff`).
- `style.lineWidth`: number, customizes the line width of the area boundary.
- `style.palette`: string[], provides a color palette array for series coloring.
- `style.texture`: string, defaults to `default`. Options: `default`/`rough` to control hand-drawn texture.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`, controls chart width.
- `height`: number, defaults to `400`, controls chart height.
- `title`: string, defaults to empty string, sets the chart title.
- `axisXTitle`: string, defaults to empty string, sets the X-axis title.
- `axisYTitle`: string, defaults to empty string, sets the Y-axis title.

## Usage Tips
Ensure the `time` field uses a consistent format (e.g., `YYYY-MM`). In stacking mode, all groups must cover the same time points; fill in missing values beforehand.

## Output
- Returns an image URL, with the full area chart configuration included in `_meta.spec` for re-rendering or auditing.
